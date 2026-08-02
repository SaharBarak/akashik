# folklore for OpenClaw

Federated knowledge-graph memory. Your agent answers from your own graph and
from connected peers before it reaches for the web — and what one peer
researches, every peer can answer.

```
openclaw plugins install @usefolklore/openclaw-plugin
```

## What it does

folklore registers as a **memory corpus** inside OpenClaw. Every memory search
your agent runs also searches:

- your local folklore graph — everything you've read, fetched, or distilled;
- the graph of every peer you're connected to, over P2P.

It does **not** claim OpenClaw's exclusive memory slot, so it runs alongside
whatever memory backend you already use (builtin, LanceDB, mem0, Redis). It
adds a corpus; it doesn't replace your memory.

## Requirements

A folklore daemon on the same host:

```bash
npm i -g @usefolklore/folklore
folklore daemon start
```

The plugin talks to it over `$FOLKLORE_HOME/daemon.sock` (default
`~/.folklore/daemon.sock`). It holds no graph state of its own and pulls no
heavy dependencies into your gateway process — no embedder, no sqlite, no
libp2p. That work lives in the daemon.

**With no daemon running the plugin degrades to silence**, not to errors: every
search returns zero results and your agent behaves exactly as if the plugin
weren't installed. The gateway log says so at boot:

```
[folklore] no folklore daemon at ~/.folklore/daemon.sock — memory searches will
           return nothing. Start one with `folklore daemon start`.
```

If you upgrade folklore, restart the daemon. A long-running daemon serves
whatever version it started with, and the plugin will warn you if it finds one
too old to answer a retrieval.

## What leaves your machine

**Nothing personal. Ever.** This is the part worth reading carefully.

folklore's own default is that knowledge federates unless flagged private —
right for a research graph built from public sources. An OpenClaw agent's
memory is a different kind of corpus: WhatsApp threads, iMessage, your
landlord's name, which card to book the flight with. So this plugin **inverts
that default**.

Everything captured is private unless it clears an explicit allowlist:

| Federates | Never federates |
|---|---|
| Pages fetched over `http(s)` | Anything from a direct message |
| arXiv papers, RSS, web searches | Anything on WhatsApp / iMessage / Signal / Telegram / SMS / email |
| Git repos, npm packages | Anything authored from conversation |
| Notes distilled *entirely* from the above | Notes distilled from *any* private source |

A synthesis inherits the strictest verdict of its parents — a summary of a
private chat is still about that chat. Unrecognised shapes stay private. A URL
someone sent you in a DM is still a DM.

The policy is one pure function (`src/classify.ts`) with adversarial tests, and
every verdict carries a human-readable reason so the decision is auditable
rather than implicit.

## Docker

The plugin needs to see the daemon's socket. Share the folklore home:

```yaml
services:
  folklore:
    image: node:22-slim
    command: sh -c "npm i -g @usefolklore/folklore && folklore daemon _run"
    environment:
      FOLKLORE_HOME: /data
    volumes:
      - folklore-data:/data

  openclaw:
    image: openclaw/openclaw
    environment:
      FOLKLORE_HOME: /data
    volumes:
      - folklore-data:/data   # same volume → same daemon.sock

volumes:
  folklore-data:
```

## Also available: the MCP server

Independently of this plugin, folklore ships an MCP server exposing 17 graph
tools (`ask`, `search`, `federated_search`, `get_node`, `find_tunnels`,
`oracle_ask`, …):

```bash
folklore harness install --only openclaw
```

The plugin gives you memory that works without the agent thinking about it; the
MCP server gives the agent tools it can reach for deliberately. They compose.

## Status

Read path (search + retrieve, local + peers) is implemented. The capture path
— filing what your agent learns back into the graph — is next, and the privacy
classifier above already gates it.
