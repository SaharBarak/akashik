// The privacy classifier is the one component whose failure is irreversible:
// a node wrongly marked shareable is on strangers' disks before anyone
// notices. These fixtures are adversarial on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFederate, saveFlags } from '../src/classify.js';

test('world sources federate', () => {
  for (const sourceUri of [
    'https://arxiv.org/abs/2509.25140',
    'http://example.com/post',
    'arxiv:2509.25140',
    'websearch:libp2p circuit relay',
    'git:github.com/openclaw/openclaw',
    'npm:@usefolklore/folklore',
  ]) {
    assert.equal(shouldFederate({ sourceUri }).federate, true, sourceUri);
    assert.deepEqual(saveFlags({ sourceUri }), []);
  }
});

test('anything learned about the user stays private', () => {
  const cases = [
    { label: 'no source at all', node: {} },
    { label: 'authored from conversation', node: { type: 'concept' } },
    { label: 'session capture', node: { sourceUri: 'claude-session://abc/def' } },
    { label: 'telegram capture', node: { sourceUri: 'telegram:12345' } },
    { label: 'a local file path', node: { sourceUri: 'file:///Users/me/taxes.pdf' } },
  ];
  for (const { label, node } of cases) {
    assert.equal(shouldFederate(node).federate, false, label);
    assert.deepEqual(saveFlags(node), ['--private'], label);
  }
});

test('a direct message never federates, whatever its source looks like', () => {
  // The trap: someone pastes a link into WhatsApp. The URL is a world source,
  // but the memory is still "what my friend sent me at 2am".
  const node = { sourceUri: 'https://example.com/thing', isDirectMessage: true };
  assert.equal(shouldFederate(node).federate, false);
  assert.match(shouldFederate(node).reason, /direct message/);
});

test('personal channels never federate', () => {
  for (const channel of ['whatsapp', 'iMessage', 'SIGNAL', 'sms', 'email']) {
    const node = { sourceUri: 'https://example.com/x', channel };
    assert.equal(shouldFederate(node).federate, false, channel);
  }
});

test('a derived node inherits the strictest verdict of its parents', () => {
  const mixed = {
    type: 'synthesis',
    parents: [
      { sourceUri: 'https://example.com/public-doc' },
      { sourceUri: 'https://example.com/link', isDirectMessage: true },
    ],
  };
  assert.equal(shouldFederate(mixed).federate, false, 'one private parent poisons the synthesis');
  assert.match(shouldFederate(mixed).reason, /derived from a private source/);

  const allPublic = {
    type: 'synthesis',
    parents: [{ sourceUri: 'https://a.example/1' }, { sourceUri: 'arxiv:1234.5678' }],
  };
  assert.equal(shouldFederate(allPublic).federate, true);
});

test('scheme matching is not fooled by lookalikes', () => {
  // `https-evil:` and `nothttp:` both contain an allowlisted scheme as a
  // substring; neither is one.
  for (const sourceUri of ['https-evil://x', 'nothttp://x', 'gitlab:private/repo', 'npmx:thing']) {
    assert.equal(shouldFederate({ sourceUri }).federate, false, sourceUri);
  }
});

test('verdicts explain themselves', () => {
  // The reason string is written into logs; an unauditable policy is not a
  // policy. Every verdict must carry a non-empty justification.
  for (const node of [{}, { sourceUri: 'https://x.example' }, { isDirectMessage: true }]) {
    assert.ok(shouldFederate(node).reason.length > 0);
  }
});
