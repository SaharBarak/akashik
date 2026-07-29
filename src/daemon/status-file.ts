/**
 * daemon-status.json — machine-readable daemon heartbeat.
 *
 * The desktop app (and any other UI surface) needs three answers the
 * log can't give cheaply: is the daemon alive, is libp2p up, and how
 * many peers are connected right now. The loop writes this snapshot on
 * boot and refreshes it on a short heartbeat; readers cross-check
 * `pid` liveness so a stale file from a crashed daemon never reads as
 * "running".
 *
 * Best-effort by design: a failed status write must never affect the
 * daemon (mirrors the activity-feed contract in contribution.ts).
 */

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DAEMON_STATUS_FILE = 'daemon-status.json';

export interface DaemonStatusSnapshot {
  readonly v: 1;
  readonly pid: number;
  readonly started_at: string;
  readonly updated_at: string;
  /** Whether a libp2p node is up (false = P2P not started / no identity). */
  readonly p2p: boolean;
  /** Live libp2p connections right now. 0 when p2p is false. */
  readonly connected_peers: number;
}

export const writeDaemonStatus = (
  home: string,
  snap: Omit<DaemonStatusSnapshot, 'v' | 'updated_at'>,
): void => {
  try {
    const path = join(home, DAEMON_STATUS_FILE);
    const tmp = `${path}.tmp`;
    const full: DaemonStatusSnapshot = {
      v: 1,
      updated_at: new Date().toISOString(),
      ...snap,
    };
    writeFileSync(tmp, JSON.stringify(full));
    renameSync(tmp, path);
  } catch {
    /* status is observability — never break the daemon over it */
  }
};
