# Folklore relay node

A public, always-on **circuit-relay-v2 server**. Most folklore peers are home
machines behind CGNAT or symmetric NAT with dynamic IPs — they can discover each
other via the tracker but can't accept an inbound dial. This relay gives them a
reachable address: a leaf reserves a slot, advertises
`/…/p2p-circuit/p2p/<its-id>` to the tracker, and other peers dial it through the
relay. dcutr then upgrades to a direct connection when the NAT permits; pairs
that can't hole-punch stay relayed. Payloads are KB-scale, so the relay's
bandwidth cost is negligible and one box serves a large swarm.

This is the "TURN" tier of the plan. Discovery (the tracker, `functions/tracker/`)
is the "signaling" tier; this closes the reachability gap the tracker can't.

## Why a separate box (not Cloudflare)

A relay must hold long-lived connections. Cloudflare Workers/Pages are
serverless — no persistent socket — so the tracker can live there but the relay
cannot. It needs any always-on host with a public IP. Fly is one option (config
here); a $4 VPS or your own always-on machine works identically.

## Why WebSockets on 443, not raw TCP

The leaves that need a relay are exactly the ones on hostile networks — CGNAT,
hotel wifi, corporate egress filters. Those networks routinely allow 443 and
nothing else, so the relay listens for `wss` on 443 rather than raw TCP on a
custom port. It also removes an infrastructure cost: an anycast/shared IPv4
(Fly's default) forwards only 80/443, so raw TCP would need a dedicated IP.

TLS terminates at the edge, which proxies the WebSocket upgrade to the plain-ws
listener inside the container (`peer.ws_port`, 8080). That costs no security
property: libp2p's noise handshake authenticates the peer id end-to-end, so the
edge sees an opaque encrypted stream either way.

## Deploy (Fly.io)

```bash
cd deploy/relay
fly apps create folklore-relay
fly volumes create folklore_data --size 1 --region iad
fly deploy
```

Any Docker host works too — put your own TLS terminator (Caddy, nginx, Cloudflare)
in front of 8080, or expose it directly on a trusted network:

```bash
docker build -t folklore-relay .
docker run -p 8080:8080 -p 4103:4103 -v folklore_data:/data \
  -e FOLKLORE_ANNOUNCE=/dns4/your-host.example/tcp/443/wss \
  folklore-relay
```

## After first boot: publish the relay address

The node generates a stable identity on the mounted volume. Capture its peerId:

```bash
fly logs | grep 'p2p listening'   # or: docker logs <container> | grep 'p2p listening'
# → p2p listening: /dns4/folklore-relay.fly.dev/tcp/443/wss/p2p/<RELAY_PEER_ID>
```

Publish that multiaddr as the network default so every install reserves a slot
automatically:

```bash
export FOLKLORE_RELAYS="/dns4/folklore-relay.fly.dev/tcp/443/wss/p2p/<RELAY_PEER_ID>"
```

or in `~/.folklore/config.yaml`:

```yaml
peer:
  relays:
    - "/dns4/folklore-relay.fly.dev/tcp/443/wss/p2p/<RELAY_PEER_ID>"
```

A custom hostname works the same — point DNS at the app, issue a cert
(`fly certs add relay.usefolklore.sh`), and set `peer.announce` to match. The
announced host must be the one leaves dial, or their reservations resolve to an
address nobody can reach.

A leaf with a relay configured reserves a slot on boot; its `getMultiaddrs()`
then includes the `/p2p-circuit` address, which the tracker-rendezvous loop
announces automatically (the tracker now accepts circuit multiaddrs).

## Notes

- **Run more than one** (different regions) for redundancy — leaves reserve on
  each configured relay, so a relay dying just removes one path.
- **Data limits are off** (`applyDefaultLimit: false`) so relayed federation
  streams aren't severed after the default ~2min/128KB. This is our own relay
  and payloads are small; revisit if you open the relay to untrusted swarms.
- The relay runs no DHT and no tracker client — it forwards connections only,
  never discovers peers or holds graph data.
