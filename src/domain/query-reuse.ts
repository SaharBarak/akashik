/**
 * query-reuse — P2P inference-tree sharing at retrieval time.
 *
 * A peer that resolves a query records a "resolved-query" node: the question
 * text (embedded, so it's searchable) linked to the verified answer-doc node
 * ids. These nodes live in the same graph + vector store. When an explicitly
 * distilled trace is attached, its public pointer is CRDT-eligible; federated
 * search discovers it and targeted fetch carries the self-contained body. Raw
 * questions without a trace stay private. A later (possibly paraphrased) query
 * retrieves prior work by query↔query similarity — which is far stronger than
 * query↔doc for the same need (measured ≈0.71–0.84 vs ~0.35–0.47 recall@1).
 *
 * `expandResolvedQueries` is the read-time hook: when a search match lands on a
 * resolved-query node ("someone already answered this"), it is replaced by its
 * verified answer docs, carrying the q2q distance. The answered-question pool
 * thus acts as a high-precision retrieval index over the network's prior work.
 *
 * Pure + deterministic. Gated in the ask path by FOLKLORE_QUERY_REUSE so the
 * default behaviour is unchanged until a peer opts in.
 *
 * Evidence: docs/research/inference-tree-sharing.md (federation beats a proper
 * single-node semantic cache by +20–26% recall@1 at matched ≤2% false-accept).
 */

import { createHash } from 'node:crypto';
import type { Graph, GraphNode, NodeId } from './graph.js';
import { getNode } from './graph.js';
import type { Match } from './vectors.js';

/** Marker `kind` on a resolved-query node (an extra field on GraphNode). */
export const RESOLVED_QUERY_KIND = 'resolved_query';
/** Bounded by the fetch/import wire contract. */
export const RESOLVED_TRACE_MAX_CHARS = 4000;

/** Deterministic id for a query's resolved-query node (normalized text). */
export const resolvedQueryId = (query: string): NodeId =>
  `resolved-query://${createHash('sha256').update(query.trim().toLowerCase()).digest('hex').slice(0, 16)}`;

export const isResolvedQuery = (n: GraphNode | undefined): boolean =>
  !!n && (n as { kind?: unknown }).kind === RESOLVED_QUERY_KIND;

/** Verified answer-doc node ids carried by a resolved-query node. */
export const answerDocsOf = (n: GraphNode): readonly NodeId[] => {
  const a = (n as { answer_docs?: unknown }).answer_docs;
  return Array.isArray(a) ? (a.filter((x) => typeof x === 'string') as NodeId[]) : [];
};

export interface ResolvedQueryTrace {
  /** Model-agnostic, provider-output-free reasoning that another peer can reuse. */
  readonly summary: string;
  /** Resolution time supplied by the application boundary. */
  readonly resolvedAt: string;
}

/**
 * Build a resolved-query node: the question, linked to its verified docs and,
 * when supplied, carrying a self-contained distilled trace.
 *
 * `fetched_at` is explicit because the import boundary requires it. Public
 * federation is opt-in at the distilled-trace boundary: a trace-bearing node
 * is public, while a raw question-only reuse pointer stays private.
 */
export const makeResolvedQueryNode = (
  query: string,
  answerDocs: readonly NodeId[],
  trace?: ResolvedQueryTrace,
): GraphNode => {
  const id = resolvedQueryId(query);
  return ({
    id,
    label: query.trim(),
    file_type: 'rationale',
    source_file: id,
    kind: RESOLVED_QUERY_KIND,
    answer_docs: [...answerDocs],
    source_uri: id,
    private: trace?.summary ? false : true,
    ...(trace?.summary
      ? {
          summary: trace.summary.slice(0, RESOLVED_TRACE_MAX_CHARS),
          fetched_at: trace.resolvedAt,
        }
      : {}),
  }) as unknown as GraphNode;
};

/**
 * Replace resolved-query matches with their verified answer-doc matches.
 * Non-resolved matches pass through unchanged. Deduped by node_id (nearest
 * distance wins), re-sorted ascending. A resolved-query node whose answer docs
 * are absent from the graph is dropped (no dangling hit).
 */
export const expandResolvedQueries = (
  matches: readonly Match[],
  graph: Graph,
): readonly Match[] => {
  const best = new Map<NodeId, Match>();
  const put = (m: Match): void => {
    const cur = best.get(m.node_id);
    if (!cur || m.distance < cur.distance) best.set(m.node_id, m);
  };
  for (const m of matches) {
    const n = getNode(graph, m.node_id);
    if (isResolvedQuery(n)) {
      // "someone already answered this" → surface its verified docs at the
      // query↔query distance; drop the resolved-query node itself (not a doc).
      for (const doc of answerDocsOf(n as GraphNode)) {
        if (getNode(graph, doc)) put({ node_id: doc, wing: m.wing, distance: m.distance });
      }
    } else {
      put(m);
    }
  }
  return [...best.values()].sort((a, b) => a.distance - b.distance);
};
