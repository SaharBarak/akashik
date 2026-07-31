/**
 * P2P transport — libp2p node lifecycle and identity management.
 * All libp2p I/O lives here. Domain layer remains pure.
 *
 * Identity serialization: raw base64 JSON per CONTEXT.md decision.
 * The `.raw` property on Ed25519PrivateKey gives the correct 64 bytes
 * (32 private + 32 public concatenated). No protobuf framing needed.
 *
 * API note: libp2p 3.x exposes `privateKeyFromRaw` (not the older
 * `unmarshalEd25519PrivateKey`) — verified against installed types.
 */
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import type { Ed25519PrivateKey, Libp2p } from '@libp2p/interface';
import type { PeerInfo } from '@libp2p/interface';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { mdns } from '@libp2p/mdns';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT } from '@libp2p/kad-dht';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
// Layer B of the peer-discovery stack (oracle live queries). Floodsub
// is the simpler pubsub over libp2p — O(n²) relay traffic but fine for
// the small networks folklore targets at this stage. Gossipsub 14.x
// still targets @libp2p/interface v2 while folklore uses v3, so
// floodsub is the right fit until @chainsafe ships a v3-compatible
// gossipsub release. The service API is identical so upgrading later
// is a one-line swap.
import { floodsub } from '@libp2p/floodsub';
import { uPnPNAT } from '@libp2p/upnp-nat';
// @libp2p/identify is required by circuitRelayTransport at runtime — its
// RelayDiscovery always initialises and registers '@libp2p/identify' as a
// serviceDependency. Without it createLibp2p throws on capability checks.
// The Phase 17 decision to omit identify was correct when only tcp/noise/yamux
// were wired; it becomes mandatory the moment circuitRelayTransport is added.
import { identify } from '@libp2p/identify';
// @libp2p/kad-dht@16 declares '@libp2p/ping' as a required service capability —
// createLibp2p throws its capability check ("required capability @libp2p/ping
// but it was not provided") when the DHT is on and ping is unwired. Already
// resolved transitively via kad-dht; promoted to a direct dep + wired below.
import { ping } from '@libp2p/ping';
import { multiaddr } from '@multiformats/multiaddr';
import { ResultAsync, okAsync, errAsync } from 'neverthrow';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PeerError } from '../domain/errors.js';
import { PeerError as PE } from '../domain/errors.js';
import { mutatePeers, addPeerRecord } from './peer-store.js';

/**
 * Identity file format marker. Bumped when the on-disk layout changes
 * in a way that is not forward-compatible with `privateKeyFromRaw`.
 *
 * ed25519-raw-v1:
 *   { format: 'ed25519-raw-v1', privateKeyB64: string, peerId: string, createdAt: string }
 *   privateKeyB64 is base64-encoded 64 bytes (32 priv + 32 pub) exactly as
 *   returned by Ed25519PrivateKey.raw in libp2p 3.x.
 *
 * Legacy files (no `format` field, written by the initial Phase 15 implementation)
 * are accepted on read as if they were ed25519-raw-v1 and upgraded in place
 * on the next write path (silent migration — old installs keep working).
 */
const IDENTITY_FORMAT_CURRENT = 'ed25519-raw-v1' as const;
type IdentityFormat = typeof IDENTITY_FORMAT_CURRENT;

interface IdentityFile {
  readonly format?: IdentityFormat;
  readonly privateKeyB64: string;
  readonly peerId: string;
  readonly createdAt?: string;
}

export interface PeerIdentity {
  readonly privateKey: Ed25519PrivateKey;
  readonly peerId: string;
}

export interface TransportConfig {
  readonly listenPort: number;
  /**
   * Interface to bind the TCP listener to. Default '127.0.0.1' — local-only.
   * Set to '0.0.0.0' in config.yaml to accept remote peer connections.
   * Defaulting to localhost means a user who runs `peer status` or `peer add`
   * on an untrusted network does not accidentally expose a libp2p endpoint.
   */
  readonly listenHost?: string;
  /** mDNS LAN discovery. Default true. Set false via PeerConfig.mdns. */
  readonly mdns?: boolean;
  /** kad-dht wiring. Default true. Set false via PeerConfig.dht.enabled. */
  readonly dhtEnabled?: boolean;
  /** Run the DHT in SERVER mode (serves the routing table for others). Default
   * false = client mode (query-only). Public seed/bootstrap nodes set this true
   * so the self-sovereign /folklore/kad/ DHT actually has servers to route through. */
  readonly dhtServer?: boolean;
  /** Join the PUBLIC IPFS Amino DHT instead of folklore's private one (DISC-04).
   * Default false. When true the DHT protocol becomes /ipfs/kad/1.0.0 and the
   * public IPFS bootstrappers are added so a fresh node finds peers with zero
   * folklore-owned infrastructure (the daemon then runs the rendezvous loop). */
  readonly dhtPublic?: boolean;
  /**
   * WAN seed peers for @libp2p/bootstrap discovery. Unlike mDNS (LAN-only
   * multicast), these are explicit multiaddrs to peers reachable across the
   * internet — the seed that lets a fresh node find the swarm without being
   * on the same network. Empty default → no bootstrap discovery. Sourced
   * from config.yaml `peer.dht.bootstrap_peers`.
   */
  readonly bootstrapPeers?: readonly string[];
  /** Path to peers.json for peer:discovery persistence. REQUIRED when mdns is true. */
  readonly peersPath?: string;
  /**
   * Known-reliable relay multiaddrs for circuit-relay-v2 client mode.
   * When non-empty, `/p2p-circuit` is appended to addresses.listen
   * (Pattern 1, 18-RESEARCH.md). Empty default — no /p2p-circuit listener.
   */
  readonly relays?: readonly string[];
  /**
   * UPnP port mapping. Default true. Silent no-op on listen_host=127.0.0.1
   * (Pitfall 2 — UPnP requires non-loopback listen address; the service
   * catches its own errors internally and will not throw from createLibp2p).
   */
  readonly upnp?: boolean;
  /**
   * Run circuit-relay-v2 in SERVER (hop) mode — BE a relay for NAT'd peers.
   * Default false. A dedicated relay node on a public host sets this true so
   * peers behind CGNAT / symmetric NAT (who can never accept an inbound dial)
   * reserve a slot and advertise a reachable `/…/p2p-circuit/p2p/<id>` address.
   * dcutr then upgrades relayed connections to direct where the NAT permits;
   * the genuinely-stuck pairs stay relayed (folklore payloads are KB-scale, so
   * the relay's data cost is negligible). Requires a non-loopback listenHost.
   */
  readonly relayServer?: boolean;
  /**
   * Additional WebSocket listener port. 0 (default) = no WS listener, TCP only.
   * A public relay sets this so leaves can reach it over `wss` on 443 — the one
   * port that survives CGNAT, hotel wifi, and corporate egress filtering, and
   * the only way to run on a shared/anycast IP whose edge terminates TLS.
   * The listener itself is plain `ws` on an internal port; TLS lives at the
   * edge, and `announceAddrs` publishes the `…/tcp/443/wss` form.
   */
  readonly wsPort?: number;
  /**
   * Multiaddrs to publish INSTEAD of the locally-observed ones (libp2p appends
   * `/p2p/<peerId>` itself, so give them without that suffix). Required
   * whenever the reachable address differs from the bound one — a container
   * behind an edge proxy binds `/ip4/0.0.0.0/tcp/8080/ws` but is dialled at
   * `/dns4/host/tcp/443/wss`. Empty default → announce what we bound.
   */
  readonly announceAddrs?: readonly string[];
}

/**
 * Load existing identity from disk, or generate + persist a new one.
 * Identity file format: { privateKeyB64: string, peerId: string, createdAt: string }
 *
 * Uses raw base64 JSON — `.raw` gives 64 bytes (ed25519 priv+pub),
 * `privateKeyFromRaw()` accepts the raw Uint8Array directly.
 */
export const loadOrCreateIdentity = (
  identityPath: string,
): ResultAsync<PeerIdentity, PeerError> => {
  if (existsSync(identityPath)) {
    return ResultAsync.fromPromise(
      readFile(identityPath, 'utf8'),
      (e) => PE.identityReadError(identityPath, (e as Error).message),
    ).andThen((text) => {
      let stored: IdentityFile;
      try {
        stored = JSON.parse(text) as IdentityFile;
      } catch (e) {
        return errAsync<PeerIdentity, PeerError>(
          PE.identityParseError(identityPath, `JSON parse failed: ${(e as Error).message}`),
        );
      }
      if (!stored || typeof stored.privateKeyB64 !== 'string' || typeof stored.peerId !== 'string') {
        return errAsync<PeerIdentity, PeerError>(
          PE.identityParseError(identityPath, "missing 'privateKeyB64' or 'peerId' fields"),
        );
      }
      // Accept legacy files with no format marker as ed25519-raw-v1
      // (they were written by the initial Phase 15 implementation).
      // Reject any explicit format that is not the current one so
      // accidental migrations are loud instead of silent.
      if (stored.format && stored.format !== IDENTITY_FORMAT_CURRENT) {
        return errAsync<PeerIdentity, PeerError>(
          PE.identityParseError(
            identityPath,
            `unsupported identity format '${stored.format}' (expected '${IDENTITY_FORMAT_CURRENT}')`,
          ),
        );
      }
      let privateKey: Ed25519PrivateKey;
      try {
        const rawBytes = Uint8Array.from(Buffer.from(stored.privateKeyB64, 'base64'));
        const pk = privateKeyFromRaw(rawBytes);
        if (pk.type !== 'Ed25519') {
          return errAsync<PeerIdentity, PeerError>(
            PE.identityParseError(identityPath, `expected Ed25519 key, got ${pk.type}`),
          );
        }
        privateKey = pk as Ed25519PrivateKey;
      } catch (e) {
        return errAsync<PeerIdentity, PeerError>(
          PE.identityParseError(identityPath, `key decode failed: ${(e as Error).message}`),
        );
      }
      return okAsync({ privateKey, peerId: stored.peerId } satisfies PeerIdentity);
    });
  }

  return ResultAsync.fromPromise(
    generateKeyPair('Ed25519'),
    (e) => PE.identityGenerateError((e as Error).message),
  ).andThen((privateKey) => {
    const peerId = peerIdFromPrivateKey(privateKey).toString();
    const stored: IdentityFile = {
      format: IDENTITY_FORMAT_CURRENT,
      privateKeyB64: Buffer.from(privateKey.raw).toString('base64'),
      peerId,
      createdAt: new Date().toISOString(),
    };
    const dir = dirname(identityPath);
    return ResultAsync.fromPromise(
      mkdir(dir, { recursive: true }),
      (e) => PE.identityWriteError(identityPath, (e as Error).message),
    ).andThen(() =>
      ResultAsync.fromPromise(
        writeFile(identityPath, JSON.stringify(stored, null, 2), 'utf8'),
        (e) => PE.identityWriteError(identityPath, (e as Error).message),
      ),
    ).map(() => ({ privateKey, peerId }) satisfies PeerIdentity);
  });
};

/**
 * Create a libp2p node with TCP + Noise + Yamux + optional mDNS + optional kad-dht.
 * Calls node.start() explicitly — omitting this is a known pitfall
 * (the node is constructed but not listening until started).
 *
 * connectionEncrypters: [noise()] satisfies SEC-05 (all traffic encrypted).
 * Noise handshake authenticates peers via ed25519 signatures (SEC-06) —
 * zero custom crypto required.
 *
 * mDNS (DISC-02): enabled by default. Pitfall 2 (17-RESEARCH.md) — Docker/WSL2
 * multicast bind failure must NOT crash createNode. Wrapped in try/catch.
 *
 * kad-dht (DISC-03): off by default. Pitfall 4 (17-RESEARCH.md) — DHT ideally
 * needs identify to populate its routing table. Since @libp2p/identify is not
 * available as a transitive dep, clientMode:true is used without identify.
 *
 * peer:discovery (Pitfall 1, 17-RESEARCH.md): mDNS does NOT auto-dial. The
 * peer:discovery event handler MUST call node.dial() explicitly. Without this,
 * peers appear in peer list but 0 are connected (connectionManager.minConnections
 * is not set — we do NOT rely on auto-dial).
 */
/** Public IPFS (Amino DHT) bootstrappers — the well-known Protocol Labs seed
 * nodes. Added to the bootstrap list ONLY when `dhtPublic` is on, so a folklore
 * node can join the global DHT and rendezvous on it without us running any seed.
 * dnsaddr entries are resolved by libp2p at dial time. */
const PUBLIC_IPFS_BOOTSTRAP: readonly string[] = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
];

export const createNode = (
  identity: PeerIdentity,
  cfg: TransportConfig,
): ResultAsync<Libp2p, PeerError> =>
  ResultAsync.fromPromise(
    (async () => {
      const host = cfg.listenHost ?? '127.0.0.1';
      const mdnsEnabled = cfg.mdns !== false;   // default true per DISC-02
      const dhtOn = cfg.dhtEnabled !== false;   // default ON (self-sovereign /folklore/kad/ DHT)
      const dhtServer = cfg.dhtServer === true; // seeds serve the routing table; leaves query (client)
      const dhtPublic = cfg.dhtPublic === true; // join the public IPFS Amino DHT (DISC-04)
      // Public mode appends the IPFS bootstrappers so a fresh node can join the
      // global DHT and rendezvous on it with zero folklore-owned seed.
      const bootstrapList = [
        ...(cfg.bootstrapPeers ?? []).filter((a) => a.length > 0),
        ...(dhtPublic ? PUBLIC_IPFS_BOOTSTRAP : []),
      ];
      const bootstrapEnabled = bootstrapList.length > 0;

      // Build peerDiscovery array conditionally. mDNS (LAN) and bootstrap
      // (WAN seed) are independent and compose — a node can run both. mDNS
      // failures in Docker/WSL (multicast not forwarded) must not crash
      // createNode — wrap in try. Both emit the same `peer:discovery` event,
      // handled once below.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const peerDiscovery: any[] = [];
      if (mdnsEnabled) {
        try {
          peerDiscovery.push(mdns({ interval: 20000 }));
        } catch (e) {
          // Pitfall 2 (17-RESEARCH.md): Docker bridge / WSL2 non-mirrored
          // multicast bind failure. Log and continue without mDNS.
          // mDNS unavailable — user must use manual 'peer add' or enable Docker --network host / WSL2 mirrored mode.
          process.stderr.write(
            `folklore: mDNS unavailable (${(e as Error).message}). ` +
            `Continuing without LAN discovery. ` +
            `Use manual 'peer add' or enable Docker --network host / WSL2 mirrored mode.\n`,
          );
        }
      }
      if (bootstrapEnabled) {
        try {
          // @libp2p/bootstrap emits peer:discovery for each seed addr at
          // startup; the shared handler below dials + persists them. timeout
          // bounds the initial resolve so a dead seed doesn't stall boot.
          peerDiscovery.push(bootstrap({ list: [...bootstrapList], timeout: 5000 }));
        } catch (e) {
          process.stderr.write(
            `folklore: bootstrap discovery init failed (${(e as Error).message}). ` +
            `Continuing without WAN seed discovery.\n`,
          );
        }
      }

      // Pitfall 4 (17-RESEARCH.md): the DHT needs identify to populate its routing table.
      // identify() is now a direct dep and IS wired below (it's also required by
      // circuit-relay), so the original "identify unavailable" caveat is resolved. The DHT
      // is now ON by default on folklore's own protocol /folklore/kad/1.0.0 (NOT the public
      // IPFS DHT). Leaf nodes run clientMode (query-only); public seed nodes set dht.server
      // so clientMode:false and they serve the routing table for the swarm.
      //
      // Phase 18 NET-03: circuit-relay-v2 client + dcutr + UPnP composed into the
      // existing services block alongside optional DHT (Phase 17). Wire order:
      // DHT first (conditional), dcutr unconditional (auto-activates on relay
      // connections — Pitfall 4), uPnPNAT conditional on cfg.upnp (default true,
      // silent no-op on loopback — Pitfall 2).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const services: Record<string, any> = {
        ...(dhtOn ? { dht: kadDHT({ clientMode: !dhtServer, protocol: dhtPublic ? '/ipfs/kad/1.0.0' : '/folklore/kad/1.0.0' }) } : {}),
        // identify() is required by circuitRelayTransport — RelayDiscovery always
        // registers '@libp2p/identify' as a serviceDependency regardless of init opts.
        // Safe to run unconditionally: it adds the /ipfs/id/1.0.0 protocol handler
        // and provides peer information exchange, which benefits DHT and dcutr too.
        identify: identify(),
        // ping() satisfies the '@libp2p/ping' capability that kad-dht@16 requires
        // as a serviceDependency. Cheap (registers the /ipfs/ping/1.0.0 handler,
        // no traffic until a peer pings). Must be present whenever the DHT is on.
        ping: ping(),
        // dcutr() takes no required args — registers as a libp2p service and
        // hooks the /libp2p/dcutr protocol. Auto-upgrades relay→direct on any
        // limited connection. No effect when no relay connections exist.
        dcutr: dcutr(),
        // uPnPNAT() catches all errors internally (verified in @libp2p/upnp-nat@4.0.15
        // dist/src/upnp-nat.js — the service wraps mapIpAddresses in try/catch and
        // calls this.log.error). Enabled by default; set cfg.upnp=false to opt out.
        // Pitfall 2: UPnP is a no-op on 127.0.0.1 — user must set listen_host:'0.0.0.0'.
        // autoConfirmAddress:true skips the @libp2p/autonat serviceDependency check —
        // the UPnP mapping itself is authoritative enough without a second autonat round-trip.
        ...(cfg.upnp !== false ? { upnpNAT: uPnPNAT({ autoConfirmAddress: true }) } : {}),
        // Phase 39 — oracle live queries. pubsub handles topic-
        // subscribe / broadcast-publish. Zero direct-wire cost when no
        // topics are subscribed. See infrastructure/oracle-gossip.ts
        // for the oracle-specific publish/subscribe helpers.
        pubsub: floodsub(),
        // Circuit-relay-v2 SERVER (hop) — only on a dedicated public relay node
        // (cfg.relayServer). Grants reservations so CGNAT/symmetric-NAT peers get
        // a reachable /p2p-circuit address. applyDefaultLimit:false keeps relayed
        // connections durable (the default ~2min/128KB cap would sever federation
        // for pairs that never hole-punch); folklore payloads are KB-scale, and
        // this is our own relay, so uncapped relayed streams are an acceptable
        // trust cost. maxReservations is generous — the whole point is to serve
        // many NAT'd leaves from one box.
        ...(cfg.relayServer
          ? {
              circuitRelay: circuitRelayServer({
                reservations: { maxReservations: 1024, applyDefaultLimit: false },
              }),
            }
          : {}),
      };

      // Phase 18 NET-03: conditional /p2p-circuit listen. Only add when the user
      // has configured relays explicitly — adding /p2p-circuit without configured
      // relays causes the transport to search for ANY relay peer, producing noisy
      // dial attempts (Anti-Pattern from 18-RESEARCH.md line 331).
      const listenAddrs: string[] = [`/ip4/${host}/tcp/${cfg.listenPort}`];
      // WebSocket listener (relay / edge-fronted nodes). Plain `ws` — TLS is
      // terminated by the edge, which then proxies the upgrade to this port.
      const wsPort = cfg.wsPort ?? 0;
      if (wsPort > 0) {
        listenAddrs.push(`/ip4/${host}/tcp/${wsPort}/ws`);
      }
      if (cfg.relays && cfg.relays.length > 0) {
        listenAddrs.push('/p2p-circuit');
      }
      // Announce overrides the observed addrs entirely, so a node behind an
      // edge proxy publishes the address peers can actually dial.
      const announceAddrs = (cfg.announceAddrs ?? []).filter((a) => a.length > 0);

      const node = await createLibp2p({
        privateKey: identity.privateKey,
        addresses: {
          listen: listenAddrs,
          ...(announceAddrs.length > 0 ? { announce: [...announceAddrs] } : {}),
        },
        // Phase 18 NET-01/NET-03: circuitRelayTransport() goes in transports[]
        // (CLIENT — dial via relays). The hop-relay server variant is
        // explicitly out of scope per CONTEXT.md (deferred to v3).
        // NET-01 multiplexed streams are preserved via yamux() below.
        // webSockets() is wired unconditionally on the CLIENT side too — a leaf
        // never listens on ws (wsPort 0) but must be able to DIAL the relay's
        // `…/tcp/443/wss` address, and a transport it lacks is a peer it cannot
        // reach. Adding the transport costs nothing until a ws addr is dialled.
        transports: [tcp(), webSockets(), circuitRelayTransport()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],  // NET-01 multiplexed streams
        peerDiscovery,
        services,
        // Retry aggressively to match the "persistent connection" contract.
        // Infinity + exponential backoff caps at reconnectRetryInterval * factor^attempts,
        // so retries slow down to minutes-scale for long-flapped peers but never stop.
        connectionManager: {
          reconnectRetries: Infinity,
          reconnectRetryInterval: 2000,
          reconnectBackoffFactor: 2,
        },
      });
      await node.start();

      // Pitfall 1 (17-RESEARCH.md): mDNS/bootstrap peer:discovery only populates
      // peerStore. We MUST explicitly (a) persist with the right discovery_method
      // AND (b) dial. Both sides — persist is safe (atomic lock), dial is
      // best-effort. NOTE: we do NOT set minConnections — no auto-dial; this
      // explicit handler is required. Registered when EITHER mDNS (LAN) or
      // bootstrap (WAN) is active, since both emit the same event.
      if ((mdnsEnabled || bootstrapEnabled) && cfg.peersPath) {
        const peersPath = cfg.peersPath;
        // Seed peerIds extracted from bootstrap multiaddrs (the /p2p/<id> tail)
        // so a discovered peer originating from the seed list is labelled
        // 'bootstrap' rather than 'mdns'.
        const bootstrapPeerIds = new Set(
          bootstrapList
            .map((a) => /\/p2p\/([^/]+)/.exec(a)?.[1])
            .filter((id): id is string => typeof id === 'string'),
        );
        node.addEventListener('peer:discovery', (evt: CustomEvent<PeerInfo>) => {
          // Defensive: evt.detail type is inferred from libp2p; runtime check.
          const detail = evt.detail;
          if (!detail || !detail.id || !Array.isArray(detail.multiaddrs)) return;
          const peerIdStr = detail.id.toString();
          const addrs = detail.multiaddrs.map((m) => m.toString());
          const method = bootstrapPeerIds.has(peerIdStr) ? 'bootstrap' : 'mdns';

          // Persist the discovery via the locked peers.json mutation path.
          // Best-effort: failures here must not break the event loop.
          void mutatePeers(peersPath, (current) =>
            addPeerRecord(current, {
              id: peerIdStr,
              addrs,
              addedAt: new Date().toISOString(),
              discovery_method: method,
            }),
          ).match(
            () => undefined,
            (e) => process.stderr.write(`folklore: peer:discovery persist failed: ${e.type}\n`),
          );

          // Explicit dial — only if not already connected (avoid dial storms on
          // rediscovery intervals). getPeers() returns currently-connected PeerIds.
          const already = node.getPeers().some((p) => p.toString() === peerIdStr);
          if (!already && detail.multiaddrs.length > 0) {
            void node.dial(detail.multiaddrs[0]).catch(() => {
              // Best-effort — a dial can fail for many reasons (firewall, race
              // with peer going offline). The next discovery interval (20s)
              // retries automatically.
            });
          }
        });
      }

      return node;
    })(),
    (e) => PE.transportError((e as Error).message),
  );

/**
 * Dial a remote peer by multiaddr, tag for keep-alive, return PeerId string.
 * multiaddr() parse is synchronous and throws — wrapped in try/catch to
 * convert synchronous throw to a typed Result error.
 */
export const dialAndTag = (
  node: Libp2p,
  rawAddr: string,
): ResultAsync<string, PeerError> =>
  ResultAsync.fromPromise(
    (async () => {
      let ma;
      try {
        ma = multiaddr(rawAddr);
      } catch (e) {
        throw Object.assign(new Error((e as Error).message), {
          _isMultiaddrError: true,
          addr: rawAddr,
        });
      }
      const conn = await node.dial(ma);
      const peerId = conn.remotePeer;
      await node.peerStore.merge(peerId, {
        multiaddrs: [ma],
        tags: { 'keep-alive-folklore': { value: 50 } },
      });
      return peerId.toString();
    })(),
    (e) => {
      const err = e as Error & { _isMultiaddrError?: boolean; addr?: string };
      return err._isMultiaddrError
        ? PE.invalidMultiaddr(err.addr ?? rawAddr, err.message)
        : PE.dialError(rawAddr, err.message);
    },
  );

/**
 * Hang up a peer connection by PeerId string.
 * Uses PE.transportError for hangup failures — not PE.notFound,
 * which is reserved for registry lookup misses.
 */
export const hangUpPeer = (
  node: Libp2p,
  peerIdStr: string,
): ResultAsync<void, PeerError> =>
  ResultAsync.fromPromise(
    (async () => {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const pid = peerIdFromString(peerIdStr);
      await node.hangUp(pid);
    })(),
    (e) => PE.transportError((e as Error).message),
  );

/**
 * Extract the 32-byte Ed25519 public key embedded in a peer id
 * string. Ed25519 peer ids carry the key inline — no key exchange
 * needed to verify a peer's match attestations. Returns null for
 * malformed ids or non-Ed25519 key types (RSA/secp peer ids hash the
 * key instead of embedding it).
 */
export const publicKeyFromPeerId = (peerIdStr: string): Uint8Array | null => {
  try {
    const pid = peerIdFromString(peerIdStr);
    const raw = pid.publicKey?.raw;
    return raw && raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
};

/** Basic node status: own PeerId, listening addresses, connected peer count. */
export interface NodeStatus {
  readonly peerId: string;
  readonly listenAddrs: readonly string[];
  readonly connectedPeers: number;
}

export const getNodeStatus = (node: Libp2p): NodeStatus => ({
  peerId: node.peerId.toString(),
  listenAddrs: node.getMultiaddrs().map((m) => m.toString()),
  connectedPeers: node.getPeers().length,
});
