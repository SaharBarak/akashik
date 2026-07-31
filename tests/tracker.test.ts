// Tracker tests — the HTTP rendezvous (BitTorrent-tracker model).
//   1. Worker-side validation (_common.js): the security property that a peer
//      may only announce dial addresses for ITSELF.
//   2. Client I/O (tracker-client.ts): announce + fetchPeers against a real
//      loopback server implementing the same contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { sanitizeAddrs, validPeerId, validNamespace } from '../functions/tracker/_common.js';
import { announce, announceableAddrs, fetchPeers } from '../src/infrastructure/tracker-client.js';

const A = '12D3KooWAT8PmSZdzUaNFTxafhafHF9m34HT9pgyx54mbXLyXksS';
const B = '12D3KooWKfQpEMbUGryqE91Hyi8st18tZgR1sB1kijHwxxJRZ2k9';
// TEST-NET-3 (203.0.113.0/24) — a routable-shaped literal, so the fixtures
// exercise the accept path rather than the non-routable reject path.
const addrA = `/ip4/203.0.113.10/tcp/4211/p2p/${A}`;

test('validNamespace / validPeerId gate junk input', () => {
  assert.equal(validNamespace('folklore'), true);
  assert.equal(validNamespace('Bad NS!'), false);
  assert.equal(validNamespace('x'.repeat(65)), false);
  assert.equal(validPeerId(A), true);
  assert.equal(validPeerId('not-a-peer-id'), false);
});

test('sanitizeAddrs accepts a well-formed self-addressed multiaddr', () => {
  assert.deepEqual(sanitizeAddrs([addrA], A), [addrA]);
});

test('sanitizeAddrs REJECTS a multiaddr addressed to another peer (no third-party injection)', () => {
  // addr ends in /p2p/<A> but the announcer claims to be B → dropped.
  assert.deepEqual(sanitizeAddrs([addrA], B), []);
});

test('sanitizeAddrs accepts a relayed /p2p-circuit addr (NAT/CGNAT peers) but rejects a spoofed one', () => {
  const R = '12D3KooWCEMTaLeURA8p9YewshQ9sBWo4oHWSDf6z31ZdPw6UL7z'; // relay id
  const circuit = `/ip4/5.6.7.8/tcp/4001/p2p/${R}/p2p-circuit/p2p/${A}`;
  const circuitWss = `/dns4/relay.usefolklore.com/tcp/443/wss/p2p/${R}/p2p-circuit/p2p/${A}`;
  assert.deepEqual(sanitizeAddrs([circuit], A), [circuit]);
  assert.deepEqual(sanitizeAddrs([circuitWss], A), [circuitWss]);
  // ends in the RELAY's id, not the announcer's → third-party injection, dropped.
  const spoof = `/ip4/5.6.7.8/tcp/4001/p2p/${A}/p2p-circuit/p2p/${R}`;
  assert.deepEqual(sanitizeAddrs([spoof], A), []);
});

test('sanitizeAddrs drops malformed / oversized / duplicate addrs and caps count', () => {
  assert.deepEqual(sanitizeAddrs(['garbage', '', 42, null], A), []);
  assert.deepEqual(sanitizeAddrs([addrA, addrA], A), [addrA]); // dedup
  const many = Array.from({ length: 20 }, (_, i) => `/ip4/203.0.113.10/tcp/${5000 + i}/p2p/${A}`);
  assert.equal(sanitizeAddrs(many, A).length, 8); // MAX_ADDRS
});

test('sanitizeAddrs REJECTS non-routable literals (a loopback pointer poisons the directory)', () => {
  for (const bad of [
    `/ip4/127.0.0.1/tcp/4211/p2p/${A}`,
    `/ip4/0.0.0.0/tcp/4211/p2p/${A}`,
    `/ip4/169.254.7.7/tcp/4211/p2p/${A}`,
    `/ip6/::1/tcp/4211/p2p/${A}`,
    `/ip6/fe80::1/tcp/4211/p2p/${A}`,
  ]) {
    assert.deepEqual(sanitizeAddrs([bad], A), [], bad);
  }
});

test('announceableAddrs publishes only dialable addrs; circuit always survives', () => {
  const R = '12D3KooWCEMTaLeURA8p9YewshQ9sBWo4oHWSDf6z31ZdPw6UL7z';
  const loopback = `/ip4/127.0.0.1/tcp/4103/p2p/${A}`;
  const lan = `/ip4/192.168.1.20/tcp/4103/p2p/${A}`;
  const cgnat = `/ip4/100.71.0.9/tcp/4103/p2p/${A}`;
  const circuit = `/ip4/5.6.7.8/tcp/4001/p2p/${R}/p2p-circuit/p2p/${A}`;

  assert.deepEqual(announceableAddrs([loopback, lan, cgnat, addrA, circuit]), [addrA, circuit]);
  // A daemon bound to loopback has nothing to publish → caller falls back to fetch.
  assert.deepEqual(announceableAddrs([loopback]), []);
  // Escape hatch for a self-hosted LAN tracker without multicast.
  assert.deepEqual(announceableAddrs([loopback, lan], true), [lan]);
});

// ── client I/O against a loopback server implementing the contract ──
const startServer = (): Promise<{ server: Server; url: string }> =>
  new Promise((resolve) => {
    const store = new Map<string, { peerId: string; addrs: string[] }>();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const json = (s: number, o: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST' && url.pathname === '/tracker/announce') {
        let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
          const { ns, peerId, addrs } = JSON.parse(raw);
          const clean = sanitizeAddrs(addrs, peerId);
          store.set(`${ns}:${peerId}`, { peerId, addrs: clean });
          const peers = [...store.values()].filter((p) => p.peerId !== peerId);
          json(200, { ok: true, ttl: 180, peers });
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/tracker/peers') {
        const peers = [...store.values()];
        json(200, { ns: url.searchParams.get('ns'), count: peers.length, peers });
        return;
      }
      json(404, { error: 'nope' });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });

test('announce registers self and returns the rest of the swarm; fetchPeers lists all', async () => {
  const { server, url } = await startServer();
  try {
    const addrB = `/ip4/203.0.113.11/tcp/4212/p2p/${B}`;
    const first = await announce(url, 'folklore', A, [addrA]);
    assert.equal(first.isOk(), true);
    if (first.isOk()) assert.deepEqual(first.value.peers, []); // alice alone

    const second = await announce(url, 'folklore', B, [addrB]);
    assert.equal(second.isOk(), true);
    if (second.isOk()) {
      assert.equal(second.value.peers.length, 1);
      assert.equal(second.value.peers[0].peerId, A); // bob sees alice
    }

    const all = await fetchPeers(url, 'folklore');
    assert.equal(all.isOk(), true);
    if (all.isOk()) assert.equal(all.value.length, 2);
  } finally {
    server.close();
  }
});

test('announce surfaces a transport error as Err, never throws', async () => {
  const res = await announce('http://127.0.0.1:1/', 'folklore', A, [addrA], 500);
  assert.equal(res.isErr(), true);
});
