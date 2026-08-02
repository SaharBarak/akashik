/**
 * help — prints CLI usage.
 *
 * Every command registered in src/cli/index.ts appears here, grouped
 * by what a user is trying to do. tests/help-coverage gate keeps this
 * in sync with the router — add a command there, document it here.
 */

const HELP = `
folklore — P2P agent memory: local knowledge graph + federated retrieval

usage:
  folklore <command> [options]

getting started:
  onboard [--yes]         first-run installer — daemon, hooks, identity
  seed [--force|--dry-run]  seed a fresh graph with a curated concept corpus (warm cold-start)
  doctor [--fix]          check runtime prerequisites (and bootstrap with --fix)
  login                   link a verified GitHub identity to your DID (OAuth)
  claude install|uninstall  make Claude Code use the graph automatically (hooks + CLAUDE.md)
  harness list|install    register the folklore MCP server in other harnesses (Cursor/Cline/Zed/…)
  migrate v5              upgrade ~/.folklore/ from V4 (rooms) to V5 (workspace+private)
  update                  check for a signed release manifest + upgrade instructions

ask + save (daily loop):
  ask "<query>"           semantic search + context output (--peers = federated)
  save --label X --text Y file a typed node (--type synthesis|concept|decision, --private)
  recall <name>           entity-first lookup across the graph (+ connected peers)
  get <node-id>           print one node by its exact id (--json for the raw record)
  remember --transcript P distill a session transcript into one embedded memory node
  resume [--workspace W]   print the latest "where you left off" digest for this repo
  hot                     today's working set — recently touched nodes
  this [me|everyone]      index the current folder; 'everyone' shares it on P2P
  entity add|list|remove  manage the canonical entity registry

federation (P2P):
  peer <sub>              add | remove | list | status | label — manage peers
  live                    tail the served feed — watch peers pull from your tree
  share <peer-id>         share every non-private node with a peer (secrets-gated)
  unshare <peer-id>       revoke a prior share
  touch <peer-id>         one-shot pull of a peer's shared graph (redacted)
  oracle <sub>            bulletin board — ask/answer questions across the swarm
  swarm <sub>             swarm-sim corpus tools (virtual peer responders)
  relay                   run as a circuit-relay server for NAT-bound peers
  identity                show DID + key material status

ingest + index:
  init                    register external content sources (RSS / ArXiv / HN)
  sources <sub>           list | add | remove | enable | disable
  trigger                 fetch and index content from enabled sources
  discover                suggest new sources (--auto to add)
  discover-loop           continuous discovery agent
  index                   index the project codebase, deps, submodules, git history
  codebase <sub>          structured code-graph queries (tree-sitter index)
  sessions                ingest Claude Code session transcripts
  recent-sessions         list recently captured sessions

daemon + ops:
  daemon start|stop|status  background research daemon (IPC fast path + libp2p)
  jobs <sub>              background job queue — list | clear
  logs <sub>              daemon log inspection + export bundle
  metrics                 daemon counters/gauges/histograms snapshot (JSON)
  shadow                  shadow-search calibration receipts summary (RFC-0003)
  weights                 learned satisfaction-component weights report (RFC-0003)
  cache-stats             L1/L2 query cache hit rates
  gc                      auto-forget node retention (session/synthesis/decision tiers)
  prune-vectors           drop orphaned vectors (vec_meta rows absent from graph.json)
  lint                    validate graph invariants
  consolidate run <ws>    episodic→semantic consolidation pass
  eval <queries.jsonl>    retrieval quality eval — recall@k, NDCG@k, MRR
  bench <sub>             retrieval + latency benchmarks

output + publishing:
  report                  generate a knowledge graph report
  viz                     render the graph to a static visualization
  dashboard [--port N]    browser dashboard (search, workspaces, inspector)
  export                  export the graph to an Obsidian vault
  publish auth|tweet|thread|launch|preview  post to X/Twitter (OAuth 2.0)
  mcp start               run the MCP server (Claude Code auto-spawns this)

  version | help
`.trimStart();

export function printHelp(_args: string[]): number {
  process.stdout.write(HELP);
  return 0;
}
