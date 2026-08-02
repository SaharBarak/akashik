// The web gate. Blocking a tool call is the most disruptive thing this plugin
// does, so the rule is pinned from both sides: it must fire when the graph
// genuinely answers, and must NOT fire on thin evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GATE,
  decideGate,
  gateFromEnv,
  queryFromParams,
  blockMessage,
} from '../src/gate.js';

const confident = { decision: 'use_memory', satisfaction: 0.91, hitCount: 4 };

test('blocks a web search the graph already answers', () => {
  const d = decideGate('web_search', confident);
  assert.equal(d.block, true);
  assert.match(d.reason, /0\.91/);
});

test('never gates a non-web tool', () => {
  // The gate exists to save network trips. Blocking a file read or an exec
  // would be a different, much worse product.
  for (const tool of ['read_file', 'exec', 'memory_recall', 'apply_patch']) {
    assert.equal(decideGate(tool, confident).block, false, tool);
  }
});

test('one lucky hit is not a corpus', () => {
  assert.equal(decideGate('web_search', { ...confident, hitCount: 1 }).block, false);
  assert.equal(decideGate('web_search', { ...confident, hitCount: 0 }).block, false);
});

test('a low-confidence verdict lets the web call through', () => {
  const d = decideGate('web_search', { ...confident, satisfaction: 0.40 });
  assert.equal(d.block, false);
  assert.match(d.reason, /below 0\.85/);
});

test("a decision other than use_memory never blocks", () => {
  for (const decision of ['verify', 'search', 'ask', null]) {
    const d = decideGate('web_search', { ...confident, decision });
    assert.equal(d.block, false, String(decision));
  }
});

test('the energy gate is the authority when enabled — not the composite score', () => {
  // Regression guard for the bug that made deny inert in the Claude Code hook:
  // under the energy gate the composite satisfaction is a TRUST score and sits
  // low by design (measured 0.63 on a real graph while the decision was
  // use_memory). Re-checking it on top of a calibrated decision is not extra
  // safety, it is a second and worse gate that never fires.
  const cfg = { ...DEFAULT_GATE, energyGate: true };
  const realWorld = { decision: 'use_memory', satisfaction: 0.63, hitCount: 5 };

  assert.equal(decideGate('web_search', realWorld, cfg).block, true, 'energy gate must trust its own verdict');
  assert.equal(
    decideGate('web_search', realWorld, DEFAULT_GATE).block,
    false,
    'without the energy gate the legacy score floor still applies',
  );
});

test('the master switch disables blocking entirely', () => {
  const off = { ...DEFAULT_GATE, enabled: false };
  assert.equal(decideGate('web_search', confident, off).block, false);
});

test('env knobs match the Claude Code hook', () => {
  // One mental model across harnesses — the same variable names must work.
  const cfg = gateFromEnv({
    FOLKLORE_DENY_WEBSEARCH: '0',
    FOLKLORE_DENY_THRESHOLD: '0.95',
    FOLKLORE_DENY_MIN_HITS: '3',
    FOLKLORE_ENERGY_GATE: '1',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg, { enabled: false, threshold: 0.95, minHits: 3, energyGate: true });

  const defaults = gateFromEnv({} as NodeJS.ProcessEnv);
  assert.equal(defaults.enabled, true, 'gating is on unless explicitly disabled');
  assert.equal(defaults.threshold, 0.85);
  assert.equal(defaults.minHits, 2);
});

test('query extraction reads each web tool, and refuses to guess', () => {
  assert.equal(queryFromParams('web_search', { query: 'libp2p relay' }), 'libp2p relay');
  assert.equal(queryFromParams('web_search', { q: 'fallback key' }), 'fallback key');

  // A fetch's question retrieves better than its URL, so prefer it.
  assert.equal(
    queryFromParams('web_fetch', { url: 'https://x.example', prompt: 'what is the rate limit' }),
    'what is the rate limit',
  );
  assert.equal(queryFromParams('web_fetch', { url: 'https://x.example' }), 'https://x.example');

  // Nothing recognisable → null, so the caller declines to gate rather than
  // gating on the wrong question.
  assert.equal(queryFromParams('web_search', {}), null);
  assert.equal(queryFromParams('web_search', { query: '   ' }), null);
  assert.equal(queryFromParams('some_other_tool', { query: 'x' }), null);
});

test('the block message tells the agent what to do instead', () => {
  // An agent told only "denied" retries the same call or gives up. The message
  // has to carry the answer, and the escape hatch.
  const msg = blockMessage('web_search', 'satisfaction 0.91, 4 hits', '- a hit\n  body');
  assert.match(msg, /already answers/);
  assert.match(msg, /- a hit/, 'must include the graph context');
  assert.match(msg, /FOLKLORE_DENY_WEBSEARCH=0/, 'must name the override');
  assert.match(msg, /web_search/);
});
