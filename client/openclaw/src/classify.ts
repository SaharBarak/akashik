/**
 * What may leave this machine.
 *
 * folklore's own default is that a node federates unless flagged private —
 * correct for a research graph built from public sources. OpenClaw's memory is
 * the opposite kind of corpus: WhatsApp threads, iMessage, "my landlord's
 * name", "book the flight with my Amex". Applying folklore's default here
 * would publish someone's personal life to strangers.
 *
 * So this path INVERTS the default. Everything is private unless it clears an
 * explicit allowlist, and the allowlist only admits knowledge about the world,
 * never knowledge about the user. No core change is required: the plugin
 * simply passes `--private` unless `shouldFederate` affirmatively says no.
 *
 * Pure — no I/O, no env, no clock — so the whole policy is unit-testable.
 */

/**
 * Schemes that identify impersonal, re-fetchable sources. Mirrors folklore's
 * own research-surface schemes (src/domain/internal-schemes.ts); DM and
 * session-capture schemes are deliberately absent.
 */
const WORLD_SCHEMES: readonly string[] = [
  'http:',
  'https:',
  'arxiv:',
  'hn:',
  'rss:',
  'websearch:',
  'git:',
  'npm:',
  'repo:',
  'skill:',
  'mcp-tool:',
];

/** Channels that carry person-to-person conversation. Never federated. */
const PERSONAL_CHANNELS: readonly string[] = [
  'whatsapp',
  'imessage',
  'signal',
  'telegram',
  'sms',
  'discord-dm',
  'email',
];

export interface CandidateNode {
  /** Where the content came from. Absent = authored from conversation. */
  readonly sourceUri?: string;
  /** OpenClaw channel id the turn originated on, if any. */
  readonly channel?: string;
  /** True when the channel is a 1:1 conversation rather than a public room. */
  readonly isDirectMessage?: boolean;
  /** folklore note type. */
  readonly type?: string;
  /** For derived nodes: the sources they were distilled from. */
  readonly parents?: readonly CandidateNode[];
}

export type FederationVerdict = {
  readonly federate: boolean;
  /** Human-readable justification — surfaced in logs so the policy is auditable. */
  readonly reason: string;
};

const schemeOf = (uri: string): string => {
  const i = uri.indexOf(':');
  return i < 0 ? '' : uri.slice(0, i + 1).toLowerCase();
};

const isWorldSource = (uri: string | undefined): boolean =>
  typeof uri === 'string' && uri.length > 0 && WORLD_SCHEMES.includes(schemeOf(uri));

/**
 * Decide whether a captured memory may be federated to peers.
 *
 * Deliberately conservative at every branch: an unknown shape is private, an
 * unknown channel is private, a derived node inherits the strictest verdict of
 * its parents. The cost of a false negative is a node that stays local; the
 * cost of a false positive is someone's address on a stranger's disk.
 */
export const shouldFederate = (node: CandidateNode): FederationVerdict => {
  if (node.isDirectMessage === true) {
    return { federate: false, reason: 'originated in a direct message' };
  }
  if (typeof node.channel === 'string' && PERSONAL_CHANNELS.includes(node.channel.toLowerCase())) {
    return { federate: false, reason: `originated on a personal channel (${node.channel})` };
  }

  // Derived nodes are only as shareable as the least shareable thing they were
  // derived from — a synthesis of a private chat is still about that chat.
  if (node.parents && node.parents.length > 0) {
    for (const parent of node.parents) {
      const verdict = shouldFederate(parent);
      if (!verdict.federate) {
        return { federate: false, reason: `derived from a private source (${verdict.reason})` };
      }
    }
    return { federate: true, reason: 'derived entirely from world sources' };
  }

  if (!isWorldSource(node.sourceUri)) {
    return {
      federate: false,
      reason: node.sourceUri
        ? `source scheme not on the world allowlist (${schemeOf(node.sourceUri) || 'none'})`
        : 'authored from conversation, not from a world source',
    };
  }

  return { federate: true, reason: `world source (${schemeOf(node.sourceUri!)})` };
};

/** The flags to append to `folklore save` for this node. */
export const saveFlags = (node: CandidateNode): readonly string[] =>
  shouldFederate(node).federate ? [] : ['--private'];
