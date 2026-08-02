/**
 * Unit tests for domain/query-reuse.ts — the read-time P2P inference-tree
 * reuse hook. A search match on a resolved-query node ("someone already
 * answered this") expands into its verified answer docs at the q2q distance.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fromJson } from '../src/domain/graph.ts';
import {
  resolvedQueryId,
  makeResolvedQueryNode,
  isResolvedQuery,
  answerDocsOf,
  expandResolvedQueries,
  RESOLVED_TRACE_MAX_CHARS,
} from '../src/domain/query-reuse.ts';
import type { Match } from '../src/domain/vectors.ts';

const doc = (id: string) => ({ id, label: id, file_type: 'document' as const, source_file: id });
const mkGraph = (nodes: unknown[]) => {
  const r = fromJson({ nodes, links: [] });
  assert.ok(r.isOk());
  return r._unsafeUnwrap();
};

describe('query-reuse — resolved-query node helpers', () => {
  it('resolvedQueryId is deterministic and normalizes case/whitespace', () => {
    assert.equal(resolvedQueryId('  How Does X Work? '), resolvedQueryId('how does x work?'));
    assert.notEqual(resolvedQueryId('q one'), resolvedQueryId('q two'));
    assert.ok(resolvedQueryId('q').startsWith('resolved-query://'));
  });

  it('makeResolvedQueryNode is recognized and carries its answer docs', () => {
    const n = makeResolvedQueryNode(
      'what is X',
      ['doc-1', 'doc-2'],
      { summary: 'Compare X with the verified evidence.', resolvedAt: '2026-07-15T00:00:00.000Z' },
    );
    assert.ok(isResolvedQuery(n));
    assert.deepEqual([...answerDocsOf(n)], ['doc-1', 'doc-2']);
    assert.equal(n.summary, 'Compare X with the verified evidence.');
    assert.equal(n.fetched_at, '2026-07-15T00:00:00.000Z');
    assert.equal(n.private, false, 'resolved traces must be eligible for federation');
    assert.ok(!isResolvedQuery(doc('doc-1') as never));
  });

  it('keeps raw question-only reuse pointers private and bounds distilled bodies to the wire cap', () => {
    const rawQuestion = makeResolvedQueryNode('private user prompt', ['doc-1']);
    assert.equal(rawQuestion.private, true);
    assert.equal(rawQuestion.summary, undefined);

    const traced = makeResolvedQueryNode(
      'public distilled strategy',
      ['doc-1'],
      { summary: 'x'.repeat(RESOLVED_TRACE_MAX_CHARS + 100), resolvedAt: '2026-07-15T00:00:00.000Z' },
    );
    assert.equal(traced.private, false);
    assert.equal((traced.summary as string).length, RESOLVED_TRACE_MAX_CHARS);
  });
});

describe('expandResolvedQueries', () => {
  it('replaces a resolved-query match with its verified answer docs at the q2q distance', () => {
    const g = mkGraph([doc('answer-doc'), makeResolvedQueryNode('how does X work', ['answer-doc'])]);
    const matches: Match[] = [{ node_id: resolvedQueryId('how does X work'), distance: 0.12 }];
    const out = expandResolvedQueries(matches, g);
    assert.equal(out.length, 1);
    assert.equal(out[0].node_id, 'answer-doc');
    assert.equal(out[0].distance, 0.12, 'doc inherits the query↔query distance');
  });

  it('passes non-resolved (ordinary doc) matches through unchanged', () => {
    const g = mkGraph([doc('d1'), doc('d2')]);
    const matches: Match[] = [{ node_id: 'd1', distance: 0.2 }, { node_id: 'd2', distance: 0.3 }];
    const out = expandResolvedQueries(matches, g);
    assert.deepEqual(out.map((m) => m.node_id), ['d1', 'd2']);
  });

  it('dedupes a doc reached both directly and via a resolved query (nearest wins)', () => {
    const g = mkGraph([doc('shared'), makeResolvedQueryNode('q', ['shared'])]);
    const matches: Match[] = [
      { node_id: 'shared', distance: 0.5 }, // direct
      { node_id: resolvedQueryId('q'), distance: 0.1 }, // via answered question (closer)
    ];
    const out = expandResolvedQueries(matches, g);
    assert.equal(out.length, 1);
    assert.equal(out[0].node_id, 'shared');
    assert.equal(out[0].distance, 0.1);
  });

  it('drops a resolved-query match whose answer doc is absent (no dangling hit)', () => {
    const g = mkGraph([makeResolvedQueryNode('q', ['missing-doc'])]);
    const out = expandResolvedQueries([{ node_id: resolvedQueryId('q'), distance: 0.1 }], g);
    assert.equal(out.length, 0);
  });
});
