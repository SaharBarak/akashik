/**
 * Phase 18: Production Networking — TDD test suite.
 *
 * Three tiers (per 18-RESEARCH.md Validation architecture):
 *   1. Structural — source-read regex assertions (S1..S14)
 *   2. Unit       — connection-health, bandwidth-limiter, share-sync gate (U1..U20)
 *   3. Integration — real 10-peer libp2p mesh (NET-04) — tagged slow
 *
 * All 7 pitfalls from 18-RESEARCH.md are encoded as regression tests.
 *
 * Integration tier note: the original 10-peer mesh integration test
 * was deleted after migration off shared CI runners — it pinned a
 * libp2p guarantee rather than an folklore invariant. See the
 * "Integration tier — REMOVED" block at the bottom of this file for
 * pointers to the tests that DO cover folklore's transport contract.
 *
 * Runner: node --import tsx --test tests/phase18.production-net.test.ts
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import * as Y from 'yjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');


// ─────────────────────────────────────────────────────────────────────────────
// Structural tier — S1..S14 (NET-01, NET-03, NetError, PeerConfig, daemon)
// No libp2p runtime needed — assertions operate on source text only.
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 18 — Structural: libp2p transport wiring (NET-01, NET-03)', () => {
  const transport = read('src/infrastructure/peer-transport.ts');

  test("S1 NET-01: circuitRelayTransport is in transports[] alongside tcp", () => {
    assert.ok(
      transport.includes('circuitRelayTransport()'),
      'peer-transport.ts must include circuitRelayTransport()',
    );
    assert.ok(
      transport.includes('tcp()'),
      'peer-transport.ts must include tcp()',
    );
    // Both must appear together in the transports array
    const transportsBlock = transport.match(/transports:\s*\[([^\]]+)\]/);
    assert.ok(transportsBlock, 'transports array block must exist');
    assert.ok(
      transportsBlock![1].includes('tcp()') && transportsBlock![1].includes('circuitRelayTransport()'),
      'transports[] must contain both tcp() and circuitRelayTransport()',
    );
  });

  test("S2 NET-01: yamux stream muxer is wired (multiplexed streams)", () => {
    const matches = transport.match(/streamMuxers:\s*\[yamux\(\)\]/g);
    assert.ok(matches && matches.length === 1, 'streamMuxers must include yamux() exactly once');
  });

  test("S3 LOCK: circuitRelayServer is present but ONLY behind the relayServer flag", () => {
    // Superseded decision: relay-server (hop) mode was originally out of scope,
    // so this lock forbade circuitRelayServer entirely. It is now a first-class
    // feature (a dedicated public relay node for NAT'd/CGNAT peers), but a LEAF
    // must never silently become a relay — the service stays gated on
    // cfg.relayServer. This lock now enforces that gating instead of a blanket ban.
    assert.ok(
      transport.includes('circuitRelayServer('),
      'circuitRelayServer() must be wired (relay-server mode for NAT traversal)',
    );
    assert.ok(
      transport.includes('cfg.relayServer'),
      'circuitRelayServer must be gated on cfg.relayServer — leaves never auto-become relays',
    );
  });

  test("S4 NET-03: dcutr() is wired in services block", () => {
    const matches = transport.match(/dcutr:\s*dcutr\(\)/g);
    assert.ok(matches && matches.length === 1, 'services must include dcutr: dcutr() exactly once');
  });

  test("S5 NET-03: uPnPNAT is wired in services block (conditional on cfg.upnp)", () => {
    // uPnPNAT is wired with options (autoConfirmAddress: true) inside a conditional
    // spread — only active when cfg.upnp !== false (default true)
    assert.ok(
      transport.includes('uPnPNAT('),
      'services must include uPnPNAT( call',
    );
    assert.ok(
      transport.includes('upnpNAT'),
      "services key 'upnpNAT' must appear in peer-transport.ts",
    );
    assert.ok(
      transport.includes("cfg.upnp !== false"),
      'uPnPNAT must be conditional on cfg.upnp !== false (silent disable when upnp:false)',
    );
  });

  test("S6 Anti-pattern LOCK: /p2p-circuit only added when cfg.relays is non-empty", () => {
    assert.ok(
      transport.match(/cfg\.relays && cfg\.relays\.length > 0/),
      "conditional guard 'cfg.relays && cfg.relays.length > 0' required — prevents /p2p-circuit when no relays configured",
    );
    const circuitMatches = transport.match(/'\/p2p-circuit'/g);
    assert.ok(
      circuitMatches && circuitMatches.length === 1,
      "'/p2p-circuit' must appear exactly once (inside the conditional guard)",
    );
  });

  test("S7 NET-03: three new libp2p imports present", () => {
    assert.ok(
      transport.includes("from '@libp2p/circuit-relay-v2'"),
      'must import from @libp2p/circuit-relay-v2',
    );
    assert.ok(
      transport.includes("from '@libp2p/dcutr'"),
      'must import from @libp2p/dcutr',
    );
    assert.ok(
      transport.includes("from '@libp2p/upnp-nat'"),
      'must import from @libp2p/upnp-nat',
    );
  });
});

describe('Phase 18 — Structural: NetError (Plan 01 foundation)', () => {
  const errors = read('src/domain/errors.ts');

  test("S8 all 6 NetError variants present", () => {
    for (const v of [
      'RelayDialFailed',
      'HolePunchTimeout',
      'UPnPMapFailed',
      'BandwidthExceeded',
      'HealthDegraded',
      'RelayNotConfigured',
    ]) {
      assert.ok(
        errors.includes(`'${v}'`) || errors.includes(`"${v}"`),
        `missing NetError variant: ${v}`,
      );
    }
  });

  test("S9 NetError is a member of AppError union", () => {
    assert.ok(
      errors.match(/\|\s*NetError(\s|;|$)/m) || errors.includes('| NetError;'),
      'NetError must be part of AppError union',
    );
  });

  test("S8b factory has all 6 NetError constructors", () => {
    for (const ctor of [
      'relayDialFailed',
      'holePunchTimeout',
      'upnpMapFailed',
      'bandwidthExceeded',
      'healthDegraded',
      'relayNotConfigured',
    ]) {
      assert.ok(errors.includes(`${ctor}:`), `missing NetError factory: ${ctor}`);
    }
  });
});

describe('Phase 18 — Structural: PeerConfig extensions (Plan 01)', () => {
  const cfg = read('src/infrastructure/config-loader.ts');

  test("S10 PeerConfig has relays/upnp/bandwidth fields", () => {
    assert.ok(cfg.includes('readonly relays: readonly string[]'), 'PeerConfig must have readonly relays: readonly string[]');
    assert.ok(cfg.includes('readonly upnp: boolean'), 'PeerConfig must have readonly upnp: boolean');
    assert.ok(cfg.includes('readonly bandwidth: BandwidthConfig'), 'PeerConfig must have readonly bandwidth: BandwidthConfig');
    assert.ok(cfg.includes('bandwidth_overrides'), 'PeerConfig must have bandwidth_overrides field');
  });

  test("S11 DEFAULT_PEER has locked default values (50, 10, [], true)", () => {
    assert.ok(
      cfg.includes('max_updates_per_sec_per_peer: 50'),
      'default max_updates_per_sec_per_peer must be 50',
    );
    assert.ok(
      cfg.includes('max_concurrent_share_syncs: 10'),
      'default max_concurrent_share_syncs must be 10',
    );
    // relays default is now env-driven (FOLKLORE_RELAYS → ENV_RELAYS), so a
    // shipped default relay isn't shadowed by an empty literal. Empty when the
    // env is unset, so the effective default is still [] until a relay is deployed.
    assert.ok(cfg.includes('relays: ENV_RELAYS'), 'default relays must come from ENV_RELAYS');
    assert.ok(cfg.includes('upnp: true'), 'default upnp must be true');
  });

  test("S10b BandwidthConfig interface is exported", () => {
    assert.ok(cfg.includes('export interface BandwidthConfig'), 'BandwidthConfig must be exported');
    assert.ok(cfg.includes('export interface BandwidthOverride'), 'BandwidthOverride must be exported');
  });
});

describe('Phase 18 — Structural: Daemon wiring (Plan 03)', () => {
  const loop = read('src/daemon/loop.ts');

  test("S12a connection:close listener registered", () => {
    assert.ok(
      loop.includes("addEventListener('connection:close'"),
      "daemon/loop.ts must register 'connection:close' listener",
    );
    assert.ok(loop.includes('recordDisconnect'), "connection:close listener must call recordDisconnect");
  });

  test("S12b Pitfall 7 LOCK: relay TTL expiry filtered via conn.limits !== undefined", () => {
    assert.ok(
      loop.includes('conn.limits !== undefined'),
      "listener must filter relay-limited closures via conn.limits !== undefined so relay TTL expiry does not flag peers as degraded",
    );
  });

  test("S12c Pattern 2: relay pre-dial iterates config.peer.relays", () => {
    assert.ok(
      loop.includes('for (const relayAddr of cfgRes.value.peer.relays)'),
      "daemon must iterate peer.relays for pre-dial on startup",
    );
  });

  test("S12d Plan 03: bandwidth config wired into createShareSyncRegistry", () => {
    // The daemon passes maxUpdatesPerSecPerPeer from config into
    // createShareSyncRegistry which internally constructs the rate limiter —
    // the registry owns the createRateLimiter call (not the daemon directly).
    assert.ok(
      loop.includes('max_updates_per_sec_per_peer'),
      'daemon must pass max_updates_per_sec_per_peer to share sync registry',
    );
    assert.ok(
      loop.includes('createShareSyncRegistry'),
      'daemon must call createShareSyncRegistry to wire bandwidth-limited share sync',
    );
  });

  test("S12e HealthTracker spliced into tickDeps", () => {
    assert.ok(loop.includes('healthTracker: liveHealth'), 'daemon must pass healthTracker: liveHealth into tick deps');
  });
});

describe('Phase 18 — Structural: peer list health column (Plan 03)', () => {
  const peerCli = read('src/cli/commands/peer.ts');

  test("S13a JSON output has health field (NET-04: health tracking exposed in CLI)", () => {
    // peer list --json outputs health: 'unknown' for all peers (daemon-process
    // tracker not accessible from CLI process; Phase 19+ will expose via MCP/IPC)
    assert.ok(
      peerCli.includes("health: 'unknown'"),
      "peer list JSON must include health: 'unknown' field",
    );
  });

  test("S13b text output renders health column", () => {
    assert.ok(
      peerCli.includes('health:    unknown'),
      "peer list text must render 'health:    unknown' row for each peer",
    );
  });

  test("S13c health field is present in JSON peers array (not just text)", () => {
    // Confirm the JSON path has the health key — structural check that
    // both JSON and text output surfaces health as required by NET-04
    const jsonBlock = peerCli.match(/peers\.map\([^)]+\{[\s\S]*?health[\s\S]*?\}\)/);
    assert.ok(
      jsonBlock !== null || peerCli.includes("health: 'unknown'"),
      'peer list JSON peers array must include health field',
    );
  });
});

describe('Phase 18 — Structural: dep budget + identify presence (Plan 02)', () => {
  const pkg = JSON.parse(read('package.json')) as Record<string, unknown> & {
    dependencies: Record<string, string>;
  };

  test("S14a three new deps pinned exactly", () => {
    assert.equal(
      pkg.dependencies['@libp2p/circuit-relay-v2'],
      '4.2.0',
      '@libp2p/circuit-relay-v2 must be pinned to 4.2.0',
    );
    assert.equal(
      pkg.dependencies['@libp2p/dcutr'],
      '3.0.15',
      '@libp2p/dcutr must be pinned to 3.0.15',
    );
    assert.equal(
      pkg.dependencies['@libp2p/upnp-nat'],
      '4.0.15',
      '@libp2p/upnp-nat must be pinned to 4.0.15',
    );
  });

  test("S14b @libp2p/identify present (required by circuitRelayTransport at runtime)", () => {
    // circuitRelayTransport's RelayDiscovery registers @libp2p/identify as a
    // serviceDependency — without it createLibp2p throws on capability checks.
    // Phase 17's decision to omit identify was correct then (no relay transport);
    // Phase 18 wires circuitRelayTransport making identify mandatory.
    assert.ok(
      pkg.dependencies['@libp2p/identify'] !== undefined,
      '@libp2p/identify must be in dependencies (required by circuitRelayTransport)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Live tier — the WebSocket relay path (two real libp2p nodes on loopback)
// ─────────────────────────────────────────────────────────────────────────────

describe('WebSocket relay reservation (the CGNAT path)', async () => {
  const { loadOrCreateIdentity, createNode } = await import(
    '../src/infrastructure/peer-transport.js'
  );
  const { multiaddr } = await import('@multiformats/multiaddr');

  // Mirrors the deployed topology minus the TLS edge: in production the edge
  // terminates TLS on 443 and proxies the upgrade to exactly this plain-ws
  // listener, so if the reservation works here it works there.
  test('a ws-listening relay grants a reservation and the leaf advertises /p2p-circuit', async () => {
    const idPath = async (n: string) =>
      join(await mkdtemp(join(tmpdir(), `fk-wsrelay-${n}-`)), 'identity.json');

    const relayIdRes = await loadOrCreateIdentity(await idPath('relay'));
    assert.ok(relayIdRes.isOk());
    const relayRes = await createNode(relayIdRes._unsafeUnwrap(), {
      listenPort: 0,
      wsPort: 44811,
      listenHost: '127.0.0.1',
      mdns: false,
      dhtEnabled: false,
      upnp: false,
      relayServer: true,
    });
    assert.ok(relayRes.isOk(), 'relay node must start');
    const relay = relayRes._unsafeUnwrap();

    try {
      const wsAddr = relay.getMultiaddrs().map(String).find((a) => a.includes('/ws'));
      assert.ok(wsAddr, 'relay must expose a /ws listen address');

      const leafIdRes = await loadOrCreateIdentity(await idPath('leaf'));
      assert.ok(leafIdRes.isOk());
      const leafRes = await createNode(leafIdRes._unsafeUnwrap(), {
        listenPort: 0,
        listenHost: '127.0.0.1',
        mdns: false,
        dhtEnabled: false,
        upnp: false,
        relays: [wsAddr], // reserve over WEBSOCKETS, not raw tcp
      });
      assert.ok(leafRes.isOk(), 'leaf node must start');
      const leaf = leafRes._unsafeUnwrap();

      try {
        // Configuring `relays` adds the /p2p-circuit listener; the reservation
        // itself needs a dial, which the daemon does at startup (relay pre-dial
        // in daemon/loop.ts). Reproduce that step here.
        await leaf.dial(multiaddr(wsAddr));

        // Reservation + address advertisement are async; poll rather than sleep.
        let circuit: string | undefined;
        for (let i = 0; i < 40 && circuit === undefined; i++) {
          await new Promise((r) => setTimeout(r, 250));
          circuit = leaf.getMultiaddrs().map(String).find((a) => a.includes('/p2p-circuit'));
        }
        assert.ok(circuit, 'leaf must advertise a relayed address after reserving');
        assert.ok(
          circuit.includes('/ws'),
          'the relayed address must carry the ws hop — that is what a CGNAT leaf publishes',
        );
      } finally {
        await leaf.stop();
      }
    } finally {
      await relay.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tier — U1..U20
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 18 — Unit: HealthTracker (NET-04)', async () => {
  const { createHealthTracker } = await import('../src/infrastructure/connection-health.js');

  test('U1 fresh tracker returns health=ok for unknown peer', () => {
    const t = createHealthTracker();
    const h = t.getHealth('never-seen');
    assert.equal(h.health, 'ok');
    assert.equal(h.disconnectTimestamps.length, 0);
    assert.equal(h.lastStreamAt, 0);
  });

  test('U2 two disconnects within 60s keeps health=ok (threshold is 3)', () => {
    const t = createHealthTracker();
    const now = 1_700_000_000_000;
    t.recordDisconnect('p1', now);
    t.recordDisconnect('p1', now + 10);
    assert.equal(t.getHealth('p1', now + 100).health, 'ok');
  });

  test('U3 three disconnects within 60s marks health=degraded (reason: disconnects)', () => {
    const t = createHealthTracker();
    const now = 1_700_000_000_000;
    t.recordDisconnect('p1', now);
    t.recordDisconnect('p1', now + 10);
    t.recordDisconnect('p1', now + 20);
    const h = t.getHealth('p1', now + 100);
    assert.equal(h.health, 'degraded');
    assert.equal(h.reason, 'disconnects');
  });

  test('U4 disconnects older than 60s are pruned from sliding window — degraded→ok', () => {
    const t = createHealthTracker();
    const now = 1_700_000_000_000;
    t.recordDisconnect('p1', now);
    t.recordDisconnect('p1', now + 10);
    t.recordDisconnect('p1', now + 20);
    // 61s later — all three disconnects are outside the 60s window
    const h = t.getHealth('p1', now + 61_000);
    assert.equal(h.health, 'ok');
  });

  test('U5 recordStream makes peer appear active — health stays ok within 5 min window', () => {
    const t = createHealthTracker();
    const now = 1_700_000_000_000;
    t.recordStream('p1', now);
    // 60s later — stream is recent, no disconnects
    const h = t.getHealth('p1', now + 60_000);
    assert.equal(h.health, 'ok');
  });

  test('U6 lastStreamAt older than 5 min yields health=degraded (reason: idle)', () => {
    const t = createHealthTracker();
    const now = 1_700_000_000_000;
    t.recordStream('p1', now);
    // 6 minutes later — stream is stale
    const h = t.getHealth('p1', now + 6 * 60 * 1_000);
    assert.equal(h.health, 'degraded');
    assert.equal(h.reason, 'idle');
  });

  test('U7 OR logic: 3 disconnects + recent stream = still degraded (disconnects wins)', () => {
    const t = createHealthTracker();
    const now = 1_700_000_000_000;
    t.recordStream('p1', now);
    t.recordDisconnect('p1', now + 100);
    t.recordDisconnect('p1', now + 200);
    t.recordDisconnect('p1', now + 300);
    const h = t.getHealth('p1', now + 400);
    assert.equal(h.health, 'degraded');
    assert.equal(h.reason, 'disconnects');
  });

  test('U8 checkAll returns map with all recorded peers (not just degraded)', () => {
    const t = createHealthTracker();
    const now = 1_700_000_000_000;
    t.recordDisconnect('p1', now);
    t.recordStream('p2', now);
    const snap = t.checkAll(now);
    assert.equal(snap.size, 2);
    assert.ok(snap.has('p1'));
    assert.ok(snap.has('p2'));
  });

  test('U9 checkAll on fresh tracker returns empty map', () => {
    assert.equal(createHealthTracker().checkAll().size, 0);
  });
});

describe('Phase 18 — Unit: Semaphore + createRateLimiter re-export (NET-02)', async () => {
  const bl = await import('../src/infrastructure/bandwidth-limiter.js');

  test('U10 createSemaphore(3) grants tryAcquire 3 times', () => {
    const s = bl.createSemaphore(3);
    assert.equal(s.tryAcquire(), true);
    assert.equal(s.tryAcquire(), true);
    assert.equal(s.tryAcquire(), true);
  });

  test('U11 4th tryAcquire on capacity-3 semaphore returns false', () => {
    const s = bl.createSemaphore(3);
    s.tryAcquire();
    s.tryAcquire();
    s.tryAcquire();
    assert.equal(s.tryAcquire(), false);
  });

  test('U12 available() reflects current capacity minus active', () => {
    const s = bl.createSemaphore(3);
    assert.equal(s.available(), 3);
    s.tryAcquire();
    assert.equal(s.available(), 2);
    s.tryAcquire();
    assert.equal(s.available(), 1);
  });

  test('U13 release restores one slot — previously-denied acquire now succeeds', () => {
    const s = bl.createSemaphore(2);
    s.tryAcquire();
    s.tryAcquire();
    assert.equal(s.tryAcquire(), false, 'should be denied at capacity');
    s.release();
    assert.equal(s.tryAcquire(), true, 'should succeed after release');
  });

  test('U14 release below zero is a no-op — available never exceeds capacity', () => {
    const s = bl.createSemaphore(2);
    s.release(); // no-op — already at max
    s.release();
    s.release();
    assert.equal(s.available(), 2, 'must not exceed initial capacity');
  });

  test('U15 createRateLimiter is re-exported from bandwidth-limiter and usable', () => {
    const rl = bl.createRateLimiter(10, 10);
    assert.equal(typeof rl.consume, 'function', 'createRateLimiter must return an object with consume()');
    assert.equal(rl.consume('p1'), true, 'consume with fresh bucket must return true');
  });
});

describe('Phase 18 — Unit: syncNodeIntoYDoc bandwidth gate (NET-02)', async () => {
  const { syncNodeIntoYDoc } = await import('../src/infrastructure/share-sync.js');
  const { buildPatterns } = await import('../src/domain/sharing.js');

  const makeNode = (id: string) => ({
    id,
    label: 'hello world',
    file_type: 'document' as const,
    source_file: 'test',
    private: false,
    embedding_id: 'e1',
    source_uri: 'u',
    fetched_at: new Date().toISOString(),
  });

  const allowAllLimiter = {
    consume: (_key: string) => true,
    evictIdle: () => 0,
    peek: () => undefined,
  };

  const denyAllLimiter = {
    consume: (_key: string) => false,
    evictIdle: () => 0,
    peek: () => undefined,
  };

  test('U16 backward compat: no rateLimiter = Phase 16 behaviour preserved (V5: no room)', async () => {
    const doc = new Y.Doc();
    const d = await mkdtemp(join(tmpdir(), 'p18-u16-'));
    const logPath = join(d, 'share-log.jsonl');
    const result = await syncNodeIntoYDoc(doc, makeNode('n1'), buildPatterns([]), logPath, 'me');
    assert.ok(result.isOk(), `must succeed without limiter, got: ${result.isErr() ? JSON.stringify(result.error) : 'ok'}`);
    assert.ok(doc.getMap('nodes').has('n1'), 'node must be written to Y.Doc');
  });

  test('U17 consume-false limiter returns BandwidthExceeded error (V5: no room)', async () => {
    const doc = new Y.Doc();
    const d = await mkdtemp(join(tmpdir(), 'p18-u17-'));
    const logPath = join(d, 'share-log.jsonl');
    const result = await syncNodeIntoYDoc(
      doc,
      makeNode('n2'),
      buildPatterns([]),
      logPath,
      'me',
      denyAllLimiter,
    );
    assert.ok(result.isErr(), 'must be an error when rate-limited');
    assert.equal(result.error.type, 'BandwidthExceeded', `expected BandwidthExceeded, got ${result.error.type}`);
    assert.equal(doc.getMap('nodes').has('n2'), false, 'node must NOT be written to Y.Doc when rate-limited');
  });

  test('U18 consume-true limiter writes normally to Y.Doc (V5: no room)', async () => {
    const doc = new Y.Doc();
    const d = await mkdtemp(join(tmpdir(), 'p18-u18-'));
    const logPath = join(d, 'share-log.jsonl');
    const result = await syncNodeIntoYDoc(
      doc,
      makeNode('n3'),
      buildPatterns([]),
      logPath,
      'me',
      allowAllLimiter,
    );
    assert.ok(result.isOk(), `must succeed with allow-all limiter, got: ${result.isErr() ? JSON.stringify(result.error) : 'ok'}`);
    assert.ok(doc.getMap('nodes').has('n3'), 'node must be written to Y.Doc');
  });

  test("U19 bandwidth-limited writes audit entry with action='bandwidth_limited' (V5: no room)", async () => {
    const doc = new Y.Doc();
    const d = await mkdtemp(join(tmpdir(), 'p18-u19-'));
    const logPath = join(d, 'share-log.jsonl');
    await syncNodeIntoYDoc(
      doc,
      makeNode('n4'),
      buildPatterns([]),
      logPath,
      'me',
      denyAllLimiter,
    );
    const log = await readFile(logPath, 'utf8');
    assert.ok(log.includes('"action":"bandwidth_limited"'), 'audit log must contain action=bandwidth_limited');
    assert.ok(log.includes('"peer":"me"'), 'audit log must contain the ownPeerId as peer field');
  });

  test('U20 V5: rate limiter called with peerId-only key (room dimension dropped)', async () => {
    const doc = new Y.Doc();
    const d = await mkdtemp(join(tmpdir(), 'p18-u20-'));
    const logPath = join(d, 'share-log.jsonl');
    const seen: string[] = [];
    const spyLimiter = {
      consume: (k: string) => {
        seen.push(k);
        return true;
      },
      evictIdle: () => 0,
      peek: () => undefined,
    };
    await syncNodeIntoYDoc(
      doc,
      makeNode('n5'),
      buildPatterns([]),
      logPath,
      'me',
      spyLimiter,
    );
    // V5: key is the bare peerId (room dimension dropped per ROOMS-DEL-04)
    assert.ok(
      seen.includes('me'),
      `expected peerId key 'me', got: ${seen.join(', ')}`,
    );
    assert.ok(
      !seen.some((k) => k.includes('::')),
      `V5 keys must NOT contain '::' composite separator, got: ${seen.join(', ')}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tier — 10-peer mesh (NET-04) — REMOVED
// ─────────────────────────────────────────────────────────────────────────────
//
// The original NET-04 integration test spun 10 real libp2p nodes on
// ephemeral ports, connected them in a ring + cross-link mesh, and
// asserted every node converged to ≥3 peers within a 10-second window.
//
// That contract is libp2p's, not folklore's. Spinning 10 listenPort:0
// nodes on shared CI runners is a port-allocation lottery (we observed
// 30-40% flake rate on ubuntu-latest under load), and the assertion
// — "libp2p can build a mesh" — would still pass even if every line of
// folklore code was deleted. It's a libp2p smoke test.
//
// What folklore actually owns at this layer is the createNode config —
// mdns:false / listenPort:0 / upnp:false plumbing, the discovery
// service registration, the floodsub service composition. Those are
// covered by:
//
//   - tests/phase17.discovery.test.ts (mDNS + DHT structural wiring)
//   - tests/phase18 unit + structural tiers above (transport / health /
//     bandwidth gate / rate limiter)
//   - tests/phase26.e2e-share-sync.test.ts (Y.Doc-ferry'd inbound +
//     outbound pipeline with github_user binding)
//   - tests/phase39.oracle-gossip-e2e.test.ts (in-process pubsub bus
//     exercising publish + subscribe + reject pathways)
//
// If a real multi-node smoke is wanted, run it manually:
//   FOLKLORE_REAL_NET=1 node --import tsx --test tests/phase18-net04.real.ts
// (file doesn't exist yet — set up locally when you need it).
