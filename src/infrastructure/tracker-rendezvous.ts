/**
 * Tracker rendezvous — the HTTP-tracker analog of rendezvous.ts (which walks
 * the DHT). Periodically announces our dial addrs to the tracker and dials any
 * newly-discovered peers in our namespace. Best-effort throughout: a dead
 * tracker or a dead peer is logged, never thrown; the loop continues.
 *
 * This is the DEFAULT discovery path — cheap, global, no DHT. The DHT stays
 * available as an opt-in (peer.dht.public) for tracker-independent operation.
 */
import type { Libp2p } from '@libp2p/interface';
import { announce, announceableAddrs, fetchPeers, type TrackerPeer } from './tracker-client.js';
import { dialAndTag } from './peer-transport.js';

/** Steady re-announce cadence. TTL on the tracker is 180s; re-announcing every
 *  60s keeps us in the directory with margin for a missed round. */
export const TRACKER_INTERVAL_MS = 60_000;
/** Cap dial ATTEMPTS per round — the tracker is semi-trusted, so a flooded
 *  peer list can't turn one round into unbounded dials (mirrors rendezvous). */
export const MAX_DIALS_PER_ROUND = 20;

export interface TrackerRendezvousDeps {
  /** The live libp2p node. Dials go through dialAndTag so discovered peers get
   *  the keep-alive tag (the connectionManager then holds the connection). */
  readonly node: Libp2p;
  readonly trackerUrl: string;
  readonly namespace: string;
  readonly log: (msg: string) => void;
  readonly intervalMs?: number;
}

export interface TrackerRendezvousHandle {
  readonly stop: () => void;
}

/**
 * One round: announce our addrs (also returns the swarm), then dial fresh
 * peers. If we have no dialable addrs yet (node still binding), fall back to a
 * read-only fetch so a leaf node still discovers. Returns peers newly dialed.
 */
export const trackerTick = async (deps: TrackerRendezvousDeps): Promise<number> => {
  const self = deps.node.peerId.toString();
  // Only publish addresses another peer could actually dial. A daemon bound to
  // loopback (or one whose only addrs are LAN-private) announces nothing and
  // degrades to a read-only fetch below — it still DISCOVERS and dials out,
  // it just stops poisoning the directory with undialable pointers.
  const myAddrs = announceableAddrs(deps.node.getMultiaddrs().map((a) => a.toString()));

  const peersRes = myAddrs.length > 0
    ? (await announce(deps.trackerUrl, deps.namespace, self, myAddrs)).map((r) => r.peers)
    : await fetchPeers(deps.trackerUrl, deps.namespace);

  if (peersRes.isErr()) {
    deps.log(`tracker: round failed (${peersRes.error.message})`);
    return 0;
  }

  const peers: readonly TrackerPeer[] = peersRes.value;
  const connected = new Set(deps.node.getPeers().map((p) => p.toString()));
  let dialed = 0;
  let attempts = 0;

  for (const p of peers) {
    if (p.peerId === self || connected.has(p.peerId)) continue;
    if (attempts >= MAX_DIALS_PER_ROUND) break;
    for (const addr of p.addrs) {
      if (attempts >= MAX_DIALS_PER_ROUND) break;
      attempts += 1;
      const res = await dialAndTag(deps.node, addr);
      if (res.isOk()) {
        dialed += 1;
        deps.log(`tracker: dialed peer ${p.peerId} via ${addr}`);
        break; // one good addr per peer is enough
      }
      deps.log(`tracker: dial ${p.peerId} failed (${res.error.type})`);
    }
  }
  return dialed;
};

/**
 * Start the periodic tracker loop. Self-scheduling via setTimeout (never
 * setInterval, so a slow round can't overlap itself); `unref()` keeps the timer
 * off the daemon's event-loop critical path. Fires one round immediately.
 */
export const startTrackerRendezvous = (deps: TrackerRendezvousDeps): TrackerRendezvousHandle => {
  const intervalMs = deps.intervalMs ?? TRACKER_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await trackerTick(deps);
    } catch (e) {
      deps.log(`tracker: tick error (${(e as Error).message})`);
    }
    if (stopped) return;
    timer = setTimeout(() => void loop(), intervalMs);
    timer.unref?.();
  };

  void loop();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
};
