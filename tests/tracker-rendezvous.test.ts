// Tracker-rendezvous tick tests — the discovery loop that announces our dial
// addrs to the tracker and dials newly-discovered peers. Runs against a real
// loopback tracker (same contract as functions/tracker/*) and a mock libp2p
// node, so it's fast + deterministic (no real p2p, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { sanitizeAddrs } from '../functions/tracker/_common.js';
import { trackerTick, MAX_DIALS_PER_ROUND } from '../src/infrastructure/tracker-rendezvous.js';

const SELF = '12D3KooWSELFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const selfAddr = `/ip4/203.0.113.10/tcp/4500/p2p/${SELF}`;

// Minimal libp2p mock: only the surface trackerTick + dialAndTag touch.
const makeNode = (opts: { self?: string; addrs?: string[]; connected?: string[] } = {}) => {
  const dialed: string[] = [];
  const connectedSet = new Set(opts.connected ?? []);
  const node = {
    peerId: { toString: () => opts.self ?? SELF },
    getMultiaddrs: () => (opts.addrs ?? [selfAddr]).map((a) => ({ toString: () => a })),
    getPeers: () => [...connectedSet].map((id) => ({ toString: () => id })),
    dial: async (ma: { getPeerId?: () => string; toString: () => string }) => {
      const s = ma.toString();
      dialed.push(s);
      // remotePeer = the /p2p/<id> tail of the multiaddr
      const id = s.slice(s.lastIndexOf('/p2p/') + 5);
      return { remotePeer: { toString: () => id, equals: (o: { toString: () => string }) => o.toString() === id } };
    },
    peerStore: { merge: async () => undefined },
  };
  return { node: node as never, dialed };
};

const startTracker = (): Promise<{ server: Server; url: string }> =>
  new Promise((resolve) => {
    const store = new Map<string, { peerId: string; addrs: string[] }>();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const json = (s: number, o: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST' && url.pathname === '/tracker/announce') {
        let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
          const { ns, peerId, addrs } = JSON.parse(raw);
          store.set(`${ns}:${peerId}`, { peerId, addrs: sanitizeAddrs(addrs, peerId) });
          json(200, { ok: true, ttl: 180, peers: [...store.values()].filter((p) => p.peerId !== peerId) });
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
      const a = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` });
    });
  });

// Seed a peer into the tracker so the tick has someone to discover.
const seedPeer = async (url: string, peerId: string, addr: string) => {
  await fetch(`${url}/tracker/announce`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ns: 'folklore', peerId, addrs: [addr] }),
  });
};

test('trackerTick announces self and dials a freshly-discovered peer', async () => {
  const { server, url } = await startTracker();
  try {
    const B = '12D3KooWPEERBxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    await seedPeer(url, B, `/ip4/203.0.113.11/tcp/4600/p2p/${B}`);
    const { node, dialed } = makeNode();
    const n = await trackerTick({ node, trackerUrl: url, namespace: 'folklore', log: () => {} });
    assert.equal(n, 1, 'should dial the one discovered peer');
    assert.equal(dialed.length, 1);
    assert.ok(dialed[0].endsWith(`/p2p/${B}`));
  } finally { server.close(); }
});

test('trackerTick with only non-routable addrs falls back to fetch (never announces junk)', async () => {
  const { server, url } = await startTracker();
  try {
    const B = '12D3KooWPEERBxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    await seedPeer(url, B, `/ip4/203.0.113.11/tcp/4600/p2p/${B}`);
    // A daemon bound to loopback: nothing publishable, but discovery still works.
    const { node, dialed } = makeNode({ addrs: [`/ip4/127.0.0.1/tcp/4500/p2p/${SELF}`] });
    const n = await trackerTick({ node, trackerUrl: url, namespace: 'folklore', log: () => {} });
    assert.equal(n, 1, 'read-only fetch still discovers and dials');
    assert.ok(dialed[0].endsWith(`/p2p/${B}`));

    // ...and we are absent from the directory, having announced nothing.
    const listed = await (await fetch(`${url}/tracker/peers?ns=folklore`)).json();
    assert.deepEqual(listed.peers.map((p: { peerId: string }) => p.peerId), [B]);
  } finally { server.close(); }
});

test('trackerTick skips self and already-connected peers', async () => {
  const { server, url } = await startTracker();
  try {
    const B = '12D3KooWPEERBxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    await seedPeer(url, SELF, selfAddr);                                  // ourselves
    await seedPeer(url, B, `/ip4/203.0.113.11/tcp/4600/p2p/${B}`);           // already connected
    const { node, dialed } = makeNode({ connected: [B] });
    const n = await trackerTick({ node, trackerUrl: url, namespace: 'folklore', log: () => {} });
    assert.equal(n, 0, 'self is excluded by the tracker response; connected peer is skipped');
    assert.equal(dialed.length, 0);
  } finally { server.close(); }
});

test('trackerTick caps dial attempts per round', async () => {
  const { server, url } = await startTracker();
  try {
    for (let i = 0; i < MAX_DIALS_PER_ROUND + 5; i++) {
      const id = `12D3KooWFLOOD${String(i).padStart(4, '0')}xxxxxxxxxxxxxxxxxxxx`;
      await seedPeer(url, id, `/ip4/203.0.113.12/tcp/${5000 + i}/p2p/${id}`);
    }
    const { node, dialed } = makeNode();
    await trackerTick({ node, trackerUrl: url, namespace: 'folklore', log: () => {} });
    assert.ok(dialed.length <= MAX_DIALS_PER_ROUND, `dials (${dialed.length}) must be capped at ${MAX_DIALS_PER_ROUND}`);
  } finally { server.close(); }
});

test('trackerTick on a dead tracker returns 0 and does not throw', async () => {
  const { node } = makeNode();
  const n = await trackerTick({ node, trackerUrl: 'http://127.0.0.1:1', namespace: 'folklore', log: () => {}, intervalMs: 1 });
  assert.equal(n, 0);
});
