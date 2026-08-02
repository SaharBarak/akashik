/**
 * folklore plugin for OpenClaw.
 *
 * Gives an OpenClaw agent a memory that (a) survives sessions, (b) is shared
 * with a P2P swarm, so a question another peer already researched is answered
 * from the graph instead of the web.
 *
 * Phase 1 (this file) wires the READ path: folklore registers as a memory
 * corpus supplement, so every memory search the agent runs also searches the
 * folklore graph and its connected peers. It composes with the operator's
 * existing memory backend instead of claiming the exclusive memory slot.
 *
 * Requires a folklore daemon on the same host (`folklore daemon start`). With
 * no daemon the plugin registers and then returns nothing — the agent behaves
 * exactly as if it weren't installed.
 */
import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from 'openclaw/plugin-sdk/plugin-entry';
import { registerMemoryCorpusSupplement } from 'openclaw/plugin-sdk/memory-core';
import { folkloreCorpus, CORPUS_NAME } from './corpus.js';
import { daemonAvailable, daemonSupports, socketPath } from './ipc.js';

const PLUGIN_ID = 'folklore';

// The explicit annotation is required: without it TS infers a type naming an
// internal SDK chunk path, which is not portable across installs (TS2742).
const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: PLUGIN_ID,
  name: 'folklore',
  description:
    'Federated knowledge-graph memory. Answers from your own graph and connected peers before the web.',
  register(api) {
    const log = api.logger ?? console;

    registerMemoryCorpusSupplement(PLUGIN_ID, folkloreCorpus());

    // Say plainly at boot whether this plugin can do anything at all. The
    // failure mode we are guarding against is silence: a plugin that loads,
    // finds no daemon, and quietly returns zero results forever looks
    // identical to a graph with nothing in it.
    if (!daemonAvailable()) {
      log.warn?.(
        `[${PLUGIN_ID}] no folklore daemon at ${socketPath()} — memory searches will return nothing. ` +
          'Start one with `folklore daemon start`.',
      );
      return;
    }

    log.info?.(`[${PLUGIN_ID}] corpus "${CORPUS_NAME}" registered — daemon at ${socketPath()}`);

    // A daemon that has been up for weeks runs whatever folklore was installed
    // when it started. `get` is newer than `ask`, so an old daemon serves
    // search hits the agent can then never read in full — a confusing
    // half-working state that deserves an explicit line in the log.
    void daemonSupports('get').then((ok) => {
      if (!ok) {
        log.warn?.(
          `[${PLUGIN_ID}] the running daemon predates \`folklore get\` — search will work but ` +
            'reading a hit in full will not. Restart it (`folklore daemon stop && folklore daemon start`) ' +
            'after upgrading folklore.',
        );
      }
    });
  },
});

export default plugin;
