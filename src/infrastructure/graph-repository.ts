/**
 * GraphRepository — port + JSON file adapter for persisting a Graph.
 *
 * The port is an interface the application layer depends on. The
 * adapter `fileGraphRepository` is the concrete implementation that
 * reads and writes `graph.json` in the NetworkX node-link format
 * graphify understands.
 *
 * Writes are atomic: we write to `<path>.tmp` and rename into place,
 * so a crashed process never leaves a half-written graph.
 *
 * Errors flow through neverthrow's ResultAsync so the application
 * layer can compose I/O and domain failures in a single chain.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ResultAsync, errAsync, okAsync } from 'neverthrow';
import { GraphError } from '../domain/errors.js';
import { empty, fromJson, size, toJson, type Graph } from '../domain/graph.js';

/** Port — anything that knows how to load and save a Graph. */
export interface GraphRepository {
  /** Load the graph from the underlying store. Returns an empty graph if none exists. */
  load(): ResultAsync<Graph, GraphError>;
  /** Persist a graph to the underlying store. */
  save(graph: Graph): ResultAsync<void, GraphError>;
}

/**
 * File-backed implementation with a short-lived in-memory cache.
 *
 * graph.json on a real install is 10-50 MB; JSON.parse of that on
 * every load() costs 50-300 ms, and under burst ingest (boot
 * reconciliation enqueues hundreds of `ingest:file` jobs that each
 * call load() to dedupe by content_sha256) those parses dominate.
 *
 * Cache invariants:
 *   - Hits within CACHE_TTL_MS return the in-memory Graph directly
 *     (no I/O, no parse).
 *   - Every save() writes through and overwrites the cache, so a
 *     subsequent load() sees the just-written state immediately.
 *   - On any read or parse error, the cache is cleared and the
 *     next load re-reads from disk.
 *
 * The TTL is short (200ms) on purpose: any caller that mutates the
 * graph through save() invalidates immediately; the TTL only
 * affects READ-ONLY callers that happen to call load() multiple
 * times in quick succession (the dedupe path, search ranking, etc.).
 *
 * In-process only — the cross-process write lock guarantees no
 * other process is mutating the file while ours holds the lock,
 * so a stale cache is impossible during a held lock.
 */
const CACHE_TTL_MS = 200;

import { metrics } from '../domain/metrics.js';

export const fileGraphRepository = (path: string): GraphRepository => {
  let cache: { graph: Graph; ts: number } | null = null;

  const load = (): ResultAsync<Graph, GraphError> => {
    const now = Date.now();
    if (cache && now - cache.ts < CACHE_TTL_MS) {
      metrics.counter('graph.load.cache_hit').inc();
      return okAsync(cache.graph);
    }
    metrics.counter('graph.load.cache_miss').inc();
    const t0 = performance.now();
    if (!existsSync(path)) {
      const g = empty();
      cache = { graph: g, ts: now };
      metrics.histogram('graph.load.ms').observe(performance.now() - t0);
      return okAsync(g);
    }
    return ResultAsync.fromPromise(readFile(path, 'utf8'), (e) => {
      cache = null;
      metrics.counter('graph.load.errors').inc();
      return GraphError.readError(path, (e as Error).message);
    }).andThen((text) => {
      try {
        const parsed = JSON.parse(text);
        return fromJson(parsed, path).map((g) => {
          cache = { graph: g, ts: Date.now() };
          metrics.histogram('graph.load.ms').observe(performance.now() - t0);
          return g;
        });
      } catch (e) {
        cache = null;
        metrics.counter('graph.load.errors').inc();
        return errAsync(GraphError.parseError(path, (e as Error).message));
      }
    });
  };

  const save = (graph: Graph): ResultAsync<void, GraphError> => {
    const t0 = performance.now();
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(toJson(graph), null, 2));
      renameSync(tmp, path);
      // Sidecar counts (graph-meta.json) so UI surfaces can show graph
      // size without parsing a hundreds-of-MB graph.json. Best-effort:
      // a failed meta write must not fail the save that just landed.
      try {
        const metaPath = path.replace(/\.json$/, '-meta.json');
        const metaTmp = `${metaPath}.tmp`;
        writeFileSync(
          metaTmp,
          JSON.stringify({ ...size(graph), updated_at: new Date().toISOString() }),
        );
        renameSync(metaTmp, metaPath);
      } catch {
        /* meta is observability only */
      }
      // Write-through: the just-saved graph IS the freshest state.
      // Subsequent load() returns it without re-reading + re-parsing
      // the file we just wrote.
      cache = { graph, ts: Date.now() };
      metrics.histogram('graph.save.ms').observe(performance.now() - t0);
      metrics.counter('graph.save.ok').inc();
      return okAsync(undefined);
    } catch (e) {
      cache = null;
      metrics.counter('graph.save.errors').inc();
      return errAsync(GraphError.writeError(path, (e as Error).message));
    }
  };

  return { load, save };
};
