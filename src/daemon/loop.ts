/**
 * Daemon loop — runs source ingestion on a schedule.
 *
 * V5 cutover (Phase 24): rooms abstraction removed. The loop now:
 *   1. enumerates all enabled sources from sources.json
 *   2. calls ingestSource for each (sequentially, with mutex
 *      serialization at the indexNode boundary)
 *   3. generates a single global report after the batch
 *   4. sleeps until the next tick
 *
 * PID file at `~/.folklore/daemon.pid` for lifecycle management.
 *
 * The daemon is designed to run as a detached child process forked
 * by `folklore daemon start`. It logs to
 * `~/.folklore/daemon.log` and exits cleanly on SIGTERM.
 *
 * For testability, `runOneTick` is exported separately — tests call
 * it directly without starting the timer.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResultAsync, okAsync } from 'neverthrow';
import type { AppError, ShareError } from '../domain/errors.js';
import { formatError } from '../domain/errors.js';
import type { Source, SourceRun } from '../domain/sources.js';
import { isEnabled, emptyRun } from '../domain/sources.js';
import { ingestSource } from '../application/ingest.js';
import { generateReport, renderReport } from '../application/report.js';
import type { IngestDeps } from '../application/ingest.js';
import type { DaemonConfig } from '../infrastructure/config-loader.js';
import { loadConfig } from '../infrastructure/config-loader.js';
import type { GraphRepository } from '../infrastructure/graph-repository.js';
import type { VectorIndex } from '../infrastructure/vector-index.js';
import type { SourcesConfig } from '../infrastructure/sources-config.js';
import type { Libp2p } from '@libp2p/interface';
import { loadOrCreateIdentity, createNode, dialAndTag } from '../infrastructure/peer-transport.js';
import { startRendezvous, type RendezvousHandle } from '../infrastructure/rendezvous.js';
import { startTrackerRendezvous, type TrackerRendezvousHandle } from '../infrastructure/tracker-rendezvous.js';
import { loadPeers } from '../infrastructure/peer-store.js';
import { writeDaemonStatus } from './status-file.js';
import { buildPatterns } from '../domain/sharing.js';
import { enforceRetention } from '../application/session-ingest.js';
import { refreshHotCache } from '../application/hot-cache-tick.js';
import {
  createShareSyncRegistry,
  registerShareProtocol,
  runShareSyncTick,
  unregisterShareProtocol,
  type ShareSyncRegistry,
} from '../infrastructure/share-sync.js';
import {
  attestMatch,
  createSearchRegistry,
  enrichMatchMeta,
  registerSearchProtocol,
  unregisterSearchProtocol,
  type SearchRegistry,
} from '../infrastructure/search-sync.js';
import {
  registerFetchProtocol,
  unregisterFetchProtocol,
} from '../infrastructure/fetch-sync.js';
import { recordServed } from '../infrastructure/contribution.js';
import {
  registerRecallProtocol,
  unregisterRecallProtocol,
} from '../infrastructure/recall-sync.js';
import {
  createTouchRegistry,
  registerTouchProtocol,
  unregisterTouchProtocol,
  type TouchRegistry,
} from '../infrastructure/touch-protocol.js';
import {
  TOUCH_DEFAULT_RATE_PER_SEC,
  TOUCH_DEFAULT_BURST,
} from '../domain/touch.js';
import {
  subscribeOracle,
  type SubscribeHandle as OracleSubscribeHandle,
} from '../infrastructure/oracle-gossip.js';
import {
  registerSearchGossipResponder,
  registerSwarmSimResponder,
  type SearchGossipResponderHandle,
  type SearchGossipRequest,
  type SearchGossipPeerMatch,
  type SwarmCorpusPeerHit,
} from '../infrastructure/search-gossip.js';
import { readFileSync as nodeReadFileSync, existsSync as nodeExistsSync } from 'node:fs';
import type { Match } from '../domain/vectors.js';
import { runConsolidateTick } from './consolidate-tick.js';
import { runAutoForgetDaemonTick } from './auto-forget-tick.js';
import { tickUpdateCheck, loadUpdateConfig } from '../application/update-checker.js';
import { installUpgrade, readPackageVersion } from '../application/update-installer.js';
import {
  createHealthTracker,
  type HealthTracker,
} from '../infrastructure/connection-health.js';

// ─────────────── types ──────────────────

export interface DaemonDeps {
  readonly ingestDeps: IngestDeps;
  readonly graphs: GraphRepository;
  readonly vectors: VectorIndex;
  readonly sources: SourcesConfig;
  readonly config: DaemonConfig;
  readonly homePath: string;
  readonly shareSync?: ShareSyncRegistry | null;   // Phase 16 — null until libp2p starts
  /** Phase 18: in-memory connection health tracker. Undefined until libp2p starts. */
  readonly healthTracker?: HealthTracker | null;
  /**
   * In-process write serializer. Shared with the daemon's job
   * worker so the tick loop and the queue can't interleave their
   * load → mutate → save sequences and silently lose updates.
   * When omitted, the tick loop runs unsynchronized (legacy
   * behaviour for tests that don't share a Runtime with a worker).
   */
  readonly graphMutex?: import('../infrastructure/async-mutex.js').AsyncMutex;
  /**
   * Fired once the live libp2p node is listening. The daemon
   * supervisor uses this to late-bind the node into the IPC ask
   * handler so `ask --peers` runs on the already-connected node
   * instead of falling back to a full CLI spawn.
   */
  readonly onFederationReady?: (node: Libp2p) => void;
}

/**
 * Result of one daemon tick. V5: rooms collection replaced by a flat
 * list of SourceRun. `reports_written` carries the single global
 * report path (was per-room before).
 */
export interface TickResult {
  readonly sources: readonly SourceRun[];
  readonly reports_written: readonly string[];
}

// ─────────────── PID management ─────────

const pidPath = (homePath: string): string => join(homePath, 'daemon.pid');
const logPath = (homePath: string): string => join(homePath, 'daemon.log');

export const writePid = (homePath: string): void => {
  mkdirSync(homePath, { recursive: true });
  writeFileSync(pidPath(homePath), String(process.pid));
};

export const readPid = (homePath: string): number | null => {
  const p = pidPath(homePath);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8').trim();
  const pid = parseInt(raw, 10);
  return Number.isNaN(pid) ? null : pid;
};

export const removePid = (homePath: string): void => {
  const p = pidPath(homePath);
  if (existsSync(p)) unlinkSync(p);
};

export const isRunning = (homePath: string): boolean => {
  const pid = readPid(homePath);
  if (pid === null) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    // stale PID file — process gone
    removePid(homePath);
    return false;
  }
};

// ─────────────── logging ────────────────

export const daemonLog = (homePath: string, msg: string): void => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(logPath(homePath), line);
  } catch {
    // best-effort
  }
};

// ─────────────── self-update tick ───────────────

/**
 * Self-update stage of the daemon tick. Interval-throttled and config-gated
 * inside tickUpdateCheck — a no-op unless the operator ran
 * `folklore update enable-auto`. Behaviour by verdict:
 *
 *   - not eligible / unavailable → silent (or a single info line)
 *   - eligible, NOT forced       → log "upgrade available", recommend-only
 *   - eligible AND force_upgrade AND auto_install_force consent
 *                                → install now via npm, log a FORCE banner
 *
 * The install is the only place the daemon mutates the host outside its home
 * dir, so the bar is deliberately high: signed force flag (only the project
 * DID can set it) AND local consent (`enable-force`). Never fatal to the tick.
 */
const runUpdateTick = (homePath: string): ResultAsync<void, AppError> =>
  tickUpdateCheck(homePath, readPackageVersion())
    .andThen((res) => {
      if (!res) return okAsync<void, AppError>(undefined);
      if (!res.upgrade_eligible) {
        if (res.upgrade_available) {
          daemonLog(homePath, `update: signature OK but gated (latest=${res.latest_version})`);
        }
        return okAsync<void, AppError>(undefined);
      }
      if (!res.force_upgrade) {
        daemonLog(homePath, `update: upgrade available → folklore@${res.latest_version} (run 'folklore update install')`);
        return okAsync<void, AppError>(undefined);
      }
      // Forced + eligible. Gate on local consent before any install.
      return loadUpdateConfig(homePath).andThen((cfg) => {
        if (!cfg?.auto_install_force) {
          daemonLog(homePath, `update: FORCE release folklore@${res.latest_version} pending — run 'folklore update enable-force' to auto-install, or 'folklore update install' now`);
          return okAsync<void, AppError>(undefined);
        }
        daemonLog(homePath, `update: ⚠ FORCE installing folklore@${res.latest_version} (signed force_upgrade + auto_install_force consent)`);
        return installUpgrade(res.latest_version, {
          tarballUrl: res.manifest?.tarball_url,
          tarballSha256: res.manifest?.tarball_sha256,
        })
          .map((outcome) => {
            daemonLog(homePath, `update: ✓ force-installed folklore@${outcome.installed_version} via ${outcome.command} — restart daemon to run new version`);
          })
          .orElse((e): ResultAsync<void, AppError> => {
            daemonLog(homePath, `update: force-install failed: ${formatError(e)}`);
            return okAsync<void, AppError>(undefined);
          });
      });
    })
    .orElse((e): ResultAsync<void, AppError> => {
      daemonLog(homePath, `update tick error: ${formatError(e)}`);
      return okAsync<void, AppError>(undefined);
    });

// ─────────────── one tick ───────────────

/** Track round-robin position across ticks (V5: now indexes sources, not rooms). */
let roundRobinIndex = 0;

/**
 * Execute one daemon tick. Exported for testability — tests call
 * this directly without starting the timer or writing PID files.
 *
 * V5 cutover (Phase 24): no room dispatch. The tick enumerates all
 * enabled sources flat and runs ingestSource against each. The
 * claude_sessions source is registered via sources.json at init
 * time — no daemon-side room provisioning step.
 */
export const runOneTick = (deps: DaemonDeps): ResultAsync<TickResult, AppError> =>
  deps.sources
    .list()
    .mapErr((e): AppError => e)
    .andThen((descriptors) => {
      const enabled = descriptors.filter(isEnabled);
      const picked = (() => {
        if (enabled.length === 0) return [];
        if (deps.config.round_robin_sources) {
          // V5: round-robin cycles sources (not rooms).
          const next = [enabled[roundRobinIndex % enabled.length]];
          roundRobinIndex++;
          return next;
        }
        return enabled;
      })();
      return runSources(deps, picked);
    })
    .andThen((tickResult) => {
      if (!deps.shareSync) {
        daemonLog(deps.homePath, 'share sync tick: skipped (no registry)');
        return okAsync<TickResult, AppError>(tickResult);
      }
      const peerCount = deps.shareSync.node.getPeers().length;
      daemonLog(
        deps.homePath,
        `share sync tick: starting (connected_peers=${peerCount})`,
      );
      return runShareSyncTick(deps.shareSync)
        .map((sync) => {
          daemonLog(deps.homePath, `share sync tick: opened=${sync.opened}`);
          return tickResult;
        })
        .orElse((e) => {
          daemonLog(deps.homePath, `share sync error: ${formatError(e)}`);
          return okAsync<TickResult, AppError>(tickResult);
        });
    })
    .andThen((tickResult) => {
      // Phase 20 retention pass — prune old session nodes lacking key signals.
      // Load config.yaml for retention_days; fall back to 30 on error.
      return loadConfig(join(deps.homePath, 'config.yaml'))
        .mapErr((e): AppError => e)
        .andThen((cfg) => {
          const retentionDays = cfg.sessions?.retention_days ?? 30;

          // Phase 4.1+ — daemon-tick auto-consolidation. No-op when
          // config.daemon.consolidate.enabled is false (default). When
          // on, spawns detached child processes per configured room.
          // Tick interval is independent of the daemon tick — handled
          // inside runConsolidateTick via the last-run state file.
          try {
            const spawned = runConsolidateTick(
              deps.homePath,
              cfg.daemon.consolidate,
              (msg) => daemonLog(deps.homePath, msg),
            );
            if (spawned > 0) {
              daemonLog(deps.homePath, `consolidate-tick: spawned ${spawned} child process(es)`);
            }
          } catch (e) {
            daemonLog(deps.homePath, `consolidate-tick error: ${(e as Error).message}`);
          }

          // Long-term-memory GC — TTL delete + frozen-band demote. In-process
          // (no LLM, unlike consolidation), best-effort, gated by
          // config.daemon.auto_forget.enabled (default off) and its own cadence.
          return runAutoForgetDaemonTick(
            { graphs: deps.graphs, vectors: deps.vectors },
            deps.homePath,
            cfg.daemon.auto_forget,
            (msg) => daemonLog(deps.homePath, msg),
          )
            .andThen(() => enforceRetention({ graphs: deps.graphs }, retentionDays))
            .map((dropped) => {
              if (dropped > 0) {
                daemonLog(
                  deps.homePath,
                  `retention: dropped ${dropped} session nodes older than ${retentionDays} days`,
                );
              }
              return tickResult;
            })
            .orElse((e): ResultAsync<TickResult, AppError> => {
              daemonLog(deps.homePath, `retention error: ${formatError(e)}`);
              return okAsync<TickResult, AppError>(tickResult);
            });
        })
        .orElse((e): ResultAsync<TickResult, AppError> => {
          daemonLog(deps.homePath, `retention config error: ${formatError(e)}`);
          return okAsync<TickResult, AppError>(tickResult);
        });
    })
    .andThen((tickResult) => {
      // Phase 32 — refresh the hot cache after every tick so Claude
      // sessions starting between ticks always see a current recency
      // digest. Failures are logged, never fatal to the tick chain.
      return refreshHotCache(deps.graphs, deps.homePath)
        .map(() => tickResult)
        .orElse((e): ResultAsync<TickResult, AppError> => {
          daemonLog(deps.homePath, `hot cache error: ${formatError(e)}`);
          return okAsync<TickResult, AppError>(tickResult);
        });
    })
    .andThen((tickResult) =>
      // Self-update check. Interval-throttled inside tickUpdateCheck (no-op
      // unless auto_check_enabled and the interval has elapsed). On a signed,
      // eligible force_upgrade AND operator consent (auto_install_force), the
      // daemon installs without confirmation — the whole point of "force
      // push". Otherwise it only logs availability. All failures are
      // non-fatal to the tick.
      runUpdateTick(deps.homePath).map(() => tickResult),
    );

/**
 * V5 per-source tick. Hydrates each descriptor via the source
 * registry, calls ingestSource, captures the SourceRun (or a
 * synthesised failed run on hydration error). Writes a single
 * global report after the batch.
 *
 * Sequential at the source level for predictable tick output;
 * per-item graph mutations are serialized at a finer granularity
 * by indexChunksFor's mutex (when graphMutex is in ingestDeps).
 */
const runSources = (
  deps: DaemonDeps,
  descriptors: readonly import('../domain/sources.js').SourceDescriptor[],
): ResultAsync<TickResult, AppError> => {
  const results: SourceRun[] = [];
  const reports: string[] = [];

  const { sources: live, errors } = deps.ingestDeps.registry.buildAll(descriptors);

  // V5: emit a tick-plan audit line and iterate sources flat (no
  // per-room dispatch). The for...of below is also the
  // acceptance-grep anchor for the rooms-deletion plan.
  for (const source of live) {
    daemonLog(deps.homePath, `tick-plan: source=${source.descriptor.id}`);
  }

  // Hydration failures become synthetic failed SourceRuns so the
  // tick log surfaces them.
  for (const e of errors) {
    results.push({ ...emptyRun(descriptors[0] ?? { id: '<unknown>', kind: 'generic_rss', enabled: true, config: {} }), error: e });
  }

  return live
    .reduce<ResultAsync<void, AppError>>(
      (acc: ResultAsync<void, AppError>, source: Source) =>
        acc.andThen(() =>
          ingestSource(deps.ingestDeps)(source)
            .map((run) => {
              results.push(run);
              daemonLog(
                deps.homePath,
                `tick: source=${source.descriptor.id} new=${run.items_new}`,
              );
            })
            .orElse((e) => {
              results.push({ ...emptyRun(source.descriptor), error: e });
              daemonLog(
                deps.homePath,
                `error: source=${source.descriptor.id} ${formatError(e)}`,
              );
              return okAsync<void, AppError>(undefined);
            }),
        ),
      okAsync<void, AppError>(undefined),
    )
    .andThen(() =>
      generateReport({
        graphs: deps.graphs,
        vectors: deps.vectors,
        sources: deps.sources,
      })({}),
    )
    .map((data) => {
      const md = renderReport(data);
      const reportDir = join(deps.homePath, 'reports');
      mkdirSync(reportDir, { recursive: true });
      const date = data.generated_at.slice(0, 10);
      const path = join(reportDir, `${date}.md`);
      writeFileSync(path, md);
      reports.push(path);
      daemonLog(deps.homePath, `report: ${path}`);
      return { sources: results, reports_written: reports };
    })
    .orElse((e) => {
      daemonLog(deps.homePath, `report error: ${formatError(e)}`);
      return okAsync<TickResult, AppError>({ sources: results, reports_written: reports });
    });
};

// ─────────────── loop ───────────────────

/**
 * Loop handle returned by `startLoop`.
 *
 * Surface chosen by the multi-LLM round-2 review (`daemon.ts:202` +
 * `loop.ts:574`): two SIGTERM handlers fighting over the same process
 * is a real race — one calls `process.exit(0)` mid-flight while the
 * other is still flushing the IPC server / write lock / runtime. The
 * loop now exposes its libp2p teardown as a callback that the
 * daemon-supervisor in `cli/commands/daemon.ts` orchestrates from one
 * place, in one order.
 */
export interface LoopHandle {
  /**
   * Tear down protocols + libp2p node started by the loop. Idempotent.
   * Does NOT call process.exit and does NOT remove the PID file —
   * those belong to the daemon supervisor that owns the process.
   */
  readonly cleanup: () => Promise<void>;
}

/**
 * Start the daemon loop. Returns once the loop is wired (PID written,
 * libp2p protocols registered, ticker scheduled). Process keep-alive
 * is the supervisor's job: this function does not block forever and
 * does not register signal handlers (was a dual-handler race with
 * the daemon supervisor before the round-2 cleanup).
 */
export const startLoop = async (deps: DaemonDeps): Promise<LoopHandle> => {
  writePid(deps.homePath);
  daemonLog(deps.homePath, `daemon started (pid=${process.pid}, interval=${deps.config.interval_seconds}s)`);

  // ───── Phase 16: optional libp2p + share sync bootstrap ─────
  // Only start a libp2p node if the user has already created an identity
  // (i.e. they have run `folklore peer status` or `peer add` at least once).
  // This keeps the daemon's network footprint zero for users who never use P2P.
  let liveNode: Libp2p | null = null;
  let liveRendezvous: RendezvousHandle | null = null; // DISC-04 — public-DHT discovery loop
  let liveTrackerRendezvous: TrackerRendezvousHandle | null = null; // HTTP-tracker discovery loop
  let liveSync: ShareSyncRegistry | null = null;
  let liveSearch: SearchRegistry | null = null; // Phase 17
  let liveTouch: TouchRegistry | null = null; // Phase 31
  let liveOracle: OracleSubscribeHandle | null = null; // Phase 39 — pubsub
  let liveSearchGossip: SearchGossipResponderHandle | null = null; // P2P-scale phase 1
  let liveSwarmSim: SearchGossipResponderHandle | null = null; // P2P-scale phase 3
  let liveHealthTracker: HealthTracker | null = null; // Phase 18
  const identityPath = join(deps.homePath, 'peer-identity.json');
  if (!existsSync(identityPath)) {
    // Deliberate: zero network footprint until the user opts into P2P.
    // But say so — a silent skip reads as a broken daemon when a user
    // starts the daemon first and runs `peer status` second (the
    // identity then exists, but libp2p only starts on the NEXT boot).
    daemonLog(
      deps.homePath,
      'p2p disabled: no peer identity yet. Run `folklore peer status` (creates one), then `folklore daemon stop && folklore daemon start`.',
    );
  }
  if (existsSync(identityPath)) {
    try {
      const cfgPath = join(deps.homePath, 'config.yaml');
      const cfgRes = await loadConfig(cfgPath);
      if (cfgRes.isErr()) {
        daemonLog(deps.homePath, `share sync skipped — config: ${formatError(cfgRes.error)}`);
      } else {
        const idRes = await loadOrCreateIdentity(identityPath);
        if (idRes.isErr()) {
          daemonLog(deps.homePath, `share sync skipped — identity: ${formatError(idRes.error)}`);
        } else {
          const nodeRes = await createNode(idRes.value, {
            listenPort: cfgRes.value.peer.port,
            listenHost: cfgRes.value.peer.listen_host,
            mdns: cfgRes.value.peer.mdns,
            dhtEnabled: cfgRes.value.peer.dht.enabled,
            dhtServer: cfgRes.value.peer.dht.server, // seeds serve the routing table
            dhtPublic: cfgRes.value.peer.dht.public, // DISC-04 — join public IPFS Amino DHT
            bootstrapPeers: cfgRes.value.peer.dht.bootstrap_peers, // WAN seed discovery
            peersPath: join(deps.homePath, 'peers.json'), // enables peer:discovery persistence
            relays: cfgRes.value.peer.relays,
            relayServer: cfgRes.value.peer.relay_server, // dedicated public relay node
            upnp: cfgRes.value.peer.upnp,
          });
          if (nodeRes.isErr()) {
            daemonLog(deps.homePath, `share sync skipped — libp2p: ${formatError(nodeRes.error)}`);
          } else {
            liveNode = nodeRes.value;

            // Surface dialable addresses — without this, a peer on
            // another machine has no way to learn what to `peer add`.
            // Logged AND persisted so `folklore peer status` can print
            // them while the daemon runs. Re-persisted on every
            // self:peer:update because a circuit-relay reservation lands
            // ASYNC after startup (~2s) — the initial snapshot would miss
            // the /p2p-circuit address a NAT'd node must advertise.
            const node = liveNode;
            const writeP2pAddrs = (): void => {
              const addrs = node.getMultiaddrs().map((a) => a.toString());
              try {
                writeFileSync(
                  join(deps.homePath, 'p2p-addrs.json'),
                  JSON.stringify({ peer_id: idRes.value.peerId.toString(), addrs, written_at: new Date().toISOString() }, null, 2),
                );
              } catch { /* non-fatal — log already has the addrs */ }
            };
            for (const addr of node.getMultiaddrs().map((a) => a.toString())) {
              daemonLog(deps.homePath, `p2p listening: ${addr}`);
            }
            writeP2pAddrs();
            // libp2p fires this when our own address set changes (relay
            // reservation granted/lost, UPnP mapping, new listener).
            node.addEventListener('self:peer:update', () => {
              writeP2pAddrs();
            });

            try { deps.onFederationReady?.(liveNode); } catch { /* observer must not break startup */ }

            // Continuous peer discovery via the rendezvous CID. Runs on the
            // public IPFS Amino DHT when opted in (DISC-04, zero-infra), OR on
            // the self-sovereign /folklore/kad/ DHT once it has a seed to route
            // through (bootstrap_peers set). The loop searches FAST while
            // peerless and relaxes once connected. No-op only when the DHT is
            // fully off or private with no seed (nothing to route through).
            const dht = cfgRes.value.peer.dht;
            const discoveryOn = dht.public || (dht.enabled && dht.bootstrap_peers.length > 0);
            if (discoveryOn) {
              liveRendezvous = startRendezvous({
                // services typing on Libp2p is opaque; the rendezvous only needs
                // the structural dht slice it declares.
                node: liveNode as unknown as Parameters<typeof startRendezvous>[0]['node'],
                log: (m) => daemonLog(deps.homePath, m),
              });
              daemonLog(
                deps.homePath,
                `rendezvous: continuous peer discovery started (${dht.public ? 'public IPFS DHT' : 'self-sovereign DHT + bootstrap'})`,
              );
            }

            // HTTP-tracker discovery (BitTorrent-tracker model) — the DEFAULT
            // WAN path. Announces our dial addrs + dials discovered peers on an
            // interval. Cheap and fast (one HTTPS round trip) vs the public DHT.
            // No-op when peer.tracker.url is empty.
            const tracker = cfgRes.value.peer.tracker;
            if (tracker.url && tracker.url.length > 0) {
              liveTrackerRendezvous = startTrackerRendezvous({
                node: liveNode as unknown as Parameters<typeof startTrackerRendezvous>[0]['node'],
                trackerUrl: tracker.url,
                namespace: tracker.namespace,
                log: (m) => daemonLog(deps.homePath, m),
              });
              daemonLog(
                deps.homePath,
                `tracker: discovery started (${tracker.url}, ns=${tracker.namespace})`,
              );
            }

            // P2P-scale phase 3 — swarm-sim responder. Lifted out
            // of the share-sync block so it fires the moment libp2p
            // is up, regardless of peer connectivity. If a swarm
            // corpus exists in this daemon's home, this responder
            // publishes synthetic gossip responses on behalf of
            // every virtual peer in the corpus. One physical daemon,
            // N attributed responses on the wire.
            try {
              const swarmCorpusPath = `${deps.homePath}/swarm-corpus.jsonl`;
              if (nodeExistsSync(swarmCorpusPath)) {
                const lines = nodeReadFileSync(swarmCorpusPath, 'utf8').split('\n').filter(Boolean);
                const corpusNotes = lines.slice(1).map((l: string) => JSON.parse(l)) as ReadonlyArray<{
                  id: string; label: string; summary: string;
                  source_uri: string; fetched_at: string;
                  peer_id: string;
                  embedding?: ReadonlyArray<number>;
                }>;
                if (corpusNotes.length > 0) {
                  const distinctPeers = new Set(corpusNotes.map((n) => n.peer_id)).size;
                  const embeddedCount = corpusNotes.filter((n) => Array.isArray(n.embedding)).length;
                  daemonLog(deps.homePath, `swarm-sim corpus loaded: ${corpusNotes.length} notes across ${distinctPeers} virtual peers (${embeddedCount} embedded)`);
                  // Pre-convert each note's embedding to Float32Array once
                  // so cosine-distance per request is just a dot product
                  // and norm divides.
                  const corpusEmb = corpusNotes.map((n) => {
                    if (!Array.isArray(n.embedding)) {
                      return { note: n, vec: null as Float32Array | null, norm: 0 };
                    }
                    const vec = Float32Array.from(n.embedding);
                    let ss = 0;
                    for (let i = 0; i < vec.length; i++) ss += vec[i] * vec[i];
                    return { note: n, vec, norm: Math.sqrt(ss) };
                  });
                  const findSwarmHits = async (
                    req: SearchGossipRequest,
                  ): Promise<ReadonlyArray<SwarmCorpusPeerHit>> => {
                    const reqVec = Float32Array.from(req.embedding);
                    let reqNormSq = 0;
                    for (let i = 0; i < reqVec.length; i++) reqNormSq += reqVec[i] * reqVec[i];
                    const reqNorm = Math.sqrt(reqNormSq);
                    // Cosine-distance ranking when both sides carry
                    // embeddings. Fallback: uniform-ish noise for the
                    // few notes that didn't embed at corpus-gen time.
                    const scored = corpusEmb.map(({ note, vec, norm }) => {
                      if (!vec || vec.length !== reqVec.length || reqNorm === 0 || norm === 0) {
                        return { note, distance: 0.95 + Math.random() * 0.05 };
                      }
                      let dot = 0;
                      for (let i = 0; i < vec.length; i++) dot += vec[i] * reqVec[i];
                      const cosine = dot / (norm * reqNorm);
                      const distance = Math.max(0, 1 - cosine);
                      return { note, distance };
                    });
                    // Sort ascending (closest first), cap at 200 to
                    // bound the per-request publish burst.
                    scored.sort((a, b) => a.distance - b.distance);
                    const cap = Math.min(scored.length, 200);
                    return scored.slice(0, cap).map(({ note, distance }) => ({
                      node_id: note.id,
                      distance,
                      peer_id: note.peer_id,
                      summary: note.summary,
                      label: note.label,
                      source_uri: note.source_uri,
                    }));
                  };
                  const swarmSub = await registerSwarmSimResponder(
                    liveNode,
                    { findHits: findSwarmHits },
                    (msg) => daemonLog(deps.homePath, msg),
                  );
                  if (swarmSub.isErr()) {
                    daemonLog(deps.homePath, `swarm-sim register failed: ${formatError(swarmSub.error)}`);
                  } else {
                    liveSwarmSim = swarmSub.value;
                    daemonLog(deps.homePath, `swarm-sim subscribed: ${distinctPeers} virtual peers active`);
                  }
                }
              }
            } catch (e) {
              daemonLog(deps.homePath, `swarm-sim bootstrap threw: ${(e as Error).message}`);
            }

            // ── Phase 18: connection health tracker ──────────────────────────
            // Create the in-memory tracker and register the connection:close
            // listener. Pitfall 7: relay-TTL expiry fires connection:close with
            // conn.limits !== undefined — these are EXPECTED closures, NOT
            // genuine disconnects. Log as audit-only; do NOT mark degraded.
            liveHealthTracker = createHealthTracker();
            const healthTracker = liveHealthTracker;  // non-null ref for closure
            liveNode.addEventListener('connection:close', (evt) => {
              const conn = evt.detail;
              const peerId = conn.remotePeer.toString();
              if (conn.limits !== undefined) {
                // Relay TTL expiry — expected, not a genuine disconnect.
                // Pitfall 7: conn.limits is set on relay-with-TTL closures.
                // Log as audit-only; do NOT call recordDisconnect here.
                daemonLog(deps.homePath, `relay TTL expiry for ${peerId} (limits set, not marking degraded)`);
                return;
              }
              healthTracker.recordDisconnect(peerId);
              daemonLog(deps.homePath, `connection:close peer=${peerId}`);
            });
            daemonLog(deps.homePath, 'connection health tracker registered');

            // ── Phase 18: relay pre-dial ──────────────────────────────────────
            // Best-effort dial of each configured relay multiaddr. Failures are
            // logged but never crash the daemon — relay is an optional transport.
            if (cfgRes.value.peer.relays.length > 0) {
              for (const relayAddr of cfgRes.value.peer.relays) {
                try {
                  await dialAndTag(liveNode, relayAddr);
                  daemonLog(deps.homePath, `relay pre-dial ok: ${relayAddr}`);
                } catch (e) {
                  daemonLog(deps.homePath, `relay pre-dial failed (non-fatal): ${relayAddr} — ${(e as Error).message}`);
                }
              }
            }

            // Best-effort dial of every known peer so streams open on first tick.
            const peersRes = await loadPeers(join(deps.homePath, 'peers.json'));
            if (peersRes.isOk()) {
              for (const p of peersRes.value.peers) {
                for (const addr of p.addrs) {
                  try {
                    await dialAndTag(liveNode, addr);
                    daemonLog(deps.homePath, `dialed peer ${p.id} via ${addr}`);
                    break;  // one successful addr is enough
                  } catch {
                    // continue to next addr
                  }
                }
              }
            }
            liveSync = createShareSyncRegistry({
              node: liveNode,
              homePath: deps.homePath,
              graphRepo: deps.graphs,
              patterns: buildPatterns(cfgRes.value.security.secrets_patterns),
              maxUpdatesPerSecPerPeer:
                cfgRes.value.peer.bandwidth.max_updates_per_sec_per_peer,
            });
            const reg = await registerShareProtocol(liveSync);
            if (reg.isErr()) {
              daemonLog(deps.homePath, `share sync register failed: ${formatError(reg.error)}`);
              liveSync = null;
            } else {
              daemonLog(deps.homePath, `share sync registered: /folklore/share/1.0.0`);

              // P2P-sync bug fix: the daemon's main-tick share sync cadence is
              // tied to research-tick interval (daily by default), which leaves
              // new connections unsynced for up to 24 hours. Two complementary
              // triggers close the gap:
              //   1. Immediate tick right after registration — covers peers
              //      dialed during startup.
              //   2. Reactive tick on every connection:open — covers inbound
              //      peer connections, reconnects, and late-discovered peers.
              const syncRegistry = liveSync;
              void runShareSyncTick(syncRegistry)
                .map((sync) => {
                  daemonLog(
                    deps.homePath,
                    `share sync tick (startup): opened=${sync.opened}`,
                  );
                  return undefined;
                })
                .orElse((e) => {
                  daemonLog(
                    deps.homePath,
                    `share sync tick (startup) error: ${formatError(e)}`,
                  );
                  return okAsync<undefined, ShareError>(undefined);
                });

              liveNode.addEventListener('connection:open', (evt) => {
                const conn = evt.detail;
                const peerId = conn.remotePeer.toString();
                daemonLog(
                  deps.homePath,
                  `connection:open peer=${peerId} — triggering share sync tick`,
                );
                void runShareSyncTick(syncRegistry)
                  .map((sync) => {
                    daemonLog(
                      deps.homePath,
                      `share sync tick (on-connect): opened=${sync.opened}`,
                    );
                    return undefined;
                  })
                  .orElse((e) => {
                    daemonLog(
                      deps.homePath,
                      `share sync tick (on-connect) error: ${formatError(e)}`,
                    );
                    return okAsync<undefined, ShareError>(undefined);
                  });
              });
            }

            // Phase 17: register federated search protocol alongside share protocol.
            // Uses the SAME live libp2p node — separate protocol lifecycles per CONTEXT.md
            // locked decision, but one libp2p node hosts both. Independent of share success.
            // 32-byte seed for per-match attestation — the peer key's
            // raw layout is [0..32) seed, [32..64) public key.
            const signSeed = idRes.value.privateKey.raw.slice(0, 32);
            liveSearch = createSearchRegistry(
              liveNode,
              deps.homePath,
              deps.vectors,
              cfgRes.value.peer.search_rate_limit.rate_per_sec,
              cfgRes.value.peer.search_rate_limit.burst,
              async () => {
                const r = await deps.graphs.load();
                return r.isOk() ? r.value : null;
              },
              cfgRes.value.security.secrets_patterns,
              signSeed,
            );
            const searchReg = await registerSearchProtocol(liveSearch);
            if (searchReg.isErr()) {
              daemonLog(deps.homePath, `search protocol register failed: ${formatError(searchReg.error)}`);
              liveSearch = null;
            } else {
              daemonLog(deps.homePath, `search protocol registered: /folklore/search/1.0.0`);
            }

            // Register entity-recall protocol — sibling to search.
            // Re-loads the graph snapshot per request so updates flow.
            try {
              registerRecallProtocol({
                node: liveNode,
                getGraph: async () => {
                  const r = await deps.graphs.load();
                  return r.isOk() ? r.value : null;
                },
                log: (m) => daemonLog(deps.homePath, m),
              });
              daemonLog(deps.homePath, `recall protocol registered: /folklore/recall/1.0.0`);
            } catch (e) {
              daemonLog(deps.homePath, `recall protocol register failed: ${(e as Error).message}`);
            }

            // Fetch protocol — targeted node-body pull so federated
            // search hits become injectable + cacheable on the asker.
            try {
              registerFetchProtocol({
                node: liveNode,
                getGraph: async () => {
                  const r = await deps.graphs.load();
                  return r.isOk() ? r.value : null;
                },
                secretsPatterns: buildPatterns(cfgRes.value.security.secrets_patterns),
                signSeed,
                log: (m) => daemonLog(deps.homePath, m),
                onServed: (peer, count, nodeIds) => recordServed(deps.homePath, { peer, kind: 'fetch', count, nodes: nodeIds }),
              });
              daemonLog(deps.homePath, `fetch protocol registered: /folklore/fetch/1.0.0`);
            } catch (e) {
              daemonLog(deps.homePath, `fetch protocol register failed: ${(e as Error).message}`);
            }

            // Phase 31: register asymmetric touch protocol — one-shot pull
            // of a remote peer's shared-room graph with pre-transmission
            // redaction via secret-gate. Separate registry, shared libp2p
            // node, stricter rate limit than search (touch is heavier).
            liveTouch = createTouchRegistry(
              liveNode,
              deps.homePath,
              deps.graphs,
              TOUCH_DEFAULT_RATE_PER_SEC,
              TOUCH_DEFAULT_BURST,
              cfgRes.value.security.secrets_patterns,
            );
            const touchReg = await registerTouchProtocol(liveTouch);
            if (touchReg.isErr()) {
              daemonLog(deps.homePath, `touch protocol register failed: ${formatError(touchReg.error)}`);
              liveTouch = null;
            } else {
              daemonLog(deps.homePath, `touch protocol registered: /folklore/touch/1.0.0`);
            }

            // Phase 39 — Layer B oracle pubsub. Subscribe to the
            // /folklore/oracle/1.0.0 topic so inbound questions and
            // answers from connected peers land in the local graph in
            // real-time (seconds, not minutes). Upserts run through the
            // same remote-node-validator as touch, so the trust boundary
            // stays identical. Subscribe is fire-and-forget: a failure
            // to subscribe is logged and the daemon keeps running on
            // Layer A (touch + CRDT) alone.
            const oracleSub = await subscribeOracle(liveNode, {
              graphRepo: deps.graphs,
              onAccepted: (msg, fromPeer) => {
                daemonLog(deps.homePath, `oracle inbound ${msg.kind} from peer=${fromPeer} id=${msg.node.id}`);
              },
              onRejected: (reason, fromPeer) => {
                daemonLog(deps.homePath, `oracle rejected from peer=${fromPeer} reason=${reason}`);
              },
            });
            if (oracleSub.isErr()) {
              daemonLog(deps.homePath, `oracle subscribe failed (Layer B disabled): ${formatError(oracleSub.error)}`);
            } else {
              liveOracle = oracleSub.value;
              daemonLog(deps.homePath, `oracle pubsub subscribed: /folklore/oracle/1.0.0`);
            }

            // P2P-scale phase 1 — federated search over pubsub. Replaces
            // the per-peer dialProtocol fan-out with a single publish +
            // collect. The responder subscribes to the request topic and
            // serves local-graph queries from the same VectorIndex the
            // dial-based search registry uses; trust boundary is identical
            // because both paths flow through search-sync.ts's response
            // shape.
            const localNodeForGossip = liveNode;
            const vectorsForGossip = deps.vectors;
            const gossipSub = await registerSearchGossipResponder(
              localNodeForGossip,
              {
                runLocalQuery: async (req: SearchGossipRequest):
                  Promise<ReadonlyArray<SearchGossipPeerMatch>> => {
                  const embedding = Float32Array.from(req.embedding);
                  const selfPeer = localNodeForGossip.peerId.toString();
                  // V5 cutover: no room dispatch. Federated search runs
                  // against the global graph; the request's workspace
                  // filter (if any) is applied client-side after the
                  // peer hit lands.
                  const res = await vectorsForGossip.searchGlobal(embedding, req.k);
                  if (res.isErr()) return [];
                  // Same provenance enrichment as the dial responder —
                  // label/source_uri/fetched_at drive the asker's
                  // freshness + satisfaction scoring.
                  const graphRes = await deps.graphs.load();
                  const gossipGraph = graphRes.isOk() ? graphRes.value : null;
                  const gossipPatterns = buildPatterns(cfgRes.value.security.secrets_patterns);
                  const signedAt = new Date().toISOString();
                  return res.value.map((m: Match): SearchGossipPeerMatch => {
                    const meta = enrichMatchMeta(gossipGraph, gossipPatterns, m.node_id);
                    return {
                      node_id: m.node_id,
                      wing: m.wing,
                      distance: m.distance,
                      ...meta,
                      ...attestMatch(signSeed, { node_id: m.node_id, ...meta }, signedAt),
                      _source_peer: selfPeer,
                    };
                  });
                },
              },
              (msg) => daemonLog(deps.homePath, msg),
            );
            if (gossipSub.isErr()) {
              daemonLog(deps.homePath, `search-gossip register failed: ${formatError(gossipSub.error)}`);
            } else {
              liveSearchGossip = gossipSub.value;
              daemonLog(deps.homePath, `search-gossip subscribed: /folklore/search/1.0.0`);
            }

            // P2P-scale phase 3 — swarm-sim registration was lifted
            // higher up (right after liveNode init) so it fires
            // regardless of share-sync state. Nothing to do here.
          }
        }
      }
    } catch (e) {
      daemonLog(deps.homePath, `share sync bootstrap threw: ${(e as Error).message}`);
    }
  }

  // Splice the live registry and health tracker into deps so runOneTick sees them.
  const tickDeps: DaemonDeps = { ...deps, shareSync: liveSync, healthTracker: liveHealthTracker };

  // ───── status heartbeat — daemon-status.json for UI surfaces ─────
  // The research tick can be hours apart; the desktop app polls every few
  // seconds. A separate cheap heartbeat keeps "running · N peers" honest.
  const startedAt = new Date().toISOString();
  const heartbeat = (): void => {
    writeDaemonStatus(deps.homePath, {
      pid: process.pid,
      started_at: startedAt,
      p2p: liveNode !== null,
      connected_peers: liveNode ? liveNode.getPeers().length : 0,
    });
  };
  heartbeat();
  const statusInterval = setInterval(heartbeat, 30_000);
  statusInterval.unref();

  // Run immediately on start
  await runOneTick(tickDeps);

  // Then schedule. runOneTick handles its own failures (Result-based
  // internals); void keeps the timer callback synchronous.
  const interval = setInterval(() => {
    void runOneTick(tickDeps);
  }, deps.config.interval_seconds * 1000);
  // Allow the supervisor to drive process lifetime — we don't pin the
  // event loop on this timer.
  interval.unref();

  // Cleanup: libp2p side only. PID-file removal, runtime close, and
  // the actual process.exit live in the daemon supervisor (see
  // cli/commands/daemon.ts) so shutdown is single-owner.
  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { clearInterval(interval); } catch { /* benign */ }
    try { clearInterval(statusInterval); } catch { /* benign */ }
    if (liveRendezvous) {
      try { liveRendezvous.stop(); } catch { /* benign */ }
    }
    if (liveTrackerRendezvous) {
      try { liveTrackerRendezvous.stop(); } catch { /* benign */ }
    }
    // Cleanup order: rendezvous → oracle pubsub → search-gossip → touch → search → share → node.stop
    if (liveOracle) {
      try { liveOracle.unsubscribe(); } catch { /* benign */ }
    }
    if (liveSearchGossip) {
      try { liveSearchGossip.unsubscribe(); } catch { /* benign */ }
    }
    if (liveSwarmSim) {
      try { liveSwarmSim.unsubscribe(); } catch { /* benign */ }
    }
    if (liveTouch) {
      try { await unregisterTouchProtocol(liveTouch); } catch { /* benign */ }
    }
    if (liveSearch) {
      try { await unregisterSearchProtocol(liveSearch); } catch { /* benign */ }
    }
    if (liveNode) {
      try { await unregisterRecallProtocol(liveNode); } catch { /* benign */ }
      try { await unregisterFetchProtocol(liveNode); } catch { /* benign */ }
    }
    if (liveSync) {
      try { await unregisterShareProtocol(liveSync); } catch { /* benign */ }
    }
    if (liveNode) {
      try { await liveNode.stop(); } catch { /* benign */ }
    }
  };

  return { cleanup };
};
