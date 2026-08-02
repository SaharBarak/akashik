// Corpus supplement against a stub daemon speaking the real IPC wire format.
// The property that matters most is the degraded path: OpenClaw calls this on
// every memory search, so a missing or slow daemon must produce empty results,
// never a thrown error inside the agent's turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folkloreCorpus, mapSearchHit } from '../src/corpus.js';

/** Stand up a stub daemon socket at $HOME/daemon.sock for a scratch home. */
const startDaemon = (
  handler: (cmd: string, args: string[]) => { ok: boolean; stdout: string; exit?: number },
): Promise<{ server: Server; home: string; cleanup: () => void }> =>
  new Promise((resolve) => {
    const home = mkdtempSync(join(tmpdir(), 'fk-oc-'));
    const server = createServer((socket) => {
      const rl = createInterface({ input: socket });
      rl.on('line', (line) => {
        const req = JSON.parse(line) as { id: number; cmd: string; args: string[] };
        const res = handler(req.cmd, req.args);
        socket.write(JSON.stringify({ id: req.id, exit: res.exit ?? 0, ...res }) + '\n');
      });
    });
    server.listen(join(home, 'daemon.sock'), () => {
      resolve({
        server,
        home,
        cleanup: () => {
          server.close();
          rmSync(home, { recursive: true, force: true });
        },
      });
    });
  });

const withHome = <T>(home: string, fn: () => Promise<T>): Promise<T> => {
  const prev = process.env.FOLKLORE_HOME;
  process.env.FOLKLORE_HOME = home;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.FOLKLORE_HOME;
    else process.env.FOLKLORE_HOME = prev;
  });
};

test('search maps folklore hits into corpus results', async () => {
  const d = await startDaemon((cmd) => {
    assert.equal(cmd, 'ask');
    return {
      ok: true,
      stdout: JSON.stringify({
        satisfaction: 0.91,
        hits: [
          {
            id: 'https://example.com/doc',
            label: 'A document',
            type: 'source',
            score: 0.88,
            snippet: 'the relevant passage',
            source_uri: 'https://example.com/doc',
            fetched_at: '2026-07-30T10:00:00.000Z',
            age_days: 2,
            peer: '12D3KooWAbc',
          },
        ],
      }),
    };
  });

  try {
    const results = await withHome(d.home, () => folkloreCorpus().search({ query: 'anything' }));
    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.corpus, 'folklore');
    assert.equal(r.path, 'https://example.com/doc', 'path must be the node id so get() round-trips');
    assert.equal(r.title, 'A document');
    assert.equal(r.score, 0.88);
    assert.equal(r.snippet, 'the relevant passage');
    assert.equal(r.sourceType, 'folklore-peer');
    assert.match(r.provenanceLabel, /peer 12D3KooWAbc/);
    assert.match(r.provenanceLabel, /2d old/, 'age must be visible — it decides trust vs re-fetch');
  } finally {
    d.cleanup();
  }
});

test('a distance-only hit still ranks (higher score = better)', () => {
  const near = mapSearchHit({ id: 'a', distance: 0.1 });
  const far = mapSearchHit({ id: 'b', distance: 2.0 });
  assert.ok(near.score > far.score, 'distance must invert into a score');
  assert.equal(mapSearchHit({ id: 'c' }).score, 0, 'no signal ranks last, not first');
});

test('get returns the node body and slices by line', async () => {
  const d = await startDaemon((cmd, args) => {
    assert.equal(cmd, 'get');
    assert.equal(args[0], 'concept://2026-08-01/thing');
    return {
      ok: true,
      stdout: JSON.stringify({
        id: 'concept://2026-08-01/thing',
        label: 'Thing',
        type: 'concept',
        text: 'line one\nline two\nline three',
        fetched_at: '2026-08-01T00:00:00.000Z',
      }),
    };
  });

  try {
    const full = await withHome(d.home, () =>
      folkloreCorpus().get({ lookup: 'concept://2026-08-01/thing' }),
    );
    assert.ok(full);
    assert.equal(full.content, 'line one\nline two\nline three');
    assert.equal(full.lineCount, 3);
    assert.equal(full.sourceType, 'folklore-local');

    const sliced = await withHome(d.home, () =>
      folkloreCorpus().get({ lookup: 'concept://2026-08-01/thing', fromLine: 1, lineCount: 1 }),
    );
    assert.equal(sliced?.content, 'line two');
    assert.equal(sliced?.fromLine, 1);
  } finally {
    d.cleanup();
  }
});

test('no daemon degrades to empty, never throws', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'fk-oc-nodaemon-'));
  try {
    const results = await withHome(empty, () => folkloreCorpus().search({ query: 'x' }));
    assert.deepEqual(results, []);
    const node = await withHome(empty, () => folkloreCorpus().get({ lookup: 'x' }));
    assert.equal(node, null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('a daemon returning junk degrades to empty', async () => {
  const d = await startDaemon(() => ({ ok: true, stdout: 'not json at all' }));
  try {
    const results = await withHome(d.home, () => folkloreCorpus().search({ query: 'x' }));
    assert.deepEqual(results, []);
  } finally {
    d.cleanup();
  }
});

test('a failed command degrades to empty', async () => {
  const d = await startDaemon(() => ({ ok: false, stdout: '', exit: 1 }));
  try {
    assert.deepEqual(await withHome(d.home, () => folkloreCorpus().search({ query: 'x' })), []);
    assert.equal(await withHome(d.home, () => folkloreCorpus().get({ lookup: 'x' })), null);
  } finally {
    d.cleanup();
  }
});

test('an empty query never hits the daemon', async () => {
  let called = false;
  const d = await startDaemon(() => {
    called = true;
    return { ok: true, stdout: '{"hits":[]}' };
  });
  try {
    assert.deepEqual(await withHome(d.home, () => folkloreCorpus().search({ query: '   ' })), []);
    assert.equal(called, false);
  } finally {
    d.cleanup();
  }
});

test('maxResults is clamped — a caller cannot ask for the whole graph', async () => {
  let seenK = '';
  const d = await startDaemon((_cmd, args) => {
    seenK = args[args.indexOf('--k') + 1] ?? '';
    return { ok: true, stdout: '{"hits":[]}' };
  });
  try {
    await withHome(d.home, () => folkloreCorpus().search({ query: 'x', maxResults: 5000 }));
    assert.equal(seenK, '25');
  } finally {
    d.cleanup();
  }
});
