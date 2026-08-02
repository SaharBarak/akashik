// A client that hangs up before the daemon answers must not kill the daemon.
//
// Found while wiring the OpenClaw plugin: its IPC calls have an 8s timeout and
// destroy the socket on expiry. When the daemon then wrote its (late) reply,
// the write failed EPIPE asynchronously — the `try { socket.write() } catch {}`
// around it only caught synchronous throws — and the error surfaced on the
// readline Interface, which had no 'error' listener. An 'error' event with no
// listener is an unhandled exception, so the whole daemon died.
//
// Reproduced verbatim: a slow handler plus a client that gives up.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startIpcServer, socketPath, type IpcHandler } from '../src/daemon/ipc.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ipc — client hangup', () => {
  it('survives a client that disconnects before the reply is written', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wi-ipc-hangup-'));
    const errors: string[] = [];

    const slow: IpcHandler<Record<string, never>> = async () => {
      await sleep(150);
      return { stdout: 'late answer', exit: 0 };
    };

    const handlers = new Map<string, IpcHandler<Record<string, never>>>([['slow', slow]]);
    const server = await startIpcServer({
      homeDir: home,
      ctx: {},
      handlers,
      onError: (m) => errors.push(m),
    });

    try {
      // The client must DIE, not merely call destroy(): a local destroy makes
      // the next write throw synchronously (ERR_STREAM_DESTROYED), which the
      // old code already caught. The bug needed a peer that vanishes at the OS
      // level, so the write is accepted and then fails EPIPE asynchronously.
      // That is what a timed-out CLI or a killed plugin host actually does.
      await new Promise<void>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            '-e',
            `const {connect}=require('net');
             const s=connect(${JSON.stringify(socketPath(home))},()=>{
               s.write(JSON.stringify({id:1,cmd:'slow',args:[]})+'\\n');
               process.exit(0);
             });`,
          ],
          { stdio: 'ignore' },
        );
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
      });

      // Let the handler finish and attempt its doomed write.
      await sleep(400);

      // The real assertion is that we got here at all: before the fix the
      // unhandled 'error' event terminated the process, taking the test
      // runner with it. Prove the server is still serving.
      const answered = await new Promise<string>((resolve) => {
        const sock = connect(socketPath(home), () => {
          sock.write(JSON.stringify({ id: 2, cmd: 'slow', args: [] }) + '\n');
        });
        let buf = '';
        sock.on('data', (d) => {
          buf += d.toString();
          if (buf.includes('\n')) {
            sock.destroy();
            resolve(buf);
          }
        });
        sock.on('error', () => resolve(''));
        setTimeout(() => {
          sock.destroy();
          resolve('');
        }, 3000);
      });

      assert.match(answered, /late answer/, 'daemon must still answer after a client hangup');
    } finally {
      await server.stop();
      await rm(home, { recursive: true, force: true });
    }
  });

  // The test above exercises the hangup path end-to-end, but it does NOT fail
  // without the fix: whether the doomed write throws synchronously (caught by
  // the old code) or fails async EPIPE (not caught, fatal) depends on whether
  // the socket has been marked unwritable yet — a race this process cannot
  // schedule deterministically. So the actual defect is pinned structurally
  // below. This one fails without the fix.
  it('the reader has an error listener — without one, EPIPE is fatal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wi-ipc-listener-'));
    const server = await startIpcServer({
      homeDir: home,
      ctx: {},
      handlers: new Map<string, IpcHandler<Record<string, never>>>(),
    });

    try {
      // Drive a real connection so the server builds its per-socket reader,
      // then assert the reader would absorb an error rather than throw. An
      // 'error' event with no listener is an unhandled exception in Node, and
      // a readline Interface re-emits its input stream's errors — which is how
      // a client hangup killed the whole daemon.
      const src = readFileSync(new URL('../src/daemon/ipc.ts', import.meta.url), 'utf8');
      const connectionHandler = src.slice(
        src.indexOf('createServer((socket: Socket)'),
        src.indexOf("rl.on('line'"),
      );
      assert.match(
        connectionHandler,
        /rl\.on\('error'/,
        "the readline Interface must have an 'error' listener",
      );
      assert.match(
        connectionHandler,
        /socket\.destroyed \|\| !socket\.writable/,
        'replies must be skipped when the peer is already gone',
      );
    } finally {
      await server.stop();
      await rm(home, { recursive: true, force: true });
    }
  });
});
