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

**A cold daemon needs a few seconds before it is fast.** It pre-loads the graph
and embedder at boot — ~3 s on a 102k-node graph — and searches issued during
that window still succeed, just slower. After that, a memory search costs ~3 ms.
If you run both under Docker, start the folklore service first anyway, so the
first message of a session never races the warm-up.

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

Implemented:

- **Memory corpus** — search and retrieve across your graph and connected
  peers, alongside your existing memory backend.
- **Network-before-web** — when the graph already answers a `web_search` or
  `web_fetch`, the call is blocked and the agent gets the indexed context
  instead. Same thresholds and env knobs as folklore's Claude Code hook
  (`FOLKLORE_DENY_WEBSEARCH`, `FOLKLORE_DENY_THRESHOLD`,
  `FOLKLORE_DENY_MIN_HITS`, `FOLKLORE_ENERGY_GATE`), so one mental model
  covers both.

Not yet:

- **Capture** — filing what your agent learns back into the graph. The privacy
  classifier above is written and tested ahead of it, since that is the part
  that must be right before anything is written, let alone shared.
- **Answering without inference** — serving a peer's distilled answer in place
  of a model call, via `before_agent_run`. OpenClaw exposes the hook to do it;
  folklore's `resolved-query://` nodes are the source. Deliberately last: it is
  the most visible thing here and the one where a wrong-context reuse is worst.
