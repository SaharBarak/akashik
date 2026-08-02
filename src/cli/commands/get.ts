/**
 * `folklore get <node-id> [--json]`
 *
 * Fetch one node by its exact id. The MCP surface has had `get_node` since
 * phase 17, but nothing equivalent existed on the CLI — so every non-MCP
 * consumer (hooks, the OpenClaw corpus supplement, shell one-liners) could
 * search the graph but never read a hit back in full.
 *
 * Retrieval-by-id is the second half of a search contract: `ask` returns
 * snippets and ids, and something has to turn an id into the document.
 */

import { join } from 'node:path';
import { runtimePaths } from '../runtime.js';
import { fileGraphRepository } from '../../infrastructure/graph-repository.js';
import { getNode } from '../../domain/graph.js';
import { formatError } from '../../domain/errors.js';

export const get = async (rest: readonly string[]): Promise<number> => {
  const args = rest.filter((a) => a !== '--json');
  const json = rest.includes('--json');
  const nodeId = args[0];

  if (!nodeId || nodeId.startsWith('--')) {
    console.error('usage: folklore get <node-id> [--json]');
    return 1;
  }

  const paths = runtimePaths();
  const graphs = fileGraphRepository(join(paths.home, 'graph.json'));
  const graph = await graphs.load();
  if (graph.isErr()) {
    console.error(`get: ${formatError(graph.error)}`);
    return 1;
  }

  const node = getNode(graph.value, nodeId);
  if (!node) {
    // Exit 2 (not 1) so a caller can tell "no such node" from "graph broken".
    if (json) console.log(JSON.stringify({ error: 'NodeNotFound', node_id: nodeId }));
    else console.error(`get: no node with id ${nodeId}`);
    return 2;
  }

  if (json) {
    console.log(JSON.stringify(node));
    return 0;
  }

  console.log(`${node.label ?? node.id}`);
  console.log(`  id      ${node.id}`);
  if (node.type) console.log(`  type    ${node.type}`);
  if (node.source_uri) console.log(`  source  ${node.source_uri}`);
  if (node.fetched_at) console.log(`  fetched ${node.fetched_at}`);
  if (node.private) console.log('  private true (never federated)');
  if (node.workspace) console.log(`  workspace ${node.workspace}`);
  const body = node.text ?? node.summary;
  if (body) {
    console.log('');
    console.log(body);
  }
  return 0;
};
