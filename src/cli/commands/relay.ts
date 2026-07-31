/**
 * relay — run this process as a circuit-relay-v2 server and nothing else.
 *
 * A relay is infrastructure, not a knowledge peer: it forwards connections for
 * leaves that can never accept an inbound dial (CGNAT, symmetric NAT) and holds
 * no graph data, runs no ingestion, no embedder, no consolidation. `daemon _run`
 * would technically relay too, but it boots the entire memory stack to do it —
 * on a 512MB relay box that is an OOM kill, and it would file graph data on a
 * machine that is supposed to hold none.
 *
 * Config comes from the usual config.yaml `peer` block. The deployment shape is
 * ws behind a TLS edge:
 *
 *   peer:
 *     ws_port: 8080                                     # plain ws, edge terminates TLS
 *     announce: ["/dns4/<host>/tcp/443/wss"]            # what leaves actually dial
 *     relay_server: true
 *
 * Runs until SIGINT/SIGTERM.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../../infrastructure/config-loader.js';
import { loadOrCreateIdentity, createNode } from '../../infrastructure/peer-transport.js';

const folkloreHome = (): string => process.env.FOLKLORE_HOME || join(homedir(), '.folklore');

export async function relay(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'folklore relay — run a circuit-relay-v2 server for NAT-bound peers',
        '',
        'Reads peer.* from config.yaml. Relevant keys:',
        '  peer.port         raw TCP listen port',
        '  peer.ws_port      WebSocket listen port (0 = off; set behind a TLS edge)',
        '  peer.announce     multiaddrs to publish instead of the bound ones',
        '  peer.listen_host  interface to bind (0.0.0.0 on a public box)',
        '',
        'The relay forwards connections only — no graph, no ingestion, no daemon.',
      ].join('\n'),
    );
    return 0;
  }

  const home = folkloreHome();
  const cfgRes = await loadConfig(join(home, 'config.yaml'));
  if (cfgRes.isErr()) {
    console.error(`relay: config unreadable — ${cfgRes.error.type}`);
    return 1;
  }
  const peer = cfgRes.value.peer;

  const idRes = await loadOrCreateIdentity(join(home, 'peer-identity.json'));
  if (idRes.isErr()) {
    console.error(`relay: identity — ${idRes.error.type}`);
    return 1;
  }

  const nodeRes = await createNode(idRes.value, {
    listenPort: peer.port,
    listenHost: peer.listen_host,
    wsPort: peer.ws_port,
    announceAddrs: peer.announce,
    // A relay discovers nothing and queries nothing: no mDNS, no DHT, no
    // tracker client. Leaves come to IT, via the address we publish.
    mdns: false,
    dhtEnabled: false,
    upnp: false,
    relayServer: true,
  });
  if (nodeRes.isErr()) {
    console.error(`relay: libp2p — ${nodeRes.error.type}`);
    return 1;
  }
  const node = nodeRes.value;

  console.log(`relay: peerId ${idRes.value.peerId}`);
  for (const addr of node.getMultiaddrs()) {
    console.log(`relay: listening ${addr.toString()}`);
  }
  console.log('relay: ready — publish one of the addresses above as FOLKLORE_RELAYS');

  await new Promise<void>((resolve) => {
    const stop = (sig: string) => {
      console.log(`relay: ${sig} — draining`);
      resolve();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });

  await node.stop();
  return 0;
}
