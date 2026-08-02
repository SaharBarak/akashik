/**
 * Compound inference: answer from a peer's stored reasoning instead of calling
 * a model.
 *
 * OpenClaw's `before_agent_run` can end a turn before any model input, with
 * user-facing text. That is the interception point folklore's own research
 * concluded was missing in Claude Code, where the same behaviour would need a
 * wire-compatible /v1/messages SSE proxy. Here it is a hook.
 *
 * OFF BY DEFAULT (`FOLKLORE_REUSE_INFERENCE=1` to enable), for a reason worth
 * stating plainly: the threshold that separates "the same question, reworded"
 * from "a different question about the same subject" is not yet calibrated.
 * Measured against a stored trace, paraphrases landed at 0.94-1.01 and an
 * adjacent-but-different question at 1.07 — overlapping ranges. Until a
 * labelled set exists, the shipped default admits only near-exact
 * restatements, and the feature stays opt-in. Answering the wrong question
 * confidently is worse than paying for inference.
 */
import { ipcJson } from './ipc.js';

export interface ReuseHit {
  readonly id: string;
  readonly question: string;
  readonly distance: number;
  readonly trace: string;
  readonly answer_docs: readonly string[];
  readonly resolved_at: string | null;
  readonly age_days: number | null;
}

interface ReuseLookup {
  readonly hits?: readonly ReuseHit[];
}

export interface ReuseConfig {
  /** Master switch. Off → never substitute a stored answer for inference. */
  readonly enabled: boolean;
  /** Max query↔query distance. Tighter than the CLI default is always safe. */
  readonly maxDistance: number;
  /** Refuse to reuse an answer older than this. */
  readonly maxAgeDays: number;
}

export const DEFAULT_REUSE: ReuseConfig = {
  enabled: false,
  maxDistance: 0.25,
  maxAgeDays: 30,
};

export const reuseFromEnv = (env: NodeJS.ProcessEnv = process.env): ReuseConfig => ({
  enabled: env.FOLKLORE_REUSE_INFERENCE === '1',
  maxDistance: Number(env.FOLKLORE_REUSE_MAX_DISTANCE ?? DEFAULT_REUSE.maxDistance),
  maxAgeDays: Number(env.FOLKLORE_REUSE_MAX_AGE_DAYS ?? DEFAULT_REUSE.maxAgeDays),
});

export type ReuseDecision =
  | { readonly reuse: false; readonly reason: string }
  | { readonly reuse: true; readonly hit: ReuseHit; readonly reason: string };

/**
 * Decide whether a stored answer may stand in for a model call.
 *
 * Every rejection is explicit and reasoned, because this decision is invisible
 * to the user when it goes right and indefensible when it goes wrong.
 */
export const decideReuse = (
  hits: readonly ReuseHit[],
  cfg: ReuseConfig = DEFAULT_REUSE,
): ReuseDecision => {
  if (!cfg.enabled) return { reuse: false, reason: 'inference reuse disabled' };
  const best = [...hits].sort((a, b) => a.distance - b.distance)[0];
  if (!best) return { reuse: false, reason: 'no stored answer' };
  if (best.distance > cfg.maxDistance) {
    return { reuse: false, reason: `nearest stored answer is d=${best.distance.toFixed(3)}` };
  }
  if (best.trace.trim().length === 0) {
    return { reuse: false, reason: 'stored answer has no reasoning to serve' };
  }
  // Age matters more here than in retrieval: a stale document a human reads is
  // evidence, a stale answer served AS the answer is a wrong answer.
  if (typeof best.age_days === 'number' && best.age_days > cfg.maxAgeDays) {
    return {
      reuse: false,
      reason: `stored answer is ${Math.round(best.age_days)}d old (max ${cfg.maxAgeDays})`,
    };
  }
  return { reuse: true, hit: best, reason: `d=${best.distance.toFixed(3)}` };
};

/**
 * The reply that replaces the model's turn.
 *
 * It must be honest about its own provenance. A user who cannot tell that an
 * answer came from cache rather than from thinking has no way to distrust it
 * when it is wrong, so the origin, age and sources are stated up front rather
 * than buried.
 */
export const reuseMessage = (hit: ReuseHit): string => {
  const age =
    typeof hit.age_days === 'number' ? ` (answered ${Math.round(hit.age_days)}d ago)` : '';
  const sources =
    hit.answer_docs.length > 0 ? `\n\nSources: ${hit.answer_docs.join(', ')}` : '';
  return (
    `${hit.trace}\n\n` +
    `— from folklore's knowledge graph${age}, matching the earlier question ` +
    `"${hit.question}". No model call was made.${sources}`
  );
};

/** Ask the daemon for reusable answers. Null on any failure — no opinion. */
export const lookupReuse = async (
  question: string,
  cfg: ReuseConfig,
  timeoutMs?: number,
): Promise<readonly ReuseHit[] | null> => {
  const q = question.trim();
  if (!q) return null;
  const res = await ipcJson<ReuseLookup>(
    'reuse',
    ['lookup', q, '--json', '--max-distance', String(cfg.maxDistance)],
    timeoutMs,
  );
  if (!res || !Array.isArray(res.hits)) return null;
  return res.hits;
};
