/**
 * folklore as an OpenClaw memory corpus.
 *
 * `registerMemoryCorpusSupplement` adds a searchable corpus ALONGSIDE whatever
 * memory backend the operator already runs (builtin, LanceDB, mem0, …) rather
 * than claiming the exclusive memory slot. That matters commercially as much
 * as technically: the slot is winner-take-all, so a slot-claiming plugin can
 * only be installed by people willing to drop their existing memory. A
 * supplement composes with all of them.
 *
 * The mapping is: folklore `ask --json` hits → MemoryCorpusSearchResult, and
 * `folklore get <id> --json` → MemoryCorpusGetResult.
 */
import { ipcJson } from './ipc.js';

/** Shape of one hit from `folklore ask --json`. */
interface FolkloreHit {
  readonly id: string;
  readonly label?: string;
  readonly type?: string;
  readonly score?: number;
  readonly distance?: number;
  readonly snippet?: string;
  readonly summary?: string;
  readonly source_uri?: string;
  readonly fetched_at?: string;
  readonly age_days?: number;
  readonly peer?: string;
}

interface FolkloreAsk {
  readonly hits?: readonly FolkloreHit[];
  readonly satisfaction?: number;
}

interface FolkloreNode {
  readonly id: string;
  readonly label?: string;
  readonly type?: string;
  readonly text?: string;
  readonly summary?: string;
  readonly source_uri?: string;
  readonly fetched_at?: string;
  readonly peer?: string;
}

export const CORPUS_NAME = 'folklore';

/** Search hits carry age; a reader deciding whether to trust a cached answer
 *  needs it inline, which is why folklore renders `[3d]` in its own hooks. */
const provenance = (hit: { peer?: string; age_days?: number }): string => {
  const origin = hit.peer ? `peer ${hit.peer}` : 'local graph';
  return typeof hit.age_days === 'number' ? `${origin}, ${Math.round(hit.age_days)}d old` : origin;
};

/**
 * folklore reports similarity as a distance in some paths and a score in
 * others. OpenClaw ranks on `score` where higher is better, so normalise.
 */
const toScore = (hit: FolkloreHit): number => {
  if (typeof hit.score === 'number') return hit.score;
  if (typeof hit.distance === 'number') return 1 / (1 + Math.max(0, hit.distance));
  return 0;
};

export const mapSearchHit = (hit: FolkloreHit): {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  score: number;
  snippet: string;
  id: string;
  citation?: string;
  source?: string;
  provenanceLabel: string;
  sourceType: string;
  updatedAt?: string;
} => ({
  corpus: CORPUS_NAME,
  // OpenClaw addresses corpus entries by `path`; folklore's node id IS its
  // address, and round-trips through `get`.
  path: hit.id,
  title: hit.label,
  kind: hit.type,
  score: toScore(hit),
  snippet: hit.snippet ?? hit.summary ?? '',
  id: hit.id,
  citation: hit.source_uri,
  source: hit.source_uri,
  provenanceLabel: provenance(hit),
  sourceType: hit.peer ? 'folklore-peer' : 'folklore-local',
  updatedAt: hit.fetched_at,
});

/**
 * Build the corpus supplement. `search` and `get` both return empty/null when
 * the daemon is unreachable, so an OpenClaw turn is never blocked by folklore
 * being down.
 */
export const folkloreCorpus = (opts: { readonly timeoutMs?: number } = {}) => ({
  async search(params: {
    query: string;
    maxResults?: number;
    agentSessionKey?: string;
  }): Promise<ReturnType<typeof mapSearchHit>[]> {
    const query = params.query?.trim();
    if (!query) return [];
    const k = Math.max(1, Math.min(params.maxResults ?? 5, 25));

    const res = await ipcJson<FolkloreAsk>(
      'ask',
      [query, '--json', '--k', String(k)],
      opts.timeoutMs,
    );
    if (!res || !Array.isArray(res.hits)) return [];
    return res.hits.slice(0, k).map(mapSearchHit);
  },

  async get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentSessionKey?: string;
  }): Promise<{
    corpus: string;
    path: string;
    title?: string;
    kind?: string;
    content: string;
    fromLine: number;
    lineCount: number;
    id: string;
    provenanceLabel: string;
    sourceType: string;
    sourcePath?: string;
    updatedAt?: string;
  } | null> {
    const lookup = params.lookup?.trim();
    if (!lookup) return null;

    const node = await ipcJson<FolkloreNode>('get', [lookup, '--json'], opts.timeoutMs);
    if (!node || !node.id) return null;

    const body = node.text ?? node.summary ?? '';
    const lines = body.split('\n');
    const from = Math.max(0, params.fromLine ?? 0);
    const count = params.lineCount ?? lines.length;
    const slice = lines.slice(from, from + count);

    return {
      corpus: CORPUS_NAME,
      path: node.id,
      title: node.label,
      kind: node.type,
      content: slice.join('\n'),
      fromLine: from,
      lineCount: slice.length,
      id: node.id,
      provenanceLabel: provenance(node as { peer?: string }),
      sourceType: node.peer ? 'folklore-peer' : 'folklore-local',
      sourcePath: node.source_uri,
      updatedAt: node.fetched_at,
    };
  },
});
