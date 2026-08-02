/**
 * `folklore daemon <sub>` — background research daemon.
 *
 *   start   — fork a detached child that runs the daemon loop
 *   stop    — send SIGTERM to the PID in daemon.pid
 *   status  — show whether the daemon is running + last log lines
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatError } from '../../domain/errors.js';
import { loadConfig } from '../../infrastructure/config-loader.js';
import { isRunning, readPid, removePid, startLoop, daemonLog, type LoopHandle } from '../../daemon/loop.js';
import { defaultRuntime, runtimePaths } from '../runtime.js';
import { startIpcServer } from '../../daemon/ipc.js';
import { buildIpcHandlers, type FederationRef } from '../../daemon/ipc-handlers.js';
import { acquireLock } from '../../infrastructure/process-lock.js';
import { startJobQueue } from '../../daemon/job-queue.js';
import { buildJobRunner } from '../../daemon/job-runner.js';
import { startFileWatchers } from '../../daemon/file-watcher.js';

const start = async (): Promise<number> => {
  const paths = runtimePaths();
  if (isRunning(paths.home)) {
    const pid = readPid(paths.home);
    console.log(`daemon is already running (pid=${pid})`);
    return 0;
  }

  // Fork a detached child that runs the daemon loop. The entry is
  // resolved relative to THIS compiled module (dist/cli/commands/
  // daemon.js → dist/cli/index.js), never process.cwd() — a globally
  // installed CLI is invoked from arbitrary directories.
  const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
  const child = spawn(
    process.execPath,
    [cliEntry, 'daemon', '_run'],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    },
  );
  child.unref();

  // Poll for the PID file before returning — closes the race where
  // 'daemon started' prints but the child hasn't yet acquired the
  // write lock + opened sqlite-vec + loaded ONNX. Without this, an
  // immediately-following CLI command (jobs list / this) sees
  // isRunning() === false during the gap and either errors or
  // falls back to the synchronous path that fights the booting
  // daemon for the same write lock.
  //
  // Cap at 5s — covers cold-load on slow machines without making
  // failed boots invisible. Bail without error if the file appears.
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (isRunning(paths.home)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!isRunning(paths.home)) {
    console.error(`daemon spawn returned but PID file not visible after 5s — check ${join(paths.home, 'daemon.log')}`);
    return 1;
  }
  const pid = readPid(paths.home);
  console.log(`daemon started (pid=${pid})`);
  console.log(`  logs: ${join(paths.home, 'daemon.log')}`);
  return 0;
};

const stop = async (): Promise<number> => {
  const paths = runtimePaths();
  const pid = readPid(paths.home);
  if (pid === null) {
    console.log('daemon is not running (no PID file)');
    return 0;
  }
  if (!isRunning(paths.home)) {
    console.log(`daemon is not running (stale PID ${pid}, cleaned up)`);
    return 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`sent SIGTERM to pid ${pid}`);
  } catch (e) {
    console.error(`failed to stop daemon: ${(e as Error).message}`);
    return 1;
  }
  removePid(paths.home);
  return 0;
};

const status = async (): Promise<number> => {
  const paths = runtimePaths();
  const pid = readPid(paths.home);
  const running = isRunning(paths.home);
  console.log(`daemon: ${running ? 'running' : 'stopped'}${pid !== null ? ` (pid=${pid})` : ''}`);

  const logFile = join(paths.home, 'daemon.log');
  if (existsSync(logFile)) {
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    const recent = lines.slice(-5);
    console.log('\nrecent log:');
    for (const l of recent) console.log(`  ${l}`);
  }
  return 0;
};

/**
 * Internal entrypoint — called by the forked child process. This
 * runs the actual loop; the parent exits immediately after forking.
 */
const run = async (): Promise<number> => {
  const paths = runtimePaths();
  const configPath = join(paths.home, 'config.yaml');
  const cfg = await loadConfig(configPath);
  if (cfg.isErr()) {
    console.error(`daemon: ${formatError(cfg.error)}`);
    return 1;
  }

  // Phase 4.1 — acquire the cross-process write lock at daemon startup.
  // The daemon holds it for its entire lifetime; refresh every 20s so
  // the staleness window (default 60s) doesn't reap us. Mutating CLI
  // commands (consolidate, etc.) wait on this lock instead of erroring.
  const lockRes = await acquireLock(paths.home, {
    owner: 'daemon',
    waitMs: 5_000,
    pollIntervalMs: 200,
    staleAfterMs: 60_000,
  });
  if (lockRes.isErr()) {
    console.error(`daemon: ${formatError(lockRes.error)}`);
    console.error(`  another folklore process is already mutating. retry in a moment.`);
    return 1;
  }
  const writeLock = lockRes.value;
  const refreshTimer = setInterval(() => {
    void writeLock.refresh().catch(() => { /* best-effort */ });
  }, 20_000);
  // Don't keep the event loop alive on the refresh timer alone — the
  // daemon's own loop owns liveness.
  refreshTimer.unref();

  const rt = await defaultRuntime();
  if (rt.isErr()) {
    console.error(`daemon: ${formatError(rt.error)}`);
    clearInterval(refreshTimer);
    await writeLock.release();
    return 1;
  }

  // Phase 41 — background job queue. Owned by the daemon for its
  // lifetime; CLI commands (trigger, this, file-watcher events,
  // session-watcher events) submit work over IPC instead of running
  // synchronously. Single worker, FIFO, persisted to jobs.json.
  const jobRunner = buildJobRunner({ runtime: rt.value });
  const jobQueue = startJobQueue({
    homePath: paths.home,
    runner: jobRunner,
    onChange: (j) => {
      // The daemon process was spawned with stdio: 'ignore' — plain
      // console.log vanishes. Use daemonLog so operators tailing
      // daemon.log see job state transitions live.
      daemonLog(
        paths.home,
        `job ${j.status.padEnd(7)} ${j.id}  ${j.kind} ${j.result_summary ?? j.error ?? ''}`,
      );
    },
  });

  // Phase 41 — file-watcher (registered roots from `folklore this`)
  // and Claude session-watcher. Both submit ingest jobs to the queue
  // on file events; debounced so editor save bursts collapse.
  const watchers = startFileWatchers({
    homePath: paths.home,
    queue: jobQueue,
    log: (line) => daemonLog(paths.home, line),
  });

  // Phase 1 (v4 plan) — IPC server for delegated queries. Lives alongside
  // the tick loop in the same process so read-only commands like `ask`
  // can reuse the warmed Runtime (sqlite-vec open + ONNX model loaded)
  // instead of paying ~240 ms of cold-start per invocation. Socket at
  // $FOLKLORE_HOME/daemon.sock, 0600.
  // Late-binding federation holder — filled by the loop once libp2p
  // is listening, read by the IPC ask handler for `ask --peers`.
  const federation: FederationRef = { current: null };

  const ipc = await startIpcServer({
    homeDir: paths.home,
    ctx: rt.value,
    handlers: buildIpcHandlers(jobQueue, federation),
    onError: (m) => console.error(`daemon ipc: ${m}`),
  });
  console.log(`daemon: ipc listening on ${ipc.path}`);

  // Pre-warm everything the first query would otherwise pay for, so no client
  // is ever the one that triggers initialisation.
  //
  // The embedder warm below has been here a while, but it left the far larger
  // cost unwarmed: the graph. Loading it is a synchronous parse of the whole
  // graph.json (measured 3.1s on a 102k-node / 720k-edge graph, ~358 MB), and
  // it happened lazily inside whichever IPC request arrived first. That request
  // then took seconds while every subsequent one took ~3 ms.
  //
  // A caller with a short timeout never sees the fast path: it gives up during
  // the load, and the next call restarts the wait — so a busy daemon can look
  // permanently unresponsive while actually being idle. Warming here converts
  // "the first caller pays, repeatedly" into "the daemon pays once, before
  // anyone asks".
  //
  // Best-effort and un-awaited: a warm failure must not stop the daemon, and
  // the lazy path still works as the fallback.
  const warmStart = Date.now();
  void Promise.allSettled([
    rt.value.embedder.embed('folklore daemon warm').then((r) => {
      if (r.isErr()) console.error(`daemon: embedder pre-warm failed: ${formatError(r.error)}`);
    }),
    rt.value.graphs.load().then((r) => {
      if (r.isErr()) console.error(`daemon: graph pre-warm failed: ${formatError(r.error)}`);
    }),
  ]).then(() => {
    const ms = Date.now() - warmStart;
    console.log(`daemon: warm in ${ms}ms — queries now served from memory`);
    daemonLog(paths.home, `warm in ${ms}ms (graph + embedder pre-loaded)`);
  });

  const loop: LoopHandle = await startLoop({
    ingestDeps: rt.value.ingestDeps,
    graphs: rt.value.graphs,
    vectors: rt.value.vectors,
    sources: rt.value.sources,
    config: cfg.value.daemon,
    homePath: paths.home,
    // Same mutex instance the job worker uses — closes the
    // tick-vs-worker lost-update race on graph.json.
    graphMutex: rt.value.graphMutex,
    onFederationReady: (node) => { federation.current = node; },
  });

  // SINGLE-OWNER SHUTDOWN (multi-LLM round-2 review).
  //
  //   Previously two SIGTERM handlers raced — one in `loop.ts` calling
  //   `process.exit(0)` mid-flight while the supervisor here was still
  //   flushing IPC + write lock + runtime. The loop now exposes a
  //   cleanup callback; this supervisor orchestrates the full chain in
  //   a fixed order so shutdown is deterministic and idempotent.
  //
  // Order matters:
  //   refresh timer  — cheapest, drop the lock-keepalive first
  //   watchers       — stop fs events so no new jobs queue
  //   jobQueue       — drain to "stopped" so worker doesn't pick a
  //                    new job after libp2p teardown
  //   ipc            — close the socket so no more inbound RPCs
  //   loop           — libp2p protocol unregistration + node.stop
  //   runtime        — close sqlite-vec + ONNX
  //   write lock     — release LAST so a concurrent CLI gets the
  //                    "daemon already running" answer until we're
  //                    fully torn down
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { clearInterval(refreshTimer); } catch { /* best-effort */ }
    try { await watchers.stop(); } catch { /* best-effort */ }
    try { jobQueue.stop(); } catch { /* best-effort */ }
    try { await ipc.stop(); } catch { /* best-effort */ }
    try { await loop.cleanup(); } catch { /* best-effort */ }
    try { rt.value.close(); } catch { /* best-effort */ }
    try { await writeLock.release(); } catch { /* best-effort */ }
    try { removePid(paths.home); } catch { /* best-effort */ }
    daemonLog(paths.home, 'daemon stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  // Pin process keep-alive HERE — the supervisor owns the lifetime,
  // not the loop. Was previously inside startLoop which made the loop
  // implicitly responsible for staying alive AND tearing down.
  await new Promise<void>(() => {});
  return 0;
};

export const daemon = async (args: readonly string[]): Promise<number> => {
  const [sub] = args;
  switch (sub) {
    case 'start':
      return start();
    case 'stop':
      return stop();
    case 'status':
      return status();
    case '_run':
      return run();
    default:
      console.error(`daemon: unknown subcommand '${sub ?? ''}'. try: start | stop | status`);
      return 1;
  }
};
