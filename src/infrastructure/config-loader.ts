/**
 * Config loader — reads ~/.folklore/config.yaml with typed defaults.
 *
 * The config is optional. If the file doesn't exist, all fields fall
 * back to their defaults. If it exists but is malformed, we return
 * an error rather than silently using defaults (fail-loud at startup).
 *
 * The shape mirrors config/config.example.yaml. Only the daemon and
 * tunnels sections are consumed in Phase 6; the rest is read but
 * passed through to callers as-is.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ResultAsync, errAsync, okAsync } from 'neverthrow';
import { parse as parseYaml } from 'yaml';
import type { GraphError } from '../domain/errors.js';
import { GraphError as GE } from '../domain/errors.js';
import type { SessionsConfig } from '../domain/sessions.js';

// ─────────────── types ──────────────────

export interface DaemonConfig {
  readonly interval_seconds: number;
  readonly max_parallel_sources: number;
  readonly discovery_cadence: number;
  readonly round_robin_sources: boolean;
  /** Phase 4.1 — daemon-tick auto-consolidation (off by default). */
  readonly consolidate: ConsolidateConfig;
  /** Daemon-tick long-term-memory GC — TTL delete + frozen-band demote (off by default). */
  readonly auto_forget: AutoForgetDaemonConfig;
}

export interface AutoForgetDaemonConfig {
  /** Whether the daemon runs the long-term-memory GC pass on its own cadence. Default false. */
  readonly enabled: boolean;
  /** How often to attempt a GC pass (seconds). Default 86400 (daily). */
  readonly interval_seconds: number;
  /** Plan-only safety valve: compute the plan and log it, but never mutate. Default false. */
  readonly dry_run: boolean;
  /** Retention band below which a node is demoted (kept for audit, dropped from live view). */
  readonly demote_band: 'cold' | 'frozen';
  /** Only demote once a node is also older than this many days. Default 30. */
  readonly min_age_days: number;
}

export interface ConsolidateConfig {
  /** Whether the daemon should auto-run consolidation on its own cadence. Default false. */
  readonly enabled: boolean;
  /** Workspaces to consolidate. Empty = every workspace with > min_workspace_raw_to_trigger raw entries. */
  readonly workspaces: readonly string[];
  /** How often to attempt a consolidation pass (seconds). Default 86400 (daily). */
  readonly interval_seconds: number;
  /** Local LLM model name (Ollama tag). */
  readonly model: string;
  /** Cosine similarity threshold for cluster membership. */
  readonly similarity_threshold: number;
  /** Minimum cluster size to emit a consolidated_memory. */
  readonly min_size: number;
  /** Maximum cluster size (clamp). */
  readonly max_size: number;
  /** Auto-prune source raw entries after consolidation (with NDJSON backup). Default true. */
  readonly prune: boolean;
  /** Skip a workspace if it has fewer than this many unconsolidated raw entries. Default 50. */
  readonly min_workspace_raw_to_trigger: number;
}

export interface TunnelsConfig {
  readonly enabled: boolean;
  readonly similarity_threshold: number;
  readonly min_cluster_size: number;
}

export interface BandwidthConfig {
  /** Per-peer token bucket rate for outbound share updates (default 50). */
  readonly max_updates_per_sec_per_peer: number;
  /** Daemon-tick semaphore on concurrent outbound share syncs (default 10). */
  readonly max_concurrent_share_syncs: number;
}

export interface BandwidthOverride {
  readonly max_updates_per_sec_per_peer?: number;
  readonly max_concurrent_share_syncs?: number;
}

export interface PeerConfig {
  /** Listening port for the libp2p TCP transport. 0 = OS-assigned (default). */
  readonly port: number;
  /**
   * Interface to bind the TCP listener to. Default '0.0.0.0' — the DAEMON is
   * the only consumer of this key (every ephemeral CLI/MCP node hardcodes
   * '127.0.0.1' at its own createNode call), and a daemon bound to loopback
   * can never be dialled: it announces `/ip4/127.0.0.1/…` to the tracker,
   * which every other peer then dials against ITSELF. Loopback also makes
   * UPnP a silent no-op, so no port mapping is ever requested. Set to
   * '127.0.0.1' to run the daemon local-only (mDNS/LAN discovery still works,
   * WAN peering does not).
   *
   * The exposed surface is the libp2p TCP listener only — noise-encrypted and
   * peer-id-authenticated, with the federated-search rate limiter in front of
   * it. No plaintext HTTP endpoint is opened on this interface.
   */
  readonly listen_host: string;
  /** mDNS LAN auto-discovery. Default true (enabled) per DISC-02 locked decision. */
  readonly mdns: boolean;
  /** Kademlia DHT. Wired but off by default per DISC-03 locked decision. */
  readonly dht: {
    readonly enabled: boolean;
    /** Run the DHT in server mode (serve the routing table). Default false =
     * client/query-only. Public seed nodes set true. */
    readonly server: boolean;
    /** Join the PUBLIC IPFS Amino DHT for zero-infra WAN discovery (DISC-04).
     * Default false = folklore's own private /folklore/kad/ network. When true,
     * the DHT switches to /ipfs/kad/1.0.0 + public IPFS bootstrappers and the
     * daemon runs the rendezvous loop. Tradeoff: discovery metadata becomes
     * public (data stays signed/private) — opt-in, never the default. */
    readonly public: boolean;
    /** Optional multiaddr list fed to @libp2p/bootstrap as DHT seed peers
     * (a community list — multiple seeds, anyone can run one). */
    readonly bootstrap_peers: readonly string[];
  };
  /** HTTP tracker rendezvous (BitTorrent-tracker model) — the DEFAULT WAN
   * discovery path. A tiny stateless endpoint that holds peer pointers only;
   * cheaper and faster than the public DHT. Set url to '' to disable. */
  readonly tracker: {
    /** Base URL of the tracker (e.g. https://usefolklore.sh). '' = disabled. */
    readonly url: string;
    /** Swarm namespace — peers only discover others in the same namespace. */
    readonly namespace: string;
  };
  /** Run THIS node as a circuit-relay-v2 server (a relay for NAT'd peers).
   * Default false — only a dedicated public relay box sets this true. */
  readonly relay_server: boolean;
  /** Token bucket for inbound federated-search requests (per-peer). */
  readonly search_rate_limit: {
    readonly rate_per_sec: number;
    readonly burst: number;
  };
  /**
   * Known-reliable relay multiaddrs (empty by default — CONTEXT.md locked).
   * When non-empty, /p2p-circuit is added to addresses.listen in Plan 02,
   * and the daemon dials each relay on startup (Plan 03).
   * NO hardcoded IPFS bootstrap nodes — users opt in explicitly.
   */
  readonly relays: readonly string[];
  /**
   * Extra WebSocket listener port. 0 (default) = TCP only. A public relay sets
   * this and puts TLS at the edge, so leaves reach it over `wss` on 443 — the
   * port that survives CGNAT, hotel wifi and corporate egress filters.
   */
  readonly ws_port: number;
  /**
   * Multiaddrs to publish instead of the locally-bound ones (no `/p2p/<id>`
   * suffix — libp2p appends it). Needed only when the dialable address differs
   * from the bound one, e.g. `/dns4/host/tcp/443/wss` in front of a container
   * listening on plain ws. Empty default → announce what we bound.
   */
  readonly announce: readonly string[];
  /**
   * UPnP port mapping. Default true — @libp2p/upnp-nat is a no-op on
   * listen_host=127.0.0.1 (Pitfall 2 from 18-RESEARCH.md) and catches
   * all errors internally, so wiring unconditionally is safe.
   */
  readonly upnp: boolean;
  /**
   * Layered bandwidth limits (CONTEXT.md locked defaults):
   *   - max_updates_per_sec_per_peer: 50
   *   - max_concurrent_share_syncs: 10
   */
  readonly bandwidth: BandwidthConfig;
  /**
   * Optional per-peer overrides keyed by PeerId string.
   * Phase 18 ships with plumbing only — CLI to edit comes later.
   */
  readonly bandwidth_overrides?: Readonly<Record<string, BandwidthOverride>>;
}

export interface SecurityConfig {
  /**
   * Extra secrets patterns to append to the 10 built-ins.
   * Each entry must have a `name` (for diagnostics) and a `pattern`
   * (ECMAScript regex string — the 'g' flag is added automatically).
   */
  readonly secrets_patterns: ReadonlyArray<{ readonly name: string; readonly pattern: string }>;
}

export interface AppConfig {
  readonly daemon: DaemonConfig;
  readonly tunnels: TunnelsConfig;
  readonly peer: PeerConfig;
  readonly security: SecurityConfig;
  readonly sessions: SessionsConfig;
  /** The full raw parsed object — callers can drill into sections we don't type. */
  readonly raw: Readonly<Record<string, unknown>>;
}

// ─────────────── defaults ───────────────

const DEFAULT_CONSOLIDATE: ConsolidateConfig = {
  enabled: false,
  workspaces: [],
  interval_seconds: 86400,
  model: 'qwen2.5:1.5b',
  similarity_threshold: 0.8,
  min_size: 5,
  max_size: 200,
  prune: true,
  min_workspace_raw_to_trigger: 50,
};

const DEFAULT_AUTO_FORGET: AutoForgetDaemonConfig = {
  enabled: false,
  interval_seconds: 86400,
  dry_run: false,
  demote_band: 'frozen',
  min_age_days: 30,
};

const DEFAULT_DAEMON: DaemonConfig = {
  interval_seconds: 86400,
  max_parallel_sources: 8,
  discovery_cadence: 5,
  round_robin_sources: true,
  consolidate: DEFAULT_CONSOLIDATE,
  auto_forget: DEFAULT_AUTO_FORGET,
};

const DEFAULT_TUNNELS: TunnelsConfig = {
  enabled: true,
  similarity_threshold: 0.80,
  min_cluster_size: 3,
};

// Federation-by-default: bootstrap multiaddrs from FOLKLORE_BOOTSTRAP_PEERS
// (comma-separated). This is the DEFAULT used both when no config.yaml exists
// (fresh install) and when config.yaml omits/empties the key — so one env var
// joins the network with no manual `folklore peer add`. Empty → [] (local-only).
const ENV_BOOTSTRAP_PEERS: readonly string[] = (process.env.FOLKLORE_BOOTSTRAP_PEERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Default HTTP tracker (BitTorrent-tracker rendezvous). Overridable via
// FOLKLORE_TRACKER_URL; set to '' to run without a tracker (local/DHT-only).
// MUST match the deployed Pages domain — usefolklore.com is NOT ours (it
// redirects to an unrelated site), so pointing here at the wrong host silently
// kills discovery for every install.
const FOLKLORE_TRACKER_URL: string = process.env.FOLKLORE_TRACKER_URL ?? 'https://usefolklore.sh';

// Default circuit-relay multiaddr(s) for NAT'd leaf nodes (comma-separated).
// A node with a relay configured reserves a slot and advertises a reachable
// /…/p2p-circuit address. Empty by default until a relay is deployed; wire it
// once the relay node is up (FOLKLORE_RELAYS or peer.relays in config.yaml).
const ENV_RELAYS: readonly string[] = (process.env.FOLKLORE_RELAYS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Externally-reachable multiaddrs to publish instead of the bound ones (no
// /p2p/<id> suffix — libp2p appends it). Only an edge-fronted node needs this.
const ENV_ANNOUNCE: readonly string[] = (process.env.FOLKLORE_ANNOUNCE ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_PEER: PeerConfig = {
  port: 0,
  listen_host: '0.0.0.0',
  mdns: true,
  // public DHT is now OFF by default — every node used to dial the public IPFS
  // Amino bootstrappers on boot (~50s+ of WAN latency + noise). Discovery now
  // goes through the HTTP tracker (below); the public DHT is opt-in for
  // tracker-independent operation.
  dht: { enabled: true, server: false, public: false, bootstrap_peers: ENV_BOOTSTRAP_PEERS },
  tracker: { url: FOLKLORE_TRACKER_URL, namespace: 'folklore' },
  relay_server: false,
  search_rate_limit: { rate_per_sec: 10, burst: 30 },
  relays: ENV_RELAYS,
  ws_port: 0,
  announce: ENV_ANNOUNCE,
  upnp: true,
  bandwidth: {
    max_updates_per_sec_per_peer: 50,
    max_concurrent_share_syncs: 10,
  },
  // bandwidth_overrides intentionally omitted (optional, undefined by default)
};

const DEFAULT_SECURITY: SecurityConfig = { secrets_patterns: [] };

const DEFAULT_SESSIONS: SessionsConfig = {
  interval_seconds: 300,
  retention_days: 30,
  scan_user_messages: true,
};

const DEFAULT_CONFIG: AppConfig = {
  daemon: DEFAULT_DAEMON,
  tunnels: DEFAULT_TUNNELS,
  peer: DEFAULT_PEER,
  security: DEFAULT_SECURITY,
  sessions: DEFAULT_SESSIONS,
  raw: {},
};

// ─────────────── loader ─────────────────

export const loadConfig = (path: string): ResultAsync<AppConfig, GraphError> => {
  if (!existsSync(path)) return okAsync(DEFAULT_CONFIG);
  return ResultAsync.fromPromise(readFile(path, 'utf8'), (e) =>
    GE.readError(path, (e as Error).message),
  ).andThen((text) => {
    try {
      const raw = parseYaml(text) as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') {
        return errAsync<AppConfig, GraphError>(GE.parseError(path, 'config root must be a YAML mapping'));
      }
      const daemonRaw = (raw.daemon ?? {}) as Record<string, unknown>;
      const tunnelsRaw = (raw.tunnels ?? {}) as Record<string, unknown>;
      const peerRaw = (raw.peer ?? {}) as Record<string, unknown>;
      const securityRaw = (raw.security ?? {}) as Record<string, unknown>;

      const consolidateRaw = (daemonRaw.consolidate ?? {}) as Record<string, unknown>;
      const consolidate: ConsolidateConfig = {
        enabled: bool(consolidateRaw.enabled, DEFAULT_CONSOLIDATE.enabled),
        workspaces: Array.isArray(consolidateRaw.workspaces)
          ? (consolidateRaw.workspaces as unknown[]).filter((r): r is string => typeof r === 'string')
          : DEFAULT_CONSOLIDATE.workspaces,
        interval_seconds: num(consolidateRaw.interval_seconds, DEFAULT_CONSOLIDATE.interval_seconds),
        model: str(consolidateRaw.model, DEFAULT_CONSOLIDATE.model),
        similarity_threshold: num(consolidateRaw.similarity_threshold, DEFAULT_CONSOLIDATE.similarity_threshold),
        min_size: num(consolidateRaw.min_size, DEFAULT_CONSOLIDATE.min_size),
        max_size: num(consolidateRaw.max_size, DEFAULT_CONSOLIDATE.max_size),
        prune: bool(consolidateRaw.prune, DEFAULT_CONSOLIDATE.prune),
        min_workspace_raw_to_trigger: num(consolidateRaw.min_workspace_raw_to_trigger, DEFAULT_CONSOLIDATE.min_workspace_raw_to_trigger),
      };
      const autoForgetRaw = (daemonRaw.auto_forget ?? {}) as Record<string, unknown>;
      const bandRaw = str(autoForgetRaw.demote_band, DEFAULT_AUTO_FORGET.demote_band);
      const autoForget: AutoForgetDaemonConfig = {
        enabled: bool(autoForgetRaw.enabled, DEFAULT_AUTO_FORGET.enabled),
        interval_seconds: num(autoForgetRaw.interval_seconds, DEFAULT_AUTO_FORGET.interval_seconds),
        dry_run: bool(autoForgetRaw.dry_run, DEFAULT_AUTO_FORGET.dry_run),
        demote_band: bandRaw === 'cold' ? 'cold' : DEFAULT_AUTO_FORGET.demote_band,
        min_age_days: num(autoForgetRaw.min_age_days, DEFAULT_AUTO_FORGET.min_age_days),
      };
      const daemon: DaemonConfig = {
        interval_seconds: num(daemonRaw.interval_seconds, DEFAULT_DAEMON.interval_seconds),
        max_parallel_sources: num(daemonRaw.max_parallel_sources, DEFAULT_DAEMON.max_parallel_sources),
        discovery_cadence: num(daemonRaw.discovery_cadence, DEFAULT_DAEMON.discovery_cadence),
        round_robin_sources: bool(daemonRaw.round_robin_sources, DEFAULT_DAEMON.round_robin_sources),
        consolidate,
        auto_forget: autoForget,
      };
      const tunnels: TunnelsConfig = {
        enabled: bool(tunnelsRaw.enabled, DEFAULT_TUNNELS.enabled),
        similarity_threshold: num(tunnelsRaw.similarity_threshold, DEFAULT_TUNNELS.similarity_threshold),
        min_cluster_size: num(tunnelsRaw.min_cluster_size, DEFAULT_TUNNELS.min_cluster_size),
      };
      const peer: PeerConfig = {
        port: num(peerRaw.port, DEFAULT_PEER.port),
        listen_host: str(peerRaw.listen_host, DEFAULT_PEER.listen_host),
        mdns: bool(peerRaw.mdns, DEFAULT_PEER.mdns),
        dht: {
          enabled: bool(
            (peerRaw.dht as Record<string, unknown> | undefined)?.enabled,
            DEFAULT_PEER.dht.enabled,
          ),
          server: bool(
            (peerRaw.dht as Record<string, unknown> | undefined)?.server,
            DEFAULT_PEER.dht.server,
          ),
          public: bool(
            (peerRaw.dht as Record<string, unknown> | undefined)?.public,
            DEFAULT_PEER.dht.public,
          ),
          // Federation-by-default: prefer a NON-EMPTY config list; otherwise fall
          // back to the FOLKLORE_BOOTSTRAP_PEERS env list (comma-separated
          // multiaddrs). An empty config list must NOT shadow the env default, so
          // a fresh install joins the network via one env var (no manual peer add).
          // Neither set → [] (local-only in effect).
          bootstrap_peers: ((): readonly string[] => {
            const fromConfig = Array.isArray(
              (peerRaw.dht as Record<string, unknown> | undefined)?.bootstrap_peers,
            )
              ? ((peerRaw.dht as Record<string, unknown>).bootstrap_peers as unknown[]).filter(
                  (x): x is string => typeof x === 'string',
                )
              : [];
            return fromConfig.length > 0 ? fromConfig : ENV_BOOTSTRAP_PEERS;
          })(),
        },
        tracker: {
          url: str(
            (peerRaw.tracker as Record<string, unknown> | undefined)?.url,
            DEFAULT_PEER.tracker.url,
          ),
          namespace: str(
            (peerRaw.tracker as Record<string, unknown> | undefined)?.namespace,
            DEFAULT_PEER.tracker.namespace,
          ),
        },
        relay_server: bool(peerRaw.relay_server, DEFAULT_PEER.relay_server),
        search_rate_limit: {
          rate_per_sec: num(
            (peerRaw.search_rate_limit as Record<string, unknown> | undefined)?.rate_per_sec,
            DEFAULT_PEER.search_rate_limit.rate_per_sec,
          ),
          burst: num(
            (peerRaw.search_rate_limit as Record<string, unknown> | undefined)?.burst,
            DEFAULT_PEER.search_rate_limit.burst,
          ),
        },
        // Non-empty config list wins; an empty/absent one falls back to the
        // FOLKLORE_RELAYS env default (so a shipped default relay isn't shadowed
        // by an empty config array — mirrors bootstrap_peers).
        relays: ((): readonly string[] => {
          const fromConfig = Array.isArray(peerRaw.relays)
            ? (peerRaw.relays as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
          return fromConfig.length > 0 ? fromConfig : DEFAULT_PEER.relays;
        })(),
        ws_port: num(peerRaw.ws_port, DEFAULT_PEER.ws_port),
        // Same precedence rule as relays: config wins when non-empty, else the
        // FOLKLORE_ANNOUNCE env default.
        announce: ((): readonly string[] => {
          const fromConfig = Array.isArray(peerRaw.announce)
            ? (peerRaw.announce as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
          return fromConfig.length > 0 ? fromConfig : DEFAULT_PEER.announce;
        })(),
        upnp: bool(peerRaw.upnp, DEFAULT_PEER.upnp),
        bandwidth: {
          max_updates_per_sec_per_peer: num(
            (peerRaw.bandwidth as Record<string, unknown> | undefined)?.max_updates_per_sec_per_peer,
            DEFAULT_PEER.bandwidth.max_updates_per_sec_per_peer,
          ),
          max_concurrent_share_syncs: num(
            (peerRaw.bandwidth as Record<string, unknown> | undefined)?.max_concurrent_share_syncs,
            DEFAULT_PEER.bandwidth.max_concurrent_share_syncs,
          ),
        },
        bandwidth_overrides:
          peerRaw.bandwidth_overrides && typeof peerRaw.bandwidth_overrides === 'object'
            ? (peerRaw.bandwidth_overrides as Readonly<Record<string, BandwidthOverride>>)
            : undefined,
      };
      const security: SecurityConfig = {
        secrets_patterns: Array.isArray(securityRaw.secrets_patterns)
          ? (securityRaw.secrets_patterns as Array<{ name: string; pattern: string }>)
          : DEFAULT_SECURITY.secrets_patterns,
      };
      const sessionsRaw = (raw.sessions ?? {}) as Record<string, unknown>;
      const sessions: SessionsConfig = {
        interval_seconds: num(sessionsRaw.interval_seconds, DEFAULT_SESSIONS.interval_seconds),
        retention_days: num(sessionsRaw.retention_days, DEFAULT_SESSIONS.retention_days),
        scan_user_messages: bool(sessionsRaw.scan_user_messages, DEFAULT_SESSIONS.scan_user_messages),
      };

      return okAsync<AppConfig, GraphError>({ daemon, tunnels, peer, security, sessions, raw });
    } catch (e) {
      return errAsync<AppConfig, GraphError>(GE.parseError(path, (e as Error).message));
    }
  });
};

const num = (v: unknown, def: number): number => (typeof v === 'number' ? v : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
const str = (v: unknown, def: string): string => (typeof v === 'string' && v.length > 0 ? v : def);
