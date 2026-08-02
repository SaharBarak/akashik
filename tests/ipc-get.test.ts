// `get` over IPC — retrieval-by-id, the second half of the search contract.
//
// Context: `ask` has always returned snippets + node ids over IPC, but nothing
// turned an id back into the document, so every non-MCP consumer (hooks, the
// OpenClaw memory corpus) could search and never read. The handler runs
// against a stub Runtime so the assertions cover the wire contract — exit
// codes especially — without booting an embedder.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ok, err } from 'neverthrow';
import { buildIpcHandlers } from '../src/daemon/ipc-handlers.ts';
import type { Runtime } from '../src/cli/runtime.ts';

const NODE = {
  id: 'concept://2026-08-01/touch-primitive',
  label: 'Touch primitive',
  type: 'concept',
  text: 'the body of the note',
};

/** Minimal Runtime: `get` only ever touches runtime.graphs.load(). */
const stubRuntime = (graph: unknown): Runtime =>
  ({
    graphs: { load: async () => graph },
  }) as unknown as Runtime;

/** A loaded Graph is an indexed view, not raw JSON — getNode reads nodeById. */
const graphWith = (nodes: { id: string }[]) =>
  ok({
    json: { nodes, links: [] },
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    adjacency: new Map(),
  } as never);

const getHandler = () => {
  const h = buildIpcHandlers().get('get');
  assert.ok(h, 'get must be registered in the IPC handler map');
  return h;
};

describe('ipc — get handler', () => {
  it('is registered, so a daemon can serve retrieval-by-id', () => {
    assert.ok(buildIpcHandlers().has('get'));
  });

  it('returns the full node as JSON on a hit', async () => {
    const res = await getHandler()([NODE.id], stubRuntime(graphWith([NODE])));
    assert.equal(res.exit, 0);
    assert.deepEqual(JSON.parse(res.stdout), NODE);
  });

  it('exits 2 (not 1) for a missing node', async () => {
    // The distinction matters to callers: exit 1 means the graph is
    // unreadable and retrying is sensible; exit 2 means the id does not
    // exist and retrying never will.
    const res = await getHandler()(['nope://missing'], stubRuntime(graphWith([NODE])));
    assert.equal(res.exit, 2);
    assert.deepEqual(JSON.parse(res.stdout), { error: 'NodeNotFound', node_id: 'nope://missing' });
  });

  it('exits 1 when the graph cannot be read', async () => {
    const res = await getHandler()(
      [NODE.id],
      stubRuntime(err({ type: 'GraphParseError', detail: 'boom' } as never)),
    );
    assert.equal(res.exit, 1);
    assert.match(res.stderr ?? '', /get:/);
  });

  it('ignores flags when locating the id argument', async () => {
    // The CLI accepts `get <id> --json`; the daemon must not mistake the flag
    // for the node id.
    const res = await getHandler()(['--json', NODE.id], stubRuntime(graphWith([NODE])));
    assert.equal(res.exit, 0);
    assert.equal(JSON.parse(res.stdout).id, NODE.id);
  });

  it('errors rather than guessing when no id is supplied', async () => {
    const res = await getHandler()(['--json'], stubRuntime(graphWith([NODE])));
    assert.equal(res.exit, 1);
    assert.match(res.stderr ?? '', /missing node id/);
  });
});
