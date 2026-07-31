/**
 * Tracker client — HTTP rendezvous, the BitTorrent-tracker / eDonkey-server
 * model for first contact.
 *
 * A folklore node announces its dial multiaddrs to a tiny stateless HTTP
 * tracker (a Cloudflare Pages Function, see functions/tracker/) and reads back
 * the current peer set for its namespace. The tracker holds *pointers only* —
 * peerId + multiaddrs, TTL-evicted — never any graph data. Search + fetch stay
 * peer-to-peer over libp2p. This replaces "join the public IPFS DHT" as the
 * default way peers find each other: one HTTPS round trip, no global DHT walk.
 *
 * Pure I/O, no libp2p types — the dial loop lives in tracker-rendezvous.ts.
 */
import { ResultAsync } from 'neverthrow';

export interface TrackerPeer {
  readonly peerId: string;
  readonly addrs: readonly string[];
}

export interface AnnounceResponse {
  readonly ok: boolean;
  readonly ttl: number;
  readonly peers: readonly TrackerPeer[];
}

const DEFAULT_TIMEOUT_MS = 4000;
export const DEFAULT_NAMESPACE = 'folklore';

/** Strip a trailing slash so `${base}/tracker/...` never doubles up. */
const normalizeBase = (url: string): string => url.replace(/\/+$/, '');

/** Non-routable IPv4/IPv6 literals: loopback, link-local, unspecified. A peer
 *  that publishes one of these to a PUBLIC tracker poisons the directory —
 *  every other peer dials the address against itself and fails. */
const NON_ROUTABLE_RE =
  /^\/ip4\/(127\.|0\.0\.0\.0|169\.254\.)|^\/ip6\/(::1|::)\/|^\/ip6\/fe[89ab][0-9a-f]:/i;

/** RFC1918 / CGNAT / IPv6 unique-local — routable on a LAN, useless over WAN.
 *  mDNS already covers the LAN case, so these are dropped from a public
 *  announce unless FOLKLORE_TRACKER_ALLOW_PRIVATE=1 (self-hosted LAN tracker
 *  without multicast, e.g. Docker bridge networks). */
const PRIVATE_RE =
  /^\/ip4\/(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)|^\/ip6\/f[cd][0-9a-f]{2}:/i;

/** A relayed address is always announceable: the dialable half is the RELAY's
 *  public address, whatever the leaf's own interfaces look like. */
const isCircuit = (addr: string): boolean => addr.includes('/p2p-circuit');

/**
 * Filter our own multiaddrs down to the set worth publishing to a tracker.
 * Loopback/link-local always go; private ranges go unless explicitly allowed.
 * Circuit addresses always stay. Returns [] when nothing is publishable — the
 * caller then falls back to a read-only peer fetch instead of announcing junk.
 */
export const announceableAddrs = (
  addrs: readonly string[],
  allowPrivate: boolean = process.env.FOLKLORE_TRACKER_ALLOW_PRIVATE === '1',
): readonly string[] =>
  addrs.filter(
    (a) =>
      isCircuit(a) || (!NON_ROUTABLE_RE.test(a) && (allowPrivate || !PRIVATE_RE.test(a))),
  );

const isPeerArray = (v: unknown): v is TrackerPeer[] =>
  Array.isArray(v) &&
  v.every(
    (p) =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as TrackerPeer).peerId === 'string' &&
      Array.isArray((p as TrackerPeer).addrs),
  );

/**
 * Announce our dial addrs and read back the rest of the swarm. `announce`
 * doubles as fetch — the tracker returns the current peer list in the same
 * response (one round trip, matching a tracker announce/response).
 */
export const announce = (
  trackerUrl: string,
  namespace: string,
  peerId: string,
  addrs: readonly string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): ResultAsync<AnnounceResponse, Error> =>
  ResultAsync.fromPromise(
    (async () => {
      const res = await fetch(`${normalizeBase(trackerUrl)}/tracker/announce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ns: namespace, peerId, addrs }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`tracker announce HTTP ${res.status}`);
      const body = (await res.json()) as Partial<AnnounceResponse>;
      const peers = isPeerArray(body.peers) ? body.peers : [];
      return { ok: body.ok === true, ttl: typeof body.ttl === 'number' ? body.ttl : 0, peers };
    })(),
    (e) => (e instanceof Error ? e : new Error(String(e))),
  );

/** Read-only peer directory for a namespace (discover without announcing). */
export const fetchPeers = (
  trackerUrl: string,
  namespace: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): ResultAsync<readonly TrackerPeer[], Error> =>
  ResultAsync.fromPromise(
    (async () => {
      const url = `${normalizeBase(trackerUrl)}/tracker/peers?ns=${encodeURIComponent(namespace)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`tracker peers HTTP ${res.status}`);
      const body = (await res.json()) as { peers?: unknown };
      return isPeerArray(body.peers) ? body.peers : [];
    })(),
    (e) => (e instanceof Error ? e : new Error(String(e))),
  );
