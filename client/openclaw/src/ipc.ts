/**
 * folklore daemon client — newline-delimited JSON over a unix socket.
 *
 * Deliberately dependency-free and copied rather than imported: the plugin
 * loads inside OpenClaw's gateway process, and pulling @usefolklore/folklore
 * in would drag onnxruntime, sqlite and libp2p into a process that only needs
 * to ask a question over a socket. The wire format is the daemon's stable
 * contract (src/cli/ipc-client.ts on the folklore side).
 *
 * EVERY failure returns null. A missing daemon, a timeout, a non-zero exit —
 * all of it degrades to "no memory", never to a thrown error inside a hook.
 * A memory plugin that can break the agent's turn is worse than no memory.
 */
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface IpcResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly exit: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

/** `$FOLKLORE_HOME/daemon.sock`, matching the daemon's own resolution. */
export const socketPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.FOLKLORE_HOME && env.FOLKLORE_HOME.length > 0 ? env.FOLKLORE_HOME : join(homedir(), '.folklore'), 'daemon.sock');

export const daemonAvailable = (env: NodeJS.ProcessEnv = process.env): boolean =>
  existsSync(socketPath(env));

/**
 * Run one folklore CLI command inside the warm daemon process.
 * ~50 ms versus ~500 ms for a cold `node` boot, which matters because this
 * sits in front of every agent turn.
 */
export const ipcCall = (
  cmd: string,
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IpcResult | null> =>
  new Promise((resolve) => {
    const sock = socketPath(env);
    if (!existsSync(sock)) {
      resolve(null);
      return;
    }

    const socket = connect(sock);
    let settled = false;
    const done = (v: IpcResult | null): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(v);
    };

    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();

    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: Date.now(), cmd, args: [...args] }) + '\n');
    });
    socket.on('error', () => {
      clearTimeout(timer);
      done(null);
    });

    const rl = createInterface({ input: socket });
    rl.on('line', (line) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(line) as { ok?: boolean; stdout?: string; exit?: number };
        done({
          ok: parsed.ok === true,
          stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
          exit: typeof parsed.exit === 'number' ? parsed.exit : 0,
        });
      } catch {
        done(null);
      }
    });
  });

/**
 * Does the running daemon understand `cmd`?
 *
 * A daemon is long-lived — one that has been up for weeks is running whatever
 * folklore was installed when it started, not what is on disk now. An unknown
 * command comes back as a non-zero exit rather than an error, so a plugin that
 * doesn't check just sees empty results forever and looks like an empty graph.
 * Probes with `--help`, which every command accepts and none acts on.
 */
export const daemonSupports = async (
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> => {
  const res = await ipcCall(cmd, ['--help'], 3000, env);
  return res !== null && res.exit !== 255;
};

/** Convenience: run a command and JSON.parse its stdout, or null on any failure. */
export const ipcJson = async <T>(
  cmd: string,
  args: readonly string[],
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv,
): Promise<T | null> => {
  const res = await ipcCall(cmd, args, timeoutMs, env);
  if (!res || !res.ok || res.stdout.length === 0) return null;
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    return null;
  }
};
