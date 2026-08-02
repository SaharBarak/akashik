/**
 * Network-before-web: block a web call the graph can already answer.
 *
 * This is the OpenClaw port of folklore's shipped Claude Code gate
 * (.claude/hooks/folklore-smart-hook.cjs). The thresholds and the decision
 * rule are deliberately identical — they are tuned, and a second set of
 * numbers for a second harness would be two things to keep true instead of
 * one.
 *
 * The rule, in order of authority:
 *   1. The energy gate's own verdict (`decision === 'use_memory'`) when it is
 *      enabled. It is a calibrated decision, so re-checking a raw score on top
 *      of it is not extra safety — it is a second, worse gate. (Doing exactly
 *      that is what once made deny inert on real graphs: the composite score
 *      is a trust score and sits low by design.)
 *   2. Otherwise the legacy composite: satisfaction >= threshold.
 * Both additionally require a minimum number of hits, because one lucky match
 * is not a corpus.
 *
 * Pure: no I/O, no env reads at call time (config is passed in), so the policy
 * is unit-testable without a daemon or a gateway.
 */

/** Tools whose whole purpose is to leave the machine. Only these are gated. */
export const DENIABLE_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch']);

export interface GateConfig {
  /** Master switch. Off → never block, only observe. */
  readonly enabled: boolean;
  /** Composite-satisfaction floor used when the energy gate is off. */
  readonly threshold: number;
  /** Minimum graph hits before a block is permissible. */
  readonly minHits: number;
  /** Whether folklore's calibrated energy gate is driving the decision. */
  readonly energyGate: boolean;
}

export const DEFAULT_GATE: GateConfig = {
  enabled: true,
  threshold: 0.85,
  minHits: 2,
  energyGate: false,
};

/** Read the same env knobs the Claude Code hook uses, so one mental model covers both. */
export const gateFromEnv = (env: NodeJS.ProcessEnv = process.env): GateConfig => ({
  enabled: env.FOLKLORE_DENY_WEBSEARCH !== '0',
  threshold: Number(env.FOLKLORE_DENY_THRESHOLD ?? DEFAULT_GATE.threshold),
  minHits: Number(env.FOLKLORE_DENY_MIN_HITS ?? DEFAULT_GATE.minHits),
  energyGate: env.FOLKLORE_ENERGY_GATE === '1',
});

export interface GraphVerdict {
  /** folklore's decision: 'use_memory' | 'verify' | 'search' | 'ask' | null. */
  readonly decision: string | null;
  readonly satisfaction: number | null;
  readonly hitCount: number;
}

export type GateDecision =
  | { readonly block: false; readonly reason: string }
  | { readonly block: true; readonly reason: string };

/**
 * Should this outbound web call be blocked in favour of the graph?
 *
 * Never blocks on a non-web tool, and never blocks without hits — a block with
 * nothing to show for it strands the agent with no answer and no source.
 */
export const decideGate = (
  toolName: string,
  verdict: GraphVerdict,
  cfg: GateConfig = DEFAULT_GATE,
): GateDecision => {
  if (!cfg.enabled) return { block: false, reason: 'gate disabled' };
  if (!DENIABLE_TOOLS.has(toolName)) return { block: false, reason: `${toolName} is not a web tool` };
  if (verdict.hitCount < cfg.minHits) {
    return { block: false, reason: `only ${verdict.hitCount} hit(s), need ${cfg.minHits}` };
  }

  if (cfg.energyGate) {
    return verdict.decision === 'use_memory'
      ? { block: true, reason: `energy-gate: use-memory, ${verdict.hitCount} hits` }
      : { block: false, reason: `energy-gate decision is '${verdict.decision ?? 'none'}'` };
  }

  const sat = verdict.satisfaction;
  if (verdict.decision !== 'use_memory') {
    return { block: false, reason: `decision is '${verdict.decision ?? 'none'}', not use_memory` };
  }
  if (typeof sat !== 'number' || sat < cfg.threshold) {
    return {
      block: false,
      reason: `satisfaction ${typeof sat === 'number' ? sat.toFixed(2) : '—'} below ${cfg.threshold}`,
    };
  }
  return { block: true, reason: `satisfaction ${sat.toFixed(2)}, ${verdict.hitCount} hits` };
};

/**
 * Pull the searchable intent out of a web tool's parameters.
 *
 * Shapes vary by tool and by OpenClaw version, so this reads defensively and
 * returns null rather than guessing — a wrong query would gate on the wrong
 * question, which is worse than not gating.
 */
export const queryFromParams = (
  toolName: string,
  params: Record<string, unknown>,
): string | null => {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

  if (toolName === 'web_search') {
    return str(params.query) ?? str(params.q) ?? str(params.search) ?? null;
  }
  if (toolName === 'web_fetch') {
    // A fetch carries a URL plus (often) the question being asked of the page.
    // The question retrieves better than the URL; fall back to the URL, which
    // still matches a previously-indexed fetch of the same page.
    return str(params.prompt) ?? str(params.question) ?? str(params.url) ?? null;
  }
  return null;
};

/**
 * The message handed back to the agent in place of the web result.
 *
 * It must do three things: say the answer is available, point at where, and
 * name the escape hatch — an agent told only "denied" will either retry the
 * same call or give up.
 */
export const blockMessage = (
  toolName: string,
  reason: string,
  rendered: string,
): string =>
  `folklore: the indexed graph already answers this (${reason}).\n\n` +
  `${rendered}\n\n` +
  `Answer from the context above rather than calling ${toolName}. ` +
  `If a genuinely fresh source is needed, set FOLKLORE_DENY_WEBSEARCH=0.`;
