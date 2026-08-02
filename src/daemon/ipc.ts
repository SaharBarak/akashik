/**
 * Daemon IPC — Unix-socket JSON-line protocol for delegating CLI
 * commands to an already-running daemon.
 *
 * Why: a cold `folklore ask` pays ~700 ms of Node+tsx boot + ~40 ms
 * of sqlite-vec reopen + ~200 ms of ONNX model load before the first
 * query can execute (BENCH-v2.md §4). Routing the work to a daemon
 * that holds the Runtime (and a warm ONNX session) hot eliminates the
 * 240 ms of runtime+model cost; the 500 ms Node startup floor is
 * inescapable for a spawned CLI process. A follow-up (v4.1) can replace
 * the Node entry shim with a native binary that does the socket round
 * trip in ~5 ms, getting closer to 15 ms end-to-end.
 *
 * Protocol (newline-delimited JSON, bidirectional):
 *   request:  { id: number, cmd: string, args: string[] }
 *   response: { id: number, ok: boolean, stdout?: string, stderr?: string, exit?: number }
 *
 * Socket lives at `${FOLKLORE_HOME}/daemon.sock` — Unix-only.
 * 0600 permissions guarantee only the user process can connect.
 *
 * Commands not in the handler registry return
 *   { ok: false, stderr: '__fallback__', exit: 255 }
 * so the client knows to spawn a fresh process instead.
 */

import { createServer, connect, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';

// ─────────────── protocol ───────────────

export interface IpcRequest {
  readonly id: number;
  readonly cmd: string;
  readonly args: readonly string[];
}

export interface IpcResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit?: number;
}

/** Sentinel returned by the server when the command isn't in the handler registry. */
export const IPC_FALLBACK_SENTINEL = '__fallback__';

export const socketPath = (homeDir: string): string => join(homeDir, 'daemon.sock');

// ─────────────── handler type ───────────────

/**
 * IPC handler takes parsed argv-style args plus a caller-supplied
 * context object (the daemon's warmed Runtime) and returns stdout +
 * exit code. Errors become non-zero exit codes with stderr text; the
 * server never throws through this boundary.
 */
export interface HandlerResult {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exit: number;
}

export type IpcHandler<C> = (args: readonly string[], ctx: C) => Promise<HandlerResult>;

// ─────────────── server ───────────────

export interface IpcServerOptions<C> {
  readonly homeDir: string;
  readonly ctx: C;
  readonly handlers: ReadonlyMap<string, IpcHandler<C>>;
  /** Called on socket errors (non-fatal — server stays up). Default: no-op. */
  readonly onError?: (message: string) => void;
  /** Called when a command is delegated (for observability). Default: no-op. */
  readonly onCommand?: (cmd: string, argsLen: number, ms: number) => void;
}

export interface IpcServerHandle {
  /** Close the server + remove the socket file. Idempotent. */
  stop(): Promise<void>;
  /** The resolved socket path. */
  readonly path: string;
}

/**
 * Open a Unix-domain socket and listen for IPC requests. Returns a
 * handle whose `.stop()` cleanly shuts the listener down.
 */
export const startIpcServer = async <C>(
  opts: IpcServerOptions<C>,
): Promise<IpcServerHandle> => {
  const path = socketPath(opts.homeDir);
  mkdirSync(dirname(path), { recursive: true });
  // Clean up a stale socket — a previous daemon crash may have left one.
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* best-effort */ }
  }

  const onError = opts.onError ?? (() => {});
  const onCommand = opts.onCommand ?? (() => {});

  const server: Server = createServer((socket: Socket) => {
    socket.on('error', (e) => onError(`ipc: socket error: ${e.message}`));
    const rl = createInterface({ input: socket });
    // A readline Interface RE-EMITS its input stream's 'error' on itself, and
    // an 'error' with no listener is an unhandled exception that takes the
    // process down. The socket handler above does NOT cover this: the error
    // arrives on the Interface, not the Socket.
    //
    // This is reachable by any client that hangs up before we answer — a
    // caller with a request timeout, a Ctrl-C'd CLI — because the write below
    // then fails EPIPE asynchronously. In other words, a client giving up
    // could kill the daemon.
    rl.on('error', (e: Error) => onError(`ipc: reader error: ${e.message}`));

    /**
     * Write one response, tolerating a client that has already gone.
     *
     * The bare `try { socket.write(…) } catch {}` this replaces only caught
     * SYNCHRONOUS throws; a write to a half-closed pipe fails asynchronously,
     * which is the case that actually happens. Checking `writable` first skips
     * the doomed write entirely, and the error callback absorbs the race
     * between the check and the flush.
     */
    const reply = (resp: IpcResponse): void => {
      if (socket.destroyed || !socket.writable) return;
      try {
        socket.write(JSON.stringify(resp) + '\n', (e) => {
          if (e) onError(`ipc: reply dropped (${e.message})`);
        });
      } catch (e) {
        onError(`ipc: reply failed (${(e as Error).message})`);
      }
    };
    // Named async handler + void-wrapped registration: every await in
    // the body is try/caught, so the promise cannot reject — the
    // wrapper just keeps the EventEmitter contract synchronous.
    const onLine = async (line: string): Promise<void> => {
      if (!line.trim()) return;

      let req: IpcRequest;
      try {
        req = JSON.parse(line) as IpcRequest;
      } catch (e) {
        const resp: IpcResponse = { id: 0, ok: false, stderr: `ipc: bad json: ${(e as Error).message}`, exit: 1 };
        reply(resp);
        return;
      }

      const handler = opts.handlers.get(req.cmd);
      if (!handler) {
        const resp: IpcResponse = {
          id: req.id,
          ok: false,
          stderr: IPC_FALLBACK_SENTINEL,
          exit: 255,
        };
        reply(resp);
        return;
      }

      const t0 = Date.now();
      try {
        const result = await handler(req.args, opts.ctx);
        const resp: IpcResponse = {
          id: req.id,
          ok: result.exit === 0,
          stdout: result.stdout,
          stderr: result.stderr,
          exit: result.exit,
        };
        reply(resp);
        onCommand(req.cmd, req.args.length, Date.now() - t0);
      } catch (e) {
        const resp: IpcResponse = {
          id: req.id,
          ok: false,
          stderr: `ipc handler '${req.cmd}': ${(e as Error).message}`,
          exit: 1,
        };
        reply(resp);
      }
    };
    rl.on('line', (line) => { void onLine(line); });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      try { chmodSync(path, 0o600); } catch { /* non-fatal on systems without POSIX perms */ }
      resolve();
    });
  });

  let stopped = false;
  return {
    path,
    stop: () =>
      new Promise<void>((resolve) => {
        if (stopped) { resolve(); return; }
        stopped = true;
        server.close(() => {
          if (existsSync(path)) {
            try { unlinkSync(path); } catch { /* already removed */ }
          }
          resolve();
        });
      }),
  };
};

// ─────────────── client ───────────────

/**
 * Send an IPC request to the running daemon. Returns `null` if no
 * socket exists (daemon not running) or the server responded with the
 * fallback sentinel — callers treat either as "spawn the full CLI
 * instead of delegating".
 *
 * Does NOT throw. Connect errors / timeouts fall through to `null`.
 */
export const sendIpcRequest = (
  homeDir: string,
  cmd: string,
  args: readonly string[],
  timeoutMs: number = 5000,
): Promise<IpcResponse | null> => {
  const path = socketPath(homeDir);
  if (!existsSync(path)) return Promise.resolve(null);

  return new Promise((resolve) => {
    const socket = connect(path);
    let settled = false;
    const done = (r: IpcResponse | null): void => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(r);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on('connect', () => {
      const req: IpcRequest = { id: Date.now(), cmd, args: [...args] };
      socket.write(JSON.stringify(req) + '\n');
    });
    socket.on('error', () => { clearTimeout(timer); done(null); });
    const rl = createInterface({ input: socket });
    rl.on('line', (line) => {
      clearTimeout(timer);
      try {
        const resp = JSON.parse(line) as IpcResponse;
        if (resp.stderr === IPC_FALLBACK_SENTINEL) done(null);
        else done(resp);
      } catch {
        done(null);
      }
    });
  });
};
