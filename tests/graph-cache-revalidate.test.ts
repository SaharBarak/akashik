// The graph cache must survive its TTL when the file hasn't changed.
//
// A pure 200ms TTL meant a long-lived daemon re-parsed the whole graph on
// essentially every request — 2.2s on a 358MB graph — despite being the only
// writer and having changed nothing. Revalidating against an mtime+size stamp
// keeps the parse and costs a statSync.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileGraphRepository } from '../src/infrastructure/graph-repository.ts';

const TTL_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const node = (id: string, label: string) => ({
  id,
  label,
  file_type: 'document' as const,
  source_file: id,
});

const graphJson = (label: string) =>
  JSON.stringify({ nodes: [node('a://1', label)], links: [] });

describe('graph repository — cache revalidation', () => {
  it('reuses the parsed graph past the TTL when the file is unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wi-graphcache-'));
    const path = join(dir, 'graph.json');
    await writeFile(path, graphJson('original'));

    try {
      const repo = fileGraphRepository(path);
      const first = (await repo.load())._unsafeUnwrap();
      await sleep(TTL_MS + 120); // let the TTL lapse
      const second = (await repo.load())._unsafeUnwrap();

      // Identity, not just equality: a re-parse would produce a new object.
      assert.equal(second, first, 'an unchanged file must not be re-parsed after the TTL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('re-reads when the file actually changes', async () => {
    // The revalidation must not become a stale-read bug: an external writer
    // (another process, a manual edit) has to be picked up.
    const dir = await mkdtemp(join(tmpdir(), 'wi-graphcache2-'));
    const path = join(dir, 'graph.json');
    await writeFile(path, graphJson('original'));

    try {
      const repo = fileGraphRepository(path);
      const first = (await repo.load())._unsafeUnwrap();
      assert.equal(first.nodeById.get('a://1')?.label, 'original');

      await sleep(TTL_MS + 120);
      // Different length as well as different mtime, so the stamp differs
      // even on a filesystem with coarse timestamps.
      await writeFile(path, graphJson('changed-externally'));

      const second = (await repo.load())._unsafeUnwrap();
      assert.equal(
        second.nodeById.get('a://1')?.label,
        'changed-externally',
        'a changed file must invalidate the cache',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a save is still visible immediately to the next load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wi-graphcache3-'));
    const path = join(dir, 'graph.json');
    await writeFile(path, graphJson('original'));

    try {
      const repo = fileGraphRepository(path);
      const g = (await repo.load())._unsafeUnwrap();
      const mutated = {
        ...g,
        nodeById: new Map(g.nodeById).set('a://2', node('a://2', 'added')),
        json: { nodes: [...g.json.nodes, node('a://2', 'added')], links: [] },
      } as typeof g;

      assert.ok((await repo.save(mutated)).isOk());
      await sleep(TTL_MS + 120);

      const reloaded = (await repo.load())._unsafeUnwrap();
      assert.ok(reloaded.nodeById.has('a://2'), 'write-through cache must reflect the save');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
