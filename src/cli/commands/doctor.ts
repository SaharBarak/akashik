/**
 * doctor — checks runtime prerequisites for folklore.
 *
 * Phase 1 scope:
 *   - Node >= 20
 *   - a Python >= 3.10 reachable on PATH (probed python3.13→python3.10→python3)
 *   - plugin manifest present (.claude-plugin/plugin.json)
 *   - vendor/graphify submodule present (pyproject.toml + graphify/ package)
 *   - ~/.folklore/venv exists and can `import graphify`
 *   - schema patch landed (graphify.validate.OPTIONAL_NODE_FIELDS matches spec)
 *
 * `doctor --fix` runs scripts/bootstrap.sh to create the venv and install
 * graphify in editable mode.
 *
 * Exit codes:
 *   0 — all blocking checks pass
 *   1 — one or more blocking issues (use --fix for the ones that support it)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../infrastructure/config-loader.js';

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
  /** optional hint shown when the check fails */
  fix?: string;
};

const EXPECTED_OPTIONAL_NODE_FIELDS = [
  'embedding_id',
  'fetched_at',
  'room',
  'source_uri',
  'wing',
];

function repoRoot(): string {
  // dist/cli/commands/doctor.js → ../../..
  // src/cli/commands/doctor.ts  → ../../..
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
}

function folkloreHome(): string {
  return process.env.FOLKLORE_HOME || join(homedir(), '.folklore');
}

function venvPython(): string {
  return join(folkloreHome(), 'venv', 'bin', 'python');
}

function checkNode(): Check {
  const required = 20;
  const major = Number(process.versions.node.split('.')[0]);
  return {
    name: 'Node.js >= 20',
    ok: major >= required,
    detail: `found ${process.versions.node}`,
    blocking: true,
    fix: 'install Node 20+ (e.g. `brew install node@20`)',
  };
}

/**
 * probe for any python >= 3.10 — matches bootstrap.sh order.
 *
 * OPTIONAL: the graphify sidecar (ingest schema-validation + `folklore viz`)
 * uses Python, but the core path — MCP server, `ask`, the energy/deny gate,
 * vectors via better-sqlite3 + sqlite-vec, the MiniLM embedder via Xenova —
 * is pure Node. A Node-only install is fully functional, so a missing Python
 * is a [WARN], never a blocker.
 */
function checkHostPython(): Check {
  const candidates = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3'];
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
      encoding: 'utf8',
    });
    if (r.status !== 0 || !r.stdout) continue;
    const [maj, min] = r.stdout.trim().split('.').map(Number);
    if (maj >= 3 && min >= 10) {
      return {
        name: 'Python >= 3.10 (optional sidecar)',
        ok: true,
        detail: `${bin} ${r.stdout.trim()}`,
        blocking: false,
      };
    }
  }
  return {
    name: 'Python >= 3.10 (optional sidecar)',
    ok: false,
    detail: 'no python >= 3.10 on PATH — graphify sidecar disabled (core runs on Node alone)',
    blocking: false,
    fix: 'only if you want the ingest/viz sidecar: install Python 3.10+ (e.g. `brew install python@3.12`)',
  };
}

function checkPluginManifest(): Check {
  const manifest = join(repoRoot(), '.claude-plugin', 'plugin.json');
  return {
    name: 'plugin manifest',
    ok: existsSync(manifest),
    detail: existsSync(manifest)
      ? '.claude-plugin/plugin.json present'
      : 'missing .claude-plugin/plugin.json',
    blocking: false,
  };
}

function checkGraphifySubmodule(): Check {
  const pyproject = join(repoRoot(), 'vendor', 'graphify', 'pyproject.toml');
  const pkg = join(repoRoot(), 'vendor', 'graphify', 'graphify', '__init__.py');
  const ok = existsSync(pyproject) && existsSync(pkg);
  return {
    name: 'graphify submodule (optional)',
    ok,
    detail: ok ? 'vendor/graphify present' : 'vendor/graphify absent — sidecar disabled (core runs on Node alone)',
    blocking: false,
    fix: 'only for the sidecar: `git submodule update --init --recursive`',
  };
}

function checkVenv(): Check {
  const py = venvPython();
  const ok = existsSync(py);
  return {
    name: 'folklore venv (optional)',
    ok,
    detail: ok ? py : `no venv at ${py} — sidecar disabled (core runs on Node alone)`,
    blocking: false,
    fix: 'only for the sidecar: `folklore doctor --fix` (or `scripts/bootstrap.sh`)',
  };
}

function checkGraphifyImport(): Check {
  const py = venvPython();
  if (!existsSync(py)) {
    return {
      name: 'graphify importable (optional)',
      ok: false,
      detail: 'skipped — venv missing (sidecar disabled; core runs on Node alone)',
      blocking: false,
      fix: 'only for the sidecar: `folklore doctor --fix`',
    };
  }
  const r = spawnSync(
    py,
    ['-c', 'import graphify, graphify.validate; print(",".join(sorted(graphify.validate.OPTIONAL_NODE_FIELDS)))'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    return {
      name: 'graphify importable (optional)',
      ok: false,
      detail: (r.stderr || 'import failed').trim().split('\n').slice(-1)[0],
      blocking: false,
      fix: 'only for the sidecar: `folklore doctor --fix` to reinstall graphify into the venv',
    };
  }
  const got = (r.stdout || '').trim();
  return {
    name: 'graphify importable (optional)',
    ok: true,
    detail: `OPTIONAL_NODE_FIELDS = ${got}`,
    blocking: false,
  };
}

function checkSchemaPatch(importCheck: Check): Check {
  if (!importCheck.ok) {
    return {
      name: 'folklore schema patch (optional)',
      ok: false,
      detail: 'skipped — graphify not importable (sidecar disabled)',
      blocking: false,
    };
  }
  const expected = EXPECTED_OPTIONAL_NODE_FIELDS.join(',');
  const got = importCheck.detail.replace('OPTIONAL_NODE_FIELDS = ', '');
  return {
    name: 'folklore schema patch (optional)',
    ok: got === expected,
    detail: got === expected ? 'room/wing/source_uri/fetched_at/embedding_id' : `got ${got}, expected ${expected}`,
    blocking: false,
    fix: 'only for the sidecar: submodule on older commit — `git submodule update --init --remote`',
  };
}

/**
 * V5 schema readiness — Phase 24 (ROOMS-DEL-06).
 *
 * Samples up to 10 random nodes from graph.json. If ANY carries a legacy
 * `room` field the user is nudged to run `folklore migrate v5`. Also
 * flags residual rooms.json / shared-rooms.json artifacts from the V4 era.
 *
 * Non-blocking: the V5 runtime tolerates orphan fields, this is a hygiene
 * nag that persists until the user opts into the one-way migration.
 */
function checkV5SchemaReadiness(): Check {
  const home = process.env.FOLKLORE_HOME ?? join(homedir(), '.folklore');
  const graphPath = join(home, 'graph.json');
  const roomsJsonPath = join(home, 'rooms.json');
  const sharedRoomsJsonPath = join(home, 'shared-rooms.json');

  const artifacts: string[] = [];
  if (existsSync(roomsJsonPath)) artifacts.push('rooms.json');
  if (existsSync(sharedRoomsJsonPath)) artifacts.push('shared-rooms.json');

  if (!existsSync(graphPath)) {
    if (artifacts.length === 0) {
      return {
        name: 'V5 schema readiness',
        ok: true,
        detail: 'graph not yet populated — V5 ready',
        blocking: false,
      };
    }
    return {
      name: 'V5 schema readiness',
      ok: false,
      detail: `V4 artifacts present: ${artifacts.join(', ')}`,
      blocking: false,
      fix: 'run `folklore migrate v5` to remove them',
    };
  }

  let v4HitCount = 0;
  let sampleSize: number;
  try {
    const parsed = JSON.parse(readFileSync(graphPath, 'utf8')) as { nodes?: unknown[] };
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    const sampleN = Math.min(10, nodes.length);
    sampleSize = sampleN;
    const seen = new Set<number>();
    while (seen.size < sampleN) seen.add(Math.floor(Math.random() * nodes.length));
    for (const idx of seen) {
      const n = nodes[idx] as { room?: unknown };
      if (n && typeof n.room === 'string' && n.room.length > 0) v4HitCount += 1;
    }
  } catch (e) {
    return {
      name: 'V5 schema readiness',
      ok: false,
      detail: `could not parse graph.json: ${(e as Error).message}`,
      blocking: false,
    };
  }

  if (v4HitCount > 0) {
    const artifactDetail = artifacts.length > 0 ? ` + ${artifacts.join(', ')}` : '';
    return {
      name: 'V5 schema readiness',
      ok: false,
      detail: `V4 data detected: ${v4HitCount}/${sampleSize} sampled nodes still have a 'room' field${artifactDetail}`,
      blocking: false,
      fix: 'run `folklore migrate v5` to upgrade',
    };
  }

  if (artifacts.length > 0) {
    return {
      name: 'V5 schema readiness',
      ok: false,
      detail: `V4 artifacts present: ${artifacts.join(', ')}`,
      blocking: false,
      fix: 'run `folklore migrate v5` to remove them',
    };
  }

  return {
    name: 'V5 schema readiness',
    ok: true,
    detail: `${sampleSize}/${sampleSize} sampled nodes V5-clean`,
    blocking: false,
  };
}

/**
 * Hook engine resolvable — the silent-failure the dev critique flagged
 * (commit 1f53b25): all four .claude hooks called `folklore` on PATH, which
 * isn't there, so every prefetch/deny/auto-save silently no-op'd and nobody
 * noticed. This mirrors the hooks' resolver (FOLKLORE_BIN → repo dist → PATH)
 * and reports LOUDLY when none resolves.
 */
function checkHookEngine(): Check {
  const envBin = process.env.FOLKLORE_BIN;
  const envOk = Boolean(envBin && existsSync(envBin));
  const distCli = join(repoRoot(), 'dist', 'cli', 'index.js');
  const distOk = existsSync(distCli);
  const onPath = spawnSync('command', ['-v', 'folklore'], { encoding: 'utf8', shell: true });
  const pathOk = onPath.status === 0 && (onPath.stdout || '').trim().length > 0;
  const ok = envOk || distOk || pathOk;
  const how = envOk ? 'FOLKLORE_BIN' : distOk ? 'repo dist/cli/index.js' : pathOk ? 'folklore on PATH' : 'none';
  return {
    name: 'hook engine resolvable',
    ok,
    detail: ok
      ? `resolves via ${how}`
      : 'NO engine — FOLKLORE_BIN unset, dist/ not built, folklore not on PATH; hooks will silently no-op',
    blocking: false,
    fix: 'run `npm run build`, add folklore to PATH, or set FOLKLORE_BIN',
  };
}

/**
 * Graph↔vector store drift — the two stores are written by separate paths
 * with no cross-store transaction (dev critique). Surfaces the orphan rate
 * (vec_meta rows whose node_id no longer resolves in graph.json) by reusing
 * the tested `prune-vectors --dry-run`. Orphans depress retrieval; left
 * unchecked they look identical to a healthy store.
 */
function checkStoreDrift(): Check {
  const home = folkloreHome();
  const vectors = join(home, 'vectors.db');
  const graph = join(home, 'graph.json');
  if (!existsSync(vectors) || !existsSync(graph)) {
    return { name: 'graph↔vector drift', ok: true, detail: 'no store yet — nothing to reconcile', blocking: false };
  }
  const cli = join(repoRoot(), 'dist', 'cli', 'index.js');
  if (!existsSync(cli)) {
    return { name: 'graph↔vector drift', ok: false, detail: 'skipped — dist not built', blocking: false, fix: 'run `npm run build`' };
  }
  const r = spawnSync('node', [cli, 'prune-vectors', '--dry-run', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, FOLKLORE_HOME: home },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { name: 'graph↔vector drift', ok: false, detail: 'could not probe vectors.db', blocking: false };
  }
  try {
    // prune-vectors --json pretty-prints the whole object to stdout (node
    // warnings go to stderr), so parse the entire stdout, not the last line.
    const d = JSON.parse((r.stdout || '').trim()) as {
      scanned: number;
      orphans: number;
      resolved: number;
    };
    const rate = d.scanned ? (d.resolved / d.scanned) * 100 : 100;
    const ok = d.orphans === 0;
    return {
      name: 'graph↔vector drift',
      ok,
      detail: ok
        ? `${d.scanned} vectors, 100% resolve in graph`
        : `${d.orphans}/${d.scanned} orphaned vectors (${rate.toFixed(1)}% resolve)`,
      blocking: false,
      fix: 'run `folklore prune-vectors` to drop orphaned vectors',
    };
  } catch {
    return { name: 'graph↔vector drift', ok: false, detail: 'could not parse prune-vectors output', blocking: false };
  }
}

/**
 * MCP server registered — the twin of checkHookEngine. `folklore claude
 * install` wires a `mcp__folklore__*` PreToolUse matcher into settings.json,
 * but the tools only EXIST if the folklore MCP server is also registered
 * where the harness reads it (project .mcp.json or ~/.claude.json). If it
 * isn't, the matcher fires in the void: hooks look wired, the graph is
 * unreachable, and nothing complains. Report LOUDLY when unregistered.
 */
function checkMcpRegistered(): Check {
  const hasFolklore = (raw: string): boolean => {
    try {
      const j = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      return Boolean(j.mcpServers && 'folklore' in j.mcpServers);
    } catch {
      return false;
    }
  };

  const projectMcp = join(process.cwd(), '.mcp.json');
  const projectOk = existsSync(projectMcp) && hasFolklore(readFileSync(projectMcp, 'utf8'));

  // ~/.claude.json holds both a root mcpServers and per-project blocks.
  let userOk = false;
  const userCfg = join(homedir(), '.claude.json');
  if (!projectOk && existsSync(userCfg)) {
    try {
      const j = JSON.parse(readFileSync(userCfg, 'utf8')) as {
        mcpServers?: Record<string, unknown>;
        projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
      };
      const inRoot = Boolean(j.mcpServers && 'folklore' in j.mcpServers);
      const inProj = Boolean(
        j.projects &&
          Object.values(j.projects).some((p) => p?.mcpServers && 'folklore' in p.mcpServers),
      );
      userOk = inRoot || inProj;
    } catch {
      userOk = false;
    }
  }

  const ok = projectOk || userOk;
  const where = projectOk ? '.mcp.json' : userOk ? '~/.claude.json' : 'none';
  return {
    name: 'MCP server registered',
    ok,
    detail: ok
      ? `folklore server present in ${where}`
      : 'folklore NOT registered — the mcp__folklore__* hook matches a tool nothing provides; graph unreachable from Claude Code',
    blocking: false,
    fix: 'run `folklore claude install`, or `claude mcp add folklore -- folklore mcp start`',
  };
}

function render(c: Check): string {
  // Non-blocking failures render [WARN] (not [skip]) — a dead memory layer
  // must not look like a quiet healthy one (dev critique).
  const mark = c.ok ? '[ ok ]' : c.blocking ? '[FAIL]' : '[WARN]';
  const line = `${mark} ${c.name.padEnd(28)} ${c.detail}`;
  if (!c.ok && c.fix) return `${line}\n       fix: ${c.fix}`;
  return line;
}

function runFix(): number {
  const script = join(repoRoot(), 'scripts', 'bootstrap.sh');
  if (!existsSync(script)) {
    console.error(`doctor --fix: ${script} not found`);
    return 1;
  }
  console.log(`doctor --fix: running ${script}`);
  const r = spawnSync('bash', [script], { stdio: 'inherit' });
  return r.status ?? 1;
}

/**
 * Discovery reachability. Everything else can be green while the node is alone
 * on the network: a tracker URL pointing at a domain we don't own, or a KV
 * binding that was never wired, both fail silently inside the daemon's
 * best-effort announce loop. One HTTP round trip surfaces it.
 *
 * Non-blocking — a node with no tracker still works locally and over mDNS.
 */
async function checkTracker(): Promise<Check> {
  const name = 'peer discovery (tracker)';
  const cfgRes = await loadConfig(join(folkloreHome(), 'config.yaml'));
  if (cfgRes.isErr()) {
    return { name, ok: false, detail: 'config unreadable — cannot probe', blocking: false };
  }
  const { url, namespace } = cfgRes.value.peer.tracker;
  if (url.length === 0) {
    return { name, ok: true, detail: 'disabled (local/LAN only)', blocking: false };
  }

  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/tracker/peers?ns=${encodeURIComponent(namespace)}`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { peers?: unknown[]; error?: string };
    if (!res.ok || !Array.isArray(body.peers)) {
      return {
        name,
        ok: false,
        detail: `${url} → HTTP ${res.status}${body.error ? ` (${body.error})` : ''}`,
        blocking: false,
        fix: 'tracker is not serving peers — check the TRACKER_KV binding and that peer.tracker.url points at the deployed site',
      };
    }
    return { name, ok: true, detail: `${url} reachable — ${body.peers.length} peer(s) announced`, blocking: false };
  } catch (e) {
    return {
      name,
      ok: false,
      detail: `${url} unreachable (${(e as Error).message})`,
      blocking: false,
      fix: 'check connectivity, or set peer.tracker.url: "" to run local-only',
    };
  }
}

export async function doctor(args: string[]): Promise<number> {
  if (args.includes('--fix')) {
    const code = runFix();
    if (code !== 0) return code;
    console.log('');
    console.log('rerunning checks...\n');
  }

  const hostPy = checkHostPython();
  const graphImport = checkGraphifyImport();

  const checks: Check[] = [
    checkNode(),
    hostPy,
    checkPluginManifest(),
    checkGraphifySubmodule(),
    checkVenv(),
    graphImport,
    checkSchemaPatch(graphImport),
    checkV5SchemaReadiness(),
    checkHookEngine(),
    checkMcpRegistered(),
    checkStoreDrift(),
    await checkTracker(),
  ];

  console.log('folklore doctor\n');
  for (const c of checks) console.log(render(c));
  console.log('');

  const blocking = checks.filter((c) => !c.ok && c.blocking);
  const warnings = checks.filter((c) => !c.ok && !c.blocking);
  if (blocking.length === 0) {
    if (warnings.length === 0) {
      console.log('all checks pass — runtime is healthy.');
      return 0;
    }
    console.log(`runtime OK, but ${warnings.length} warning(s) — see [WARN] above (memory layer may be degraded).`);
    return 0;
  }
  console.log(`${blocking.length} blocking issue(s)${warnings.length ? ` + ${warnings.length} warning(s)` : ''}.`);
  if (!args.includes('--fix')) {
    console.log("run 'folklore doctor --fix' to bootstrap the venv + graphify install.");
  }
  return 1;
}
