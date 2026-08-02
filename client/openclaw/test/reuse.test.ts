// Compound inference — answering without a model call.
//
// This is the most consequential decision in the plugin: a wrong reuse is a
// confidently wrong answer the user has no obvious way to distrust. The tests
// are weighted towards the refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REUSE,
  decideReuse,
  reuseFromEnv,
  reuseMessage,
  type ReuseHit,
} from '../src/reuse.js';

const hit = (over: Partial<ReuseHit> = {}): ReuseHit => ({
  id: 'resolved-query://abc123',
  question: 'what transport does the folklore relay use',
  distance: 0.05,
  trace: 'WebSockets over TLS on 443.',
  answer_docs: ['https://example.com/relay-doc'],
  resolved_at: '2026-08-01T00:00:00.000Z',
  age_days: 1,
  ...over,
});

const on = { ...DEFAULT_REUSE, enabled: true };

test('off by default — an uncalibrated substitution must be opt-in', () => {
  const d = decideReuse([hit()], DEFAULT_REUSE);
  assert.equal(d.reuse, false);
  assert.match(d.reason, /disabled/);
});

test('a near-exact restatement is reused', () => {
  const d = decideReuse([hit()], on);
  assert.equal(d.reuse, true);
});

test('a distant question is never answered from cache', () => {
  // The failure this guards: "what port is the relay on" measured d=1.07
  // against the transport trace — a different question, adjacent subject.
  const d = decideReuse([hit({ distance: 1.07 })], on);
  assert.equal(d.reuse, false);
  assert.match(d.reason, /d=1\.070/);
});

test('the nearest hit wins, and it is the one judged', () => {
  const d = decideReuse([hit({ distance: 0.9 }), hit({ distance: 0.02, id: 'closer' })], on);
  assert.equal(d.reuse, true);
  if (d.reuse) assert.equal(d.hit.id, 'closer');
});

test('a stale answer is refused even when the question matches exactly', () => {
  // Staleness matters more here than in retrieval: a stale document a human
  // reads is evidence; a stale answer served AS the answer is a wrong answer.
  const d = decideReuse([hit({ distance: 0, age_days: 400 })], on);
  assert.equal(d.reuse, false);
  assert.match(d.reason, /400d old/);
});

test('an empty trace is not an answer', () => {
  assert.equal(decideReuse([hit({ trace: '   ' })], on).reuse, false);
  assert.equal(decideReuse([], on).reuse, false);
});

test('every refusal explains itself', () => {
  for (const d of [
    decideReuse([], on),
    decideReuse([hit({ distance: 5 })], on),
    decideReuse([hit({ age_days: 999 })], on),
    decideReuse([hit()], DEFAULT_REUSE),
  ]) {
    assert.equal(d.reuse, false);
    assert.ok(d.reason.length > 0);
  }
});

test('env knobs gate and tighten', () => {
  assert.equal(reuseFromEnv({} as NodeJS.ProcessEnv).enabled, false);
  const cfg = reuseFromEnv({
    FOLKLORE_REUSE_INFERENCE: '1',
    FOLKLORE_REUSE_MAX_DISTANCE: '0.1',
    FOLKLORE_REUSE_MAX_AGE_DAYS: '7',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg, { enabled: true, maxDistance: 0.1, maxAgeDays: 7 });
});

test('the served answer discloses that it came from cache', () => {
  // A user who cannot tell an answer was cached has no way to distrust it when
  // it is wrong. Provenance, age and sources are stated, not buried.
  const msg = reuseMessage(hit({ age_days: 3 }));
  assert.match(msg, /WebSockets over TLS/, 'the answer itself');
  assert.match(msg, /No model call was made/);
  assert.match(msg, /3d ago/);
  assert.match(msg, /what transport does the folklore relay use/, 'the matched question');
  assert.match(msg, /example\.com\/relay-doc/, 'its sources');
});
