# folklore peer tracker

A BitTorrent-style rendezvous for folklore peers, running as Cloudflare Pages
Functions on the existing site. It holds **peer pointers only** — `peerId` +
dial multiaddrs, per namespace, TTL-evicted — never any graph data. Search and
trace transfer stay peer-to-peer over libp2p; the tracker only solves *first
contact*, replacing "join the public IPFS DHT" as the default discovery path.

This is the "tracker" era of the plan (cheap, centralized, ship first). PEX and
an opt-in DHT come later; a relay node (see `deploy/bootstrap/`) covers NAT-hard
peers the tracker can't help directly.

## Endpoints

- `POST /tracker/announce` — body `{ ns, peerId, addrs[] }`. Registers the peer
  (TTL 180s) and returns the current swarm: `{ ok, ttl, peers }`. Announce
  doubles as fetch — one round trip, like a tracker announce/response.
- `GET /tracker/peers?ns=<ns>` — read-only directory: `{ ns, count, peers }`.

Validation (`_common.js`): namespace `^[a-z0-9._-]{1,64}$`; peerId is a real
libp2p id; every multiaddr must be well-formed **and self-addressed** — its
trailing `/p2p/<id>` must equal the announcer, so a peer can only publish dial
addresses for itself, never inject a pointer to a third party. Non-routable
literals (loopback, `0.0.0.0`, link-local) are rejected: a stored
`/ip4/127.0.0.1/…` pointer makes every other peer dial *itself*. Peers apply
the same filter before announcing (`announceableAddrs` in
`src/infrastructure/tracker-client.ts`), which also drops LAN-private ranges —
those are mDNS's job, not a public tracker's.

## Deploy

The tracker ships with the site (`pages_build_output_dir = "site"`), it just
needs a KV namespace bound as `TRACKER_KV` — already declared in
`wrangler.toml`, so a normal deploy carries it. To recreate from scratch:

```bash
# 1. create the KV namespace, copy the id into wrangler.toml ([[kv_namespaces]])
npx wrangler kv namespace create TRACKER_KV

# 2. deploy the Pages project (functions/ ships automatically)
npx wrangler pages deploy site
```

Verify the binding landed — an unbound tracker answers 500, not peers:

```bash
curl -s "https://usefolklore.sh/tracker/peers?ns=folklore"
# {"ns":"folklore","count":0,"peers":[]}          ← bound
# {"error":"tracker KV not bound"}                ← binding missing, discovery dead
```

Nodes point at it by default (`https://usefolklore.sh` — the deployed Pages
domain; note `usefolklore.com` is NOT ours and redirects elsewhere):

```bash
export FOLKLORE_TRACKER_URL=https://your-site.pages.dev
```

or in `~/.folklore/config.yaml`:

```yaml
peer:
  tracker:
    url: "https://usefolklore.sh"
    namespace: "folklore"
```

Set `url: ""` to run without a tracker (loopback / DHT-only).

## Local dev

`wrangler pages dev site` serves the functions with a local KV. For a
dependency-free stub used in the daemon integration test, see the two-peer
discovery flow in the repo's test notes — a plain Node server implementing this
same contract, backed by an in-memory map.

## Trust model

Like every tracker (eDonkey server, BT tracker), it's semi-trusted: it could
serve bogus peers. That costs a failed dial, nothing more — traces are
signature-verified on pull (`sig_valid`), so a malicious tracker cannot forge
knowledge, only waste a connection attempt. The client caps dial attempts per
round accordingly.
