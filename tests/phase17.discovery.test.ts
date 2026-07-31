/**
 * Phase 17: Discovery — mDNS/DHT wiring + PeerRecord migration + DISC deferral.
 *
 * Covers DISC-01..04 plus the discovery-related pitfalls from 17-RESEARCH.md:
 *   Pitfall 1 — mDNS does not auto-dial (explicit node.dial() required)
 *   Pitfall 2 — Docker/WSL multicast failure must not crash createNode
 *   Pitfall 4 — DHT routing table and identify (clientMode:true used instead)
 *   Pitfall 5 — SearchError exhaustive switch in formatError
 *   Pitfall 6 — legacy PeerRecord (no discovery_method) must load without error
 *
 * Most tests are STRUCTURAL: they read the source file and assert on invariants
 * in the code. This is more reliable than spinning real network infrastructure
 * and follows the Phase 16 precedent for locked invariants.
 *
 * Runner: node --import tsx --test tests/phase17.discovery.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPeers, addPeerRecord } from '../src/infrastructure/peer-store.js';
import { loadConfig } from '../src/infrastructure/config-loader.js';
import type { PeersFile } from '../src/infrastructure/peer-store.js';

// ─────────────────────── source file paths (relative, resolved at test time) ──

const SRC_PEER_TRANSPORT = 'src/infrastructure/peer-transport.ts';
const SRC_ERRORS = 'src/domain/errors.ts';

// ─────────────────────── DISC-02: mDNS wiring + Pitfall 1 + 2 ────────────────

describe('Phase 17: discovery — mDNS wiring (DISC-02) + Pitfalls 1, 2', () => {
  const src = readFileSync(SRC_PEER_TRANSPORT, 'utf8');

  it("D1 (DISC-02): peer-transport.ts imports { mdns } from '@libp2p/mdns'", () => {
    assert.ok(
      /import\s*\{\s*mdns\s*\}\s*from\s*'@libp2p\/mdns'/.test(src),
      "must import mdns from '@libp2p/mdns' (DISC-02 locked dependency)",
    );
  });

  it('D2 (DISC-02): createNode wires mdns({ interval: 20000 }) in peerDiscovery', () => {
    assert.ok(
      src.includes('mdns({ interval: 20000 })') || src.includes('mdns({interval:20000})'),
      'createNode must wire mdns with interval:20000ms (DISC-02 20s discovery cadence)',
    );
  });

  it('D3 (Pitfall 1): peer:discovery handler explicitly calls node.dial()', () => {
    // mDNS does NOT auto-dial — the peer:discovery event only populates peerStore.
    // Without explicit node.dial(), peers appear in the store but 0 are connected.
    // Find the addEventListener('peer:discovery', ...) call — it appears later in
    // the file than the JSDoc references to 'peer:discovery' in the interface comment.
    const addListenerIdx = src.indexOf("addEventListener('peer:discovery'");
    assert.ok(
      addListenerIdx >= 0,
      "addEventListener('peer:discovery') must exist in peer-transport.ts",
    );
    // Look for node.dial( within 2000 chars after the event listener registration.
    const handlerWindow = src.slice(addListenerIdx, addListenerIdx + 2000);
    assert.ok(
      /node\.dial\(/.test(handlerWindow),
      'node.dial() MUST be called inside peer:discovery handler (Pitfall 1 — mDNS does not auto-dial)',
    );
  });

  it("D4 (DISC-02): peer:discovery handler labels non-bootstrap peers as 'mdns'", () => {
    // The handler now computes `method` (mdns vs bootstrap, since both emit the
    // same peer:discovery event) and persists it via mutatePeers. The
    // non-bootstrap branch MUST still resolve to 'mdns' — that is the DISC-02
    // invariant this test protects.
    assert.ok(
      src.includes('discovery_method: method'),
      'peer:discovery handler must persist the computed discovery_method via mutatePeers',
    );
    assert.ok(
      /\?\s*'bootstrap'\s*:\s*'mdns'/.test(src),
      "non-bootstrap discovery must be labelled 'mdns' (DISC-02)",
    );
  });

  it('D8 (Pitfall 2): mdns() is guarded by try/catch with Docker/WSL warning message', () => {
    // Docker bridge networks and WSL2 non-mirrored mode do not forward multicast.
    // Binding failure must not crash createNode — must log a warning and continue.
    assert.ok(
      /mDNS unavailable|multicast|Docker|WSL/i.test(src),
      'Docker/WSL warning text must be present in peer-transport.ts (Pitfall 2)',
    );
    // Structural check: mdns() appears inside a try block.
    // We look for 'try' followed by (up to 500 chars) 'mdns(' in the same region.
    assert.ok(
      /try\s*\{[\s\S]{0,500}mdns\(/.test(src),
      'mdns() call must be inside a try block (Pitfall 2 — Docker/WSL multicast bind may fail)',
    );
  });

  it('D9 (Pitfall 1 guard): minConnections not set as a config property (no auto-dial)', () => {
    // We use explicit node.dial() in peer:discovery. Setting minConnections as a
    // connectionManager property enables auto-dial which is unreliable for mDNS peers.
    // The source comment says "we do NOT set minConnections" — verify it only appears
    // in comments and not as a code property assignment.
    // Strip block and line comments, then assert minConnections is absent from code.
    const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const noComments = noBlockComments
      .split('\n')
      .map((line) => { const i = line.indexOf('//'); return i >= 0 ? line.slice(0, i) : line; })
      .join('\n');
    assert.ok(
      !noComments.includes('minConnections'),
      'minConnections must NOT appear in executable code — ' +
        'explicit node.dial() in peer:discovery is the correct pattern (Pitfall 1)',
    );
  });
});

// ─────────────────────── DISC-03: DHT wiring + Pitfall 4 ─────────────────────

describe('Phase 17: discovery — DHT wiring (DISC-03) + Pitfall 4', () => {
  const src = readFileSync(SRC_PEER_TRANSPORT, 'utf8');

  it("D5 (DISC-03): peer-transport.ts imports { kadDHT } from '@libp2p/kad-dht'", () => {
    assert.ok(
      /import\s*\{\s*kadDHT\s*\}\s*from\s*'@libp2p\/kad-dht'/.test(src),
      "must import kadDHT from '@libp2p/kad-dht' (DISC-03 locked dependency)",
    );
  });

  it('D6 (DISC-03): kadDHT wired with clientMode gated on dhtServer (client by default, server on seeds)', () => {
    assert.ok(
      /kadDHT\(\{\s*clientMode:\s*!dhtServer/.test(src),
      'DHT must wire clientMode: !dhtServer — leaves query (client); public seed nodes (dht.server) serve the routing table',
    );
  });

  it('D7 (Pitfall 4): identify not required for DHT clientMode:true — documented in source', () => {
    // Phase 17 rationale: clientMode:true means DHT queries without serving the routing
    // table, so identify is not needed for DHT to function.
    //
    // Phase 18 update: @libp2p/identify IS now imported because circuitRelayTransport's
    // RelayDiscovery unconditionally registers '@libp2p/identify' as a serviceDependency
    // (verified in @libp2p/circuit-relay-v2@4.2.0 dist/src/transport/index.js line 76-82).
    // The original Phase 17 "no identify import" assertion is superseded by this runtime
    // requirement. DHT still uses clientMode:true — the Pitfall 4 reasoning stands for DHT;
    // identify is added solely for circuitRelayTransport.
    assert.ok(
      /identify:\s*identify\(\)/.test(src),
      'identify() must be wired (required by circuit-relay + populates the DHT routing table)',
    );
    // The source comment must acknowledge Pitfall 4 explicitly.
    assert.ok(
      /Pitfall 4/.test(src),
      'Pitfall 4 (DHT + identify) must be acknowledged in peer-transport.ts comments',
    );
  });
});

// ─────────────────────── PeerRecord.discovery_method (Pitfall 6) ──────────────

describe('Phase 17: peer-store — PeerRecord.discovery_method migration (Pitfall 6)', () => {
  it('D10 (Pitfall 6): legacy peers.json (no discovery_method) loads without error', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wi-test-'));
    const peersPath = join(tmpDir, 'peers.json');

    // Pre-Phase 17 shape — no discovery_method field.
    const legacy: PeersFile = {
      version: 1,
      peers: [
        {
          id: 'peer-legacy-1',
          addrs: ['/ip4/127.0.0.1/tcp/9001'],
          addedAt: '2026-04-10T00:00:00Z',
        },
      ],
    };
    writeFileSync(peersPath, JSON.stringify(legacy, null, 2));

    const result = await loadPeers(peersPath);
    assert.ok(
      result.isOk(),
      `loadPeers must succeed on legacy file without discovery_method; got: ${
        result.isErr() ? result.error.type : ''
      }`,
    );
    const file = result._unsafeUnwrap();
    assert.equal(file.peers.length, 1);
    assert.equal(
      file.peers[0].discovery_method,
      undefined,
      'legacy peer without discovery_method field must load as undefined (backward compat — Pitfall 6)',
    );

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("D11 (Pitfall 6): addPeerRecord with discovery_method:'mdns' carries the field through", () => {
    const initial: PeersFile = { version: 1, peers: [] };
    const next = addPeerRecord(initial, {
      id: 'peer-mdns-1',
      addrs: ['/ip4/10.0.0.5/tcp/9001'],
      addedAt: '2026-04-12T00:00:00Z',
      discovery_method: 'mdns',
    });
    assert.equal(next.peers.length, 1, 'one peer added');
    assert.equal(
      next.peers[0].discovery_method,
      'mdns',
      "discovery_method must be preserved on the PeerRecord (Pitfall 6 — DISC-02 provenance tracking)",
    );
  });
});

// ─────────────────────── SearchError exhaustiveness (Pitfall 5) ───────────────

describe('Phase 17: domain/errors — SearchError exhaustiveness (Pitfall 5)', () => {
  const src = readFileSync(SRC_ERRORS, 'utf8');

  it('D12a (Pitfall 5): AppError union includes SearchError', () => {
    assert.ok(
      /AppError[\s\S]*?\|\s*SearchError/.test(src),
      'SearchError must be part of the AppError union — missing it breaks formatError exhaustiveness',
    );
  });

  it('D12b (Pitfall 5, V5 update): formatError handles all 5 SearchError cases exhaustively', () => {
    // V5 cutover: SearchUnauthorized (room-authorization gate) was
    // replaced with SearchProtocolMismatch (V4 envelope sent to V5 peer).
    assert.ok(
      src.includes("'SearchDimensionMismatch'"),
      "formatError must handle 'SearchDimensionMismatch'",
    );
    assert.ok(
      src.includes("'SearchProtocolMismatch'"),
      "formatError must handle 'SearchProtocolMismatch' (V5 replacement for SearchUnauthorized)",
    );
    assert.ok(
      src.includes("'SearchRateLimited'"),
      "formatError must handle 'SearchRateLimited'",
    );
    assert.ok(
      src.includes("'SearchProtocolError'"),
      "formatError must handle 'SearchProtocolError'",
    );
    assert.ok(
      src.includes("'SearchTimeout'"),
      "formatError must handle 'SearchTimeout'",
    );
  });
});

// (DISC-04 deferral doc-test removed: DISC-04 now shipped + default-on;
//  its .planning/ CONTEXT.md was purged from main.)

// ─────────────────────── PeerConfig defaults (Plan 01 foundation) ─────────────

describe('Phase 17: PeerConfig defaults (Plan 01 foundation)', () => {
  it('D14: empty config.yaml → mdns:true, dht.enabled:false, rate 10/sec, burst 30', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wi-cfg-'));
    const cfgPath = join(tmp, 'config.yaml');
    // Must be a valid YAML mapping — a comment-only file parses as null,
    // triggering GraphParseError. An empty mapping `{}` triggers all defaults.
    writeFileSync(cfgPath, '{}\n');

    const cfgRes = await loadConfig(cfgPath);
    assert.ok(cfgRes.isOk(), `empty config must load successfully; got: ${cfgRes.isErr() ? cfgRes.error.type : ''}`);
    const cfg = cfgRes._unsafeUnwrap();

    assert.equal(cfg.peer.mdns, true, 'mdns default must be true (DISC-02 locked)');
    assert.equal(cfg.peer.dht.enabled, true, 'dht default is now ENABLED (self-sovereign /folklore/kad/ DHT, default-on federation)');
    assert.equal(cfg.peer.dht.server, false, 'dht.server default must be false — client/query mode; only public seed nodes serve the routing table');
    assert.equal(
      cfg.peer.search_rate_limit.rate_per_sec,
      10,
      'rate_per_sec default must be 10 (CONTEXT.md locked: 10 req/s)',
    );
    assert.equal(
      cfg.peer.search_rate_limit.burst,
      30,
      'burst default must be 30 (CONTEXT.md locked: burst 30)',
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it('defaults are DIALABLE: 0.0.0.0 bind + the real tracker domain', async () => {
    // Regression guard for the three defaults that made WAN discovery a no-op:
    // a loopback bind (announces an address every peer dials against itself),
    // and a tracker URL on a domain we do not own.
    const tmp = mkdtempSync(join(tmpdir(), 'wi-cfg-'));
    const cfgPath = join(tmp, 'config.yaml');
    writeFileSync(cfgPath, '{}\n');

    const cfg = (await loadConfig(cfgPath))._unsafeUnwrap();

    assert.equal(
      cfg.peer.listen_host,
      '0.0.0.0',
      'daemon must bind all interfaces — a loopback-bound daemon can never be dialled, and UPnP is a no-op on it',
    );
    // FOLKLORE_TRACKER_URL is read once at module load, so an operator env var
    // legitimately wins here; only assert the shipped default when unset.
    if (process.env.FOLKLORE_TRACKER_URL === undefined) {
      assert.equal(
        cfg.peer.tracker.url,
        'https://usefolklore.sh',
        'tracker must point at the deployed Pages domain (usefolklore.com is not ours)',
      );
    }
    assert.equal(cfg.peer.tracker.namespace, 'folklore');
    assert.equal(cfg.peer.ws_port, 0, 'only a relay listens on ws; leaves stay TCP-only');
    assert.deepEqual(cfg.peer.announce, [], 'announce overrides are opt-in');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('ws_port + announce round-trip from config.yaml (the relay profile)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wi-cfg-'));
    const cfgPath = join(tmp, 'config.yaml');
    writeFileSync(
      cfgPath,
      'peer:\n  ws_port: 8080\n  announce:\n    - "/dns4/folklore-relay.fly.dev/tcp/443/wss"\n  relay_server: true\n',
    );

    const cfg = (await loadConfig(cfgPath))._unsafeUnwrap();

    assert.equal(cfg.peer.ws_port, 8080);
    assert.deepEqual(cfg.peer.announce, ['/dns4/folklore-relay.fly.dev/tcp/443/wss']);
    assert.equal(cfg.peer.relay_server, true);

    rmSync(tmp, { recursive: true, force: true });
  });
});
