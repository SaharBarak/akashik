// One source run must cost ONE graph save, not one per item.
//
// `graph.save()` serialises and writes the entire graph, so its cost scales
// with the graph rather than the item: measured 900 ms on a 358 MB graph
// (355 ms JSON.stringify + 545 ms write), all of it synchronous. Saving per
// item meant a 15-item source blocked the event loop ~13 s and a 40-item
// source ~36 s, during which the daemon served no IPC at all — it looked hung
// while doing exactly what it was told.
//
// This pins the invariant that made that go away.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { okAsync, ResultAsync } from 'neverthrow';
import { ingestSource, type IngestDeps } from '../src/application/ingest.ts';
import { fromJson, type Graph } from '../src/domain/graph.ts';
import type { Source, SourceDescriptor } from '../src/domain/sources.ts';

const descriptor: SourceDescriptor = {
  id: 'test-source',
  kind: 'generic_rss',
  enabled: true,
  config: {},
};

const emptyGraph = (): Graph => fromJson({ nodes: [], links: [] })._unsafeUnwrap();

/** Counts saves; everything else is the minimum to let ingest run. */
const makeDeps = (): { deps: IngestDeps; saves: () => number } => {
  let graph = emptyGraph();
  let saveCount = 0;

  const deps = {
    graphs: {
      load: () => okAsync(graph),
      save: (g: Graph) => {
        saveCount += 1;
        graph = g;
        return okAsync(undefined);
      },
    },
    vectors: {
      upsert: () => okAsync(undefined),
      remove: () => okAsync(undefined),
      search: () => okAsync([]),
      size: () => 0,
    },
    embedder: {
      dim: 3,
      embed: () => okAsync(new Float32Array([0, 0, 1])),
      embedBatch: (texts: readonly string[]) =>
        okAsync(texts.map(() => new Float32Array([0, 0, 1]))),
    },
    sources: { list: () => okAsync([]) },
    registry: { buildAll: () => ({ sources: [], errors: [] }) },
  } as unknown as IngestDeps;

  return { deps, saves: () => saveCount };
};

const sourceOf = (n: number): Source =>
  ({
    descriptor,
    fetch: () =>
      okAsync(
        Array.from({ length: n }, (_, i) => ({
          source_uri: `https://example.com/item-${i}`,
          title: `Item ${i}`,
          text: `body of item ${i}`,
          published_at: '2026-08-02T00:00:00.000Z',
        })),
      ) as ResultAsync<never, never>,
  }) as unknown as Source;

describe('ingest — save batching', () => {
  it('saves once for a many-item source, not once per item', async () => {
    const { deps, saves } = makeDeps();
    const res = await ingestSource(deps)(sourceOf(12));

    assert.ok(res.isOk(), `ingest failed: ${res.isErr() ? JSON.stringify(res.error) : ''}`);
    assert.equal(res._unsafeUnwrap().items_new, 12, 'all items should be ingested');
    assert.equal(
      saves(),
      1,
      `expected exactly 1 graph save for the batch, got ${saves()} — ` +
        'a save per item blocks the event loop for ~900ms each on a large graph',
    );
  });

  it('save count does not grow with item count', async () => {
    // The regression is specifically O(items) saves. Compare two sizes: if the
    // count tracks the item count, the old behaviour is back.
    const small = makeDeps();
    await ingestSource(small.deps)(sourceOf(3));
    const large = makeDeps();
    await ingestSource(large.deps)(sourceOf(30));

    assert.equal(
      small.saves(),
      large.saves(),
      `3 items caused ${small.saves()} saves and 30 items caused ${large.saves()} — ` +
        'save cost must be independent of batch size',
    );
  });

  it('an empty source does not touch the graph at all', async () => {
    const { deps, saves } = makeDeps();
    const res = await ingestSource(deps)(sourceOf(0));
    assert.ok(res.isOk());
    assert.equal(saves(), 0, 'nothing fetched, nothing written');
  });
});
