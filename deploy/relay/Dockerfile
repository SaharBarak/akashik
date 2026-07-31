# Folklore relay node — a public, always-on circuit-relay-v2 server so peers
# behind CGNAT / symmetric NAT (who can never accept an inbound dial) get a
# reachable /…/p2p-circuit address. Leaf nodes reserve a slot here, advertise
# the relayed address to the tracker, and dcutr upgrades to a direct connection
# whenever the NAT permits; the genuinely-stuck pairs stay relayed. folklore
# payloads are KB-scale, so one modest box relays a large swarm.
#
# Like the bootstrap node, it generates its OWN libp2p identity on first boot
# into the mounted volume, so the peerId is stable across restarts and no key is
# baked into the image. Capture the peerId after first deploy (see README) and
# publish the multiaddr as the network default (FOLKLORE_RELAYS).
FROM node:22-slim

# ca-certificates is NOT in node:*-slim — without it git's TLS verification of
# github.com fails outright ("server certificate verification failed").
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Build folklore from source (public repo). FOLKLORE_REF pins the branch/tag —
# override it (`fly deploy --build-arg FOLKLORE_REF=v5.1.0`) to run a release
# rather than whatever main happens to be, or to deploy a fix before it merges.
ARG FOLKLORE_REF=main
RUN git clone --depth 1 --branch "$FOLKLORE_REF" https://github.com/usefolklore/folklore.git . \
  && npm ci \
  && npm run build

# Runtime data (identity) lives on a mounted volume so the peerId persists.
# Relay config: relay_server on, listen on all interfaces, DHT + tracker off
# (a relay is infrastructure, not a knowledge peer — it doesn't discover or
# hold graph data, it only forwards connections).
#
# ws_port 8080 is the reachable listener: the edge terminates TLS on 443 and
# proxies the WebSocket upgrade here, so `announce` publishes the wss form
# rather than the bound one (libp2p appends /p2p/<peerId> itself). Port 4103
# stays for direct TCP dials from hosts that can reach it.
#
# NOTE: the announce hostname must match the deployment. Override at runtime
# with FOLKLORE_ANNOUNCE=/dns4/<your-host>/tcp/443/wss when self-hosting.
ENV FOLKLORE_HOME=/data

# The template lives in the IMAGE, not in /data — /data is a mounted volume, so
# anything written there at build time is shadowed the moment the volume mounts.
# The entrypoint seeds it on first boot only, leaving operator edits intact.
RUN printf 'peer:\n  port: 4103\n  ws_port: 8080\n  listen_host: "0.0.0.0"\n  announce:\n    - "/dns4/folklore-relay.fly.dev/tcp/443/wss"\n  mdns: false\n  upnp: false\n  relay_server: true\n  dht:\n    enabled: false\n    public: false\n  tracker:\n    url: ""\ndaemon:\n  interval_seconds: 3600\n' > /app/relay-config.template.yaml

RUN printf '#!/bin/sh\nset -e\nmkdir -p "$FOLKLORE_HOME"\nif [ ! -f "$FOLKLORE_HOME/config.yaml" ]; then\n  cp /app/relay-config.template.yaml "$FOLKLORE_HOME/config.yaml"\n  echo "relay: seeded $FOLKLORE_HOME/config.yaml from image template"\nfi\nexec node dist/cli/index.js daemon _run\n' > /app/entrypoint.sh \
  && chmod +x /app/entrypoint.sh

EXPOSE 4103 8080
CMD ["/app/entrypoint.sh"]
