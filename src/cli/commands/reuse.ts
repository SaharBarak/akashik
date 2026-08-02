/**
 * `folklore reuse` — the inference-reuse surface.
 *
 *   reuse lookup "<question>" [--json] [--max-distance D]
 *       Find the nearest resolved-query node carrying a distilled trace, so a
 *       caller can answer a question someone already answered instead of
 *       paying for inference again.
 *
 *   reuse record "<question>" --trace "<distilled answer>" [--docs id,id]
 *       File the trace so the NEXT ask (yours or a peer's) hits it.
 *
 * Why a dedicated command rather than `ask`: `ask` deliberately expands a
 * resolved-query match into its answer DOCS and drops the node itself
 * (domain/query-reuse.ts), which is right for retrieval and useless here —
 * reuse needs the node, its distilled trace, and the query↔query distance that
 * says how safely it can stand in for a fresh answer.
 *
 * Retrieval is question-to-question on purpose: the stored vector is the
 * question, and matching questions to questions is a much stronger reuse
 * signal than matching a question to prose.
 */

import { defaultRuntime } from '../runtime.js';
import { getNode } from '../../domain/graph.js';
import { formatError } from '../../domain/errors.js';
import { recordResolvedQuery } from '../../application/use-cases.js';
import {
  RESOLVED_QUERY_KIND,
  answerDocsOf,
  isResolvedQuery,
} from '../../domain/query-reuse.js';

/**
 * Default ceiling on query↔query distance for a reuse to be offered.
 *
 * Deliberately tight enough to admit little more than a restatement, because
 * serving a stored answer to a DIFFERENT question is the dominant correctness
 * risk in cache-backed inference — worse than staleness, since it is
 * confidently wrong rather than merely old, and the documented failure mode in
 * the literature is a loose global threshold.
 *
 * Measured against one stored trace ("what transport does the folklore relay
 * use"):
 *
 *   0.000  the identical question
 *   0.940  "which transport protocol is the relay running on"   (same question)
 *   1.012  "what protocol does the relay speak"                 (same question)
 *   1.074  "what port is the relay on"                          (DIFFERENT question)
 *
 * Paraphrases and adjacent-but-distinct questions overlap in that range, so no
 * threshold between them separates the two on this evidence. Until there is a
 * labelled set to calibrate against, the default admits only near-exact
 * restatements: low recall, but it cannot answer the wrong question. Callers
 * may pass --max-distance to explore; nothing should ship a looser default
 * without data behind it.
 */
export const DEFAULT_MAX_DISTANCE = 0.25;

const USAGE = `usage:
  folklore reuse lookup "<question>" [--json] [--max-distance D] [--k N]
  folklore reuse record "<question>" --trace "<text>" [--docs id,id] [--json]`;

interface LookupHit {
  readonly id: string;
  readonly question: string;
  readonly distance: number;
  readonly trace: string;
  readonly answer_docs: readonly string[];
  readonly resolved_at: string | null;
  readonly age_days: number | null;
}

const lookup = async (rest: readonly string[]): Promise<number> => {
  const json = rest.includes('--json');
  const args = rest.filter((a) => !a.startsWith('--'));
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const question = args.join(' ').trim();
  if (!question) {
    console.error(USAGE);
    return 1;
  }
  const maxDistance = Number(flag('--max-distance') ?? DEFAULT_MAX_DISTANCE);
  const k = Number(flag('--k') ?? 20);

  const rt = await defaultRuntime();
  if (rt.isErr()) {
    console.error(`reuse: ${formatError(rt.error)}`);
    return 1;
  }
  const runtime = rt.value;

  try {
    const emb = await runtime.embedder.embed(question);
    if (emb.isErr()) {
      console.error(`reuse: ${formatError(emb.error)}`);
      return 1;
    }
    const matches = await runtime.vectors.searchGlobal(emb.value, k);
    if (matches.isErr()) {
      console.error(`reuse: ${formatError(matches.error)}`);
      return 1;
    }
    const graphRes = await runtime.graphs.load();
    if (graphRes.isErr()) {
      console.error(`reuse: ${formatError(graphRes.error)}`);
      return 1;
    }
    const graph = graphRes.value;
    const now = Date.now();

    // Only trace-bearing resolved-query nodes can answer anything: a
    // question-only pointer records that a question was asked, not what the
    // answer was.
    const hits: LookupHit[] = [];
    for (const m of matches.value) {
      const node = getNode(graph, m.node_id);
      if (!node || !isResolvedQuery(node)) continue;
      const trace = (node as { summary?: string }).summary ?? '';
      if (trace.trim().length === 0) continue;
      if (m.distance > maxDistance) continue;
      const resolvedAt = (node as { fetched_at?: string }).fetched_at ?? null;
      hits.push({
        id: node.id,
        question: node.label ?? node.id,
        distance: m.distance,
        trace,
        answer_docs: answerDocsOf(node),
        resolved_at: resolvedAt,
        age_days: resolvedAt ? (now - Date.parse(resolvedAt)) / 86_400_000 : null,
      });
    }
    hits.sort((a, b) => a.distance - b.distance);

    if (json) {
      console.log(JSON.stringify({ question, max_distance: maxDistance, hits }));
      return 0;
    }
    if (hits.length === 0) {
      console.log(`no reusable answer within distance ${maxDistance}`);
      return 0;
    }
    for (const h of hits) {
      const age = h.age_days === null ? '' : ` [${Math.round(h.age_days)}d]`;
      console.log(`d=${h.distance.toFixed(3)}${age}  ${h.question}`);
      console.log(`  ${h.trace.slice(0, 300).replace(/\s+/g, ' ')}`);
      if (h.answer_docs.length > 0) console.log(`  sources: ${h.answer_docs.join(', ')}`);
    }
    return 0;
  } finally {
    runtime.close();
  }
};

const record = async (rest: readonly string[]): Promise<number> => {
  const json = rest.includes('--json');
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const flagged = new Set(['--trace', '--docs', '--max-distance', '--k']);
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (flagged.has(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    args.push(a);
  }
  const question = args.join(' ').trim();
  const trace = flag('--trace')?.trim() ?? '';
  if (!question || !trace) {
    console.error(USAGE);
    return 1;
  }
  const docs = (flag('--docs') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const rt = await defaultRuntime();
  if (rt.isErr()) {
    console.error(`reuse: ${formatError(rt.error)}`);
    return 1;
  }
  const runtime = rt.value;
  try {
    const res = await recordResolvedQuery({
      graphs: runtime.graphs,
      vectors: runtime.vectors,
      embedder: runtime.embedder,
      githubUser: runtime.githubUser,
    })({ query: question, answerDocIds: docs, trace });
    if (res.isErr()) {
      console.error(`reuse: ${formatError(res.error)}`);
      return 1;
    }
    if (json) console.log(JSON.stringify({ ok: true, kind: RESOLVED_QUERY_KIND, question }));
    else console.log(`recorded reusable answer for: ${question}`);
    return 0;
  } finally {
    runtime.close();
  }
};

export const reuse = async (rest: readonly string[]): Promise<number> => {
  const sub = rest[0];
  if (sub === 'lookup') return lookup(rest.slice(1));
  if (sub === 'record') return record(rest.slice(1));
  console.error(USAGE);
  return 1;
};
