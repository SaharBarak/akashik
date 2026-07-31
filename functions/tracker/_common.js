/**
 * folklore tracker — shared validation + KV helpers.
 *
 * The tracker is a BitTorrent-style rendezvous: it holds peer *pointers*
 * (peerId + dial multiaddrs) per namespace, never any graph data. Peers
 * announce themselves on an interval; entries auto-expire via KV TTL so a peer
 * that goes away drops out of the directory on its own. Transfer + search stay
 * peer-to-peer over libp2p — the tracker only solves first contact.
 *
 * Storage: one KV key per peer, `peer:{ns}:{peerId}` → { peerId, addrs, ts }.
 * `GET /tracker/peers` lists the prefix; TTL evicts the stale. KV list is
 * eventually consistent (~seconds), which is fine for discovery.
 */

export const PEER_TTL_SECONDS = 180; // evict a peer ~3 missed 60s announces
export const MAX_ADDRS = 8;
export const MAX_PEERS_RETURNED = 100;
export const MAX_BODY_BYTES = 4096;

const NS_RE = /^[a-z0-9._-]{1,64}$/;
// libp2p peer ids: CIDv0 base58btc (Qm…) or CIDv1 base32 (bafz… / 12D3KooW…).
const PEER_ID_PAT = '(12D3KooW[1-9A-HJ-NP-Za-km-z]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{20,}|bafz[a-z2-7]{20,})';
const PEER_ID_RE = new RegExp(`^${PEER_ID_PAT}$`);
// A dialable multiaddr, in either form:
//   direct   /ip4|ip6|dns*/host/tcp/port[/ws|/wss]/p2p/<peerId>
//   relayed  …/p2p/<relayId>/p2p-circuit/p2p/<peerId>   ← NAT'd / CGNAT peers
// The relayed form is how a peer behind carrier-grade NAT advertises a
// reachable address: others dial it through the relay, then dcutr upgrades to
// a direct connection when the NAT permits. Both forms END in the peer's own
// /p2p/<peerId>, so the self-address check in sanitizeAddrs holds for both.
const MULTIADDR_RE = new RegExp(
  `^\\/(ip4|ip6|dns4|dns6|dnsaddr)\\/[A-Za-z0-9._:-]+\\/tcp\\/\\d{1,5}(\\/wss?|\\/tls\\/ws)?` +
    `(\\/p2p\\/${PEER_ID_PAT}\\/p2p-circuit)?` +
    `\\/p2p\\/${PEER_ID_PAT}$`,
);

// Non-routable literals a peer must never publish to a PUBLIC tracker:
// loopback, unspecified, IPv4 link-local, IPv6 link-local. Storing one poisons
// the directory — every other peer dials it against ITSELF and fails. Peers
// filter these client-side too (tracker-client.ts announceableAddrs); this is
// the server half of the same rule, since the tracker is open to anyone.
const NON_ROUTABLE_RE =
  /^\/ip4\/(127\.|0\.0\.0\.0|169\.254\.)|^\/ip6\/(::1|::)\/|^\/ip6\/fe[89ab][0-9a-f]:/i;

export const isRoutableAddr = (addr) => !NON_ROUTABLE_RE.test(addr);

export const kvKey = (ns, peerId) => `peer:${ns}:${peerId}`;
export const kvPrefix = (ns) => `peer:${ns}:`;

export const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      ...extraHeaders,
    },
  });

export const validNamespace = (ns) => typeof ns === 'string' && NS_RE.test(ns);
export const validPeerId = (id) => typeof id === 'string' && PEER_ID_RE.test(id);

/**
 * Validate the announced addr set. Every multiaddr must be well-formed AND its
 * trailing /p2p/<id> must equal the announcing peerId — a peer may only
 * announce dial addresses for ITSELF, never inject a pointer to a third party.
 */
export const sanitizeAddrs = (addrs, peerId) => {
  if (!Array.isArray(addrs)) return [];
  const out = [];
  for (const a of addrs) {
    if (typeof a !== 'string' || a.length > 256) continue;
    if (!MULTIADDR_RE.test(a)) continue;
    if (!a.endsWith(`/p2p/${peerId}`)) continue;
    if (!isRoutableAddr(a)) continue;
    if (!out.includes(a)) out.push(a);
    if (out.length >= MAX_ADDRS) break;
  }
  return out;
};
