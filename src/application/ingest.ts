/**
 * Ingest use cases — orchestrate Source.fetch → chunk → indexNode.
 *
 * Two entrypoints:
 *
 *   ingestSource(deps)(source)
 *     — runs one source end to end, returns a SourceRun report
 *
 *   triggerAllSources(deps)()
 *     — loads sources.json, hydrates every enabled source via the
 *       registry, runs ingestSource for each, returns an IngestTickRun
 *
 * Dedup strategy
 * --------------
 * Each source_uri maps to at most one graph node. On re-run we:
 *
 *   1. load the current graph
 *   2. compute sha256(normalized text) of every fetched ContentItem
 *   3. compare against `content_sha256` stored on the existing node
 *      (a new folklore extra field — not in graphify's patch but
 *      graphify's validator passes extras through unchanged)
 *   4. equal → skipped, different → updated, not-seen → new
 *   5. only new + updated items chunk/embed/upsert
 *
 * Chunking
 * --------
 * Each item's text is split into chunks (paragraph-aware, 1200
 * chars default). Each chunk becomes a node with id
 * `<source_uri>#chunk-<index>`, so a single long article produces
 * multiple siblings that all share the same source_uri parent. Phase
 * 3 can introduce a parent "article" node + EXTRACTED edges.
 */

import { Result, ResultAsync, errAsync, okAsync } from 'neverthrow';
import type { AppError } from '../domain/errors.js';
import type { ContentItem } from '../domain/content.js';
import type { Source, SourceDescriptor, SourceRun, IngestTickRun } from '../domain/sources.js';
import { emptyRun, isEnabled } from '../domain/sources.js';
import type { GraphRepository } from '../infrastructure/graph-repository.js';
import type { VectorIndex } from '../infrastructure/vector-index.js';
import type { Embedder } from '../infrastructure/embedders.js';
import type { SourcesConfig } from '../infrastructure/sources-config.js';
import type { SourceRegistry } from '../infrastructure/sources/registry.js';
import type { AsyncMutex } from '../infrastructure/async-mutex.js';
// Chunk/embed/upsert lives in batch-ingest.ts — this module fetches and
// delegates. indexNode stays exported from use-cases.ts for single-node callers.

// ─────────────────────── deps ─────────────────────────────

/**
 * Mentions extractor port — supplied by the daemon runtime to wire
 * the entity layer into the ingest pipeline. The domain layer
 * (entity-extract.ts) doesn't know about persistent registries; the
 * concrete adapter (in src/infrastructure or wired in cli/runtime)
 * binds the registry-backed extract + touchMany functions to this
 * port.
 *
 * Standalone-CLI paths (no daemon, no entity layer) leave this
 * undefined — ingest still works, just without entity extraction.
 */
export interface MentionsExtractorPort {
  /** Extract entity mentions from one chunk's text. Pure. */
  readonly extract: (text: string) => readonly {
    readonly entity_id: string;
    readonly surface: string;
    readonly start: number;
    readonly end: number;
  }[];
  /**
   * Bulk-touch — ONE persisted update for the whole batch's
   * mentions. The map carries true mention counts (entity_id →
   * times-mentioned-in-batch); the registry adds those increments
   * exactly. Previously this took a `string[]` which the registry
   * collapsed into a Set, undercounting repeated mentions
   * (gemini synthesis HIGH on entity-registry.ts:153).
   */
  readonly touchMany: (counts: ReadonlyMap<string, number>) => void;
}

export interface IngestDeps {
  readonly graphs: GraphRepository;
  readonly vectors: VectorIndex;
  readonly embedder: Embedder;
  readonly sources: SourcesConfig;
  readonly registry: SourceRegistry;
  /**
   * Optional in-process graph-mutex. When supplied (daemon path),
   * the load→upsert-all→save block inside indexChunksFor takes the
   * lock so the tick loop and the job worker can't lose updates.
   * Undefined paths (CLI standalone) rely on the cross-process file
   * lock alone — single mutator at a time.
   *
   * Crucially this is at the inner block level, NOT at the job
   * dispatch level — skipped items and embedding work happen
   * outside the lock so the mutex window stays tiny.
   */
  readonly graphMutex?: AsyncMutex;
  /**
   * Optional entity extractor + registry touchMany. When supplied,
   * the batch ingest pipeline runs extraction over each chunk's
   * text and adds `mentions` edges to detected entities. When
   * undefined, the pipeline skips the entity layer entirely.
   */
  readonly mentionsExtractor?: MentionsExtractorPort;
}

// ─────────────────────── ingestSource ─────────────────────

/**
 * Run a single source end to end. Returns a SourceRun report with
 * counts. Errors on the source itself become SourceRun.error; errors
 * on individual items are counted as `items_skipped` with the first
 * error retained for the report.
 */
export const ingestSource =
  (deps: IngestDeps) =>
  (source: Source): ResultAsync<SourceRun, AppError> =>
    source.fetch().andThen((items) => processItems(deps, source.descriptor, items));

// ─────────────────────── triggerAllSources ─────────────────

/**
 * V5 (Phase 24): load every enabled source and run it. Returns an
 * IngestTickRun aggregate consumed by the daemon's tick reporting.
 *
 * Per-source errors are captured on SourceRun.error so the CLI can
 * report them without aborting the whole batch.
 */
export const triggerAllSources =
  (deps: IngestDeps) =>
  (): ResultAsync<IngestTickRun, AppError> => {
    const started_at = new Date().toISOString();
    return deps.sources
      .list()
      .mapErr((e): AppError => e)
      .andThen((all) => {
        const descriptors = all.filter(isEnabled);
        const { sources: live, errors } = deps.registry.buildAll(descriptors);

        const hydrationRuns: SourceRun[] = errors.map((e) => ({
          source_id: '<unknown>',
          kind: 'generic_rss',
          items_seen: 0,
          items_new: 0,
          items_updated: 0,
          items_skipped: 0,
          error: e,
        }));

        return sequenceLazy(
          live.map((s) => () =>
            ingestSource(deps)(s).orElse((e) =>
              okAsync<SourceRun, AppError>({
                ...emptyRun(s.descriptor),
                error: e,
              }),
            ),
          ),
        ).map((runs): IngestTickRun => ({
          runs: [...hydrationRuns, ...runs],
          started_at,
          finished_at: new Date().toISOString(),
        }));
      });
  };

/**
 * @deprecated V5 — preserved alias of `triggerAllSources`. The `_room`
 * argument is ignored. Will be removed in a follow-up wave.
 */
export const triggerRoom =
  (deps: IngestDeps) =>
  (_room: string): ResultAsync<IngestTickRun, AppError> =>
    triggerAllSources(deps)();

// ─────────────────────── internals ────────────────────────

/**
 * Hand a source's whole fetched batch to `ingestBatch` in ONE call.
 *
 * This used to walk the items one at a time, and because the per-item path
 * delegates to `ingestBatch` with a single-element array, each item paid a
 * full `graph.save()` — a synchronous `JSON.stringify` plus write of the
 * ENTIRE graph. That cost scales with the graph, not the item: measured at
 * 900 ms per save on a 358 MB graph (355 ms stringify + 545 ms write), so a
 * 15-item source blocked the event loop for ~13 s and a 40-item source for
 * ~36 s. During those windows the daemon answered no IPC at all — it looked
 * hung while doing exactly what it was told.
 *
 * `ingestBatch` already hashes, dedupes against existing content hashes,
 * classifies new/updated/skipped and saves exactly once for the batch, so
 * passing the whole list is both faster and less code: the per-item classify
 * here was a second implementation of the dedupe that batch already does.
 *
 * N saves become 1 per source.
 */
const processItems = (
  deps: IngestDeps,
  descriptor: SourceDescriptor,
  items: readonly ContentItem[],
): ResultAsync<SourceRun, AppError> => {
  if (items.length === 0) {
    return okAsync({
      ...emptyRun(descriptor),
      items_seen: 0,
    });
  }

  // Lazy import keeps ingest.ts ↔ batch-ingest.ts non-circular (the same
  // reason the old single-item wrapper imported it this way).
  return ResultAsync.fromPromise(
    import('./batch-ingest.js').then(async ({ ingestBatch }) => {
      const r = await ingestBatch(deps)({ descriptor, items });
      if (r.isErr()) throw r.error;
      return r.value;
    }),
    (e): AppError =>
      e && typeof e === 'object' && 'type' in (e as object)
        ? (e as AppError)
        : { type: 'GraphWriteError', path: '<batch>', message: String(e) },
  );
};

/**
 * Sequential lazy helper — takes an array of **thunks** (() =>
 * ResultAsync) and executes them one-by-one, short-circuiting on
 * the first error.
 *
 * The lazy shape is critical: wrapping each step in a function
 * means the ResultAsync (and therefore its underlying Promise) is
 * not constructed until the previous step resolves. Using an eager
 * `xs.reduce((acc, current) => ...)` instead would start every
 * Promise in `xs` in parallel because `.map()` on `items` already
 * materialises them — which is the bug that ingest.ts originally
 * had (every indexNode call raced on graph.json and the last
 * writer won, giving us 1 node instead of N).
 */
const sequenceLazy = <T, E>(
  thunks: readonly (() => ResultAsync<T, E>)[],
): ResultAsync<readonly T[], E> =>
  thunks.reduce<ResultAsync<T[], E>>(
    (acc, thunk) => acc.andThen((prev) => thunk().map((value) => [...prev, value])),
    okAsync<T[], E>([]),
  );

// keep imports honest when strict linting is enabled
void Result;
void errAsync;
