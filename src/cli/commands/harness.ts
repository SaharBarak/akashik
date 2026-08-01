/**
 * `folklore harness install` / `folklore harness list`
 *
 * Folklore's cross-harness story is the MCP server. The PreToolUse /
 * PostToolUse hooks are Claude-Code-specific, but every other coding
 * harness the site promises — Cursor, Cline, Windsurf, Zed, Gemini CLI,
 * opencode, Roo Code, Claude Desktop — speaks the Model Context Protocol.
 * Registering `folklore mcp start` as a local MCP server in each makes the
 * graph's search / ask / get_node tools available there too, regardless of
 * which LLM provider (Anthropic, OpenAI, Gemini, Llama, Mistral, DeepSeek,
 * Ollama, Grok, …) the harness happens to drive. The provider comes from
 * the harness; folklore is the retrieval layer underneath it.
 *
 * Three config shapes cover the field:
 *   - `mcpServers`     — Claude Desktop, Cursor, Windsurf, Gemini CLI,
 *                        Cline, Roo Code  ({command, args, env})
 *   - `context_servers`— Zed                ({command, args, env})
 *   - `mcp`            — opencode           ({type:'local', command:[…],
 *                                             enabled:true})
 *
 * We only touch a harness whose config directory already exists (so we
 * never litter configs for tools the user hasn't installed) unless
 * `--all` is passed. Every write is idempotent and merges into the user's
 * existing config — folklore's own server key is the only thing replaced.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The MCP server key written into each harness config.
const SERVER_NAME = 'folklore';

// The published npm package the npx fallback resolves — NOT the server key:
// `npx --yes folklore` would install an unrelated package of that name.
const PKG_NAME = '@usefolklore/folklore';

// ─────────────── server command resolution ───────────────

/**
 * How a harness should spawn the folklore MCP server. Prefer a durable
 * `folklore` binary already on PATH (the post-`npm i -g` happy path —
 * fastest, no per-call npx resolution); otherwise fall back to
 * `npx --yes <pkg>`.
 *
 * Two traps make the bare name `folklore` wrong to write into a config:
 * GUI-launched harnesses (Claude Desktop & co.) spawn servers with a
 * minimal PATH that misses npm-global / version-manager dirs, and a CLI
 * running under `npx` sees npx's ephemeral shim dir on its own PATH — a
 * path that no longer exists when the harness spawns the server later.
 * So resolve to an absolute path, and treat npx shims as not installed.
 */
interface ServerCmd {
  readonly command: string;
  readonly args: readonly string[];
}

const folkloreBinPath = (): string | null => {
  const probe = platform() === 'win32'
    ? spawnSync('where', ['folklore'], { encoding: 'utf8' })
    : spawnSync('command', ['-v', 'folklore'], { encoding: 'utf8', shell: true });
  if (probe.status !== 0) return null;
  const first = (probe.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!first) return null;
  // npx's shim dir (…/_npx/<hash>/node_modules/.bin) is ephemeral — a
  // config pointing into it breaks as soon as the npx cache rotates.
  if (/[\\/]_npx[\\/]/.test(first)) return null;
  return first;
};

const resolveServerCmd = (pkg: string): ServerCmd => {
  const bin = folkloreBinPath();
  return bin
    ? { command: bin, args: ['mcp', 'start'] }
    : { command: 'npx', args: ['--yes', pkg, 'mcp', 'start'] };
};

// ─────────────── harness registry ───────────────

type Shape = 'mcpServers' | 'context_servers' | 'opencode' | 'openclaw';

interface Harness {
  readonly id: string;
  readonly label: string;
  readonly shape: Shape;
  /** Absolute path to the harness's global config file. */
  readonly configPath: string;
}

const home = homedir();
const plat = platform();

/** Per-OS application-support root for Claude Desktop. */
const claudeDesktopConfig = (): string => {
  if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (plat === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
};

/** VS Code global storage root (Cline / Roo Code live here). */
const vscodeGlobalStorage = (): string => {
  if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
  if (plat === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage');
  return join(home, '.config', 'Code', 'User', 'globalStorage');
};

/**
 * OpenClaw's gateway config. Unlike the coding harnesses this is a
 * long-running personal-agent process, and its config honours env
 * overrides for multi-instance setups (`--dev` → `~/.openclaw-dev`,
 * `--profile x` → `~/.openclaw-x`); we target the default instance and
 * let OPENCLAW_CONFIG_PATH / OPENCLAW_HOME redirect us when set.
 */
const openclawConfig = (): string => {
  const explicit = process.env.OPENCLAW_CONFIG_PATH;
  if (explicit && explicit.length > 0) return explicit;
  const base = process.env.OPENCLAW_HOME;
  return join(base && base.length > 0 ? base : join(home, '.openclaw'), 'openclaw.json');
};

const HARNESSES: readonly Harness[] = [
  { id: 'claude-desktop', label: 'Claude Desktop', shape: 'mcpServers', configPath: claudeDesktopConfig() },
  { id: 'cursor', label: 'Cursor', shape: 'mcpServers', configPath: join(home, '.cursor', 'mcp.json') },
  { id: 'windsurf', label: 'Windsurf', shape: 'mcpServers', configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json') },
  { id: 'gemini-cli', label: 'Gemini CLI', shape: 'mcpServers', configPath: join(home, '.gemini', 'settings.json') },
  { id: 'cline', label: 'Cline', shape: 'mcpServers', configPath: join(vscodeGlobalStorage(), 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json') },
  { id: 'roo', label: 'Roo Code', shape: 'mcpServers', configPath: join(vscodeGlobalStorage(), 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json') },
  { id: 'zed', label: 'Zed', shape: 'context_servers', configPath: join(home, '.config', 'zed', 'settings.json') },
  { id: 'opencode', label: 'opencode', shape: 'opencode', configPath: join(home, '.config', 'opencode', 'opencode.json') },
  { id: 'openclaw', label: 'OpenClaw', shape: 'openclaw', configPath: openclawConfig() },
];

/**
 * A harness is "detected" when its config dir already exists. For the
 * VS Code extensions (Cline/Roo) we walk up to the extension's settings
 * dir; for the rest, the immediate parent dir of the config file.
 */
const isDetected = (h: Harness): boolean => existsSync(dirname(h.configPath));

// ─────────────── config writers (one per shape) ───────────────

const parseJson = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  try {
    // Tolerate trailing whitespace / BOM; opencode permits .jsonc but the
    // default file is plain JSON. A comment-bearing file throws → we abort
    // that single harness rather than corrupt it.
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  } catch {
    throw new Error('existing config is not plain JSON (possibly JSONC with comments) — left untouched');
  }
};

/**
 * OpenClaw is the one target we do NOT hand-write, because its config is
 * schema-validated and rejects the whole file on an unrecognised root key:
 * writing an `mcp` block into a build that predates MCP support doesn't
 * degrade, it stops the gateway from starting. The `mcp` block landed well
 * after the first public builds, so "is it supported here?" is a real
 * question rather than a formality.
 *
 * So we drive OpenClaw's own CLI, which writes whatever shape its version
 * expects, and probe for the subcommand rather than parsing a version string
 * (a capability check can't drift; a version comparison can).
 */
/**
 * Does this OpenClaw build have the `mcp` subcommand?
 *
 * `openclaw mcp --help` exits 0 even when `mcp` doesn't exist — it falls back
 * to printing the root banner — so the exit code proves nothing. The command
 * list in the root help is the honest signal. Exported for tests.
 */
export const openclawSupportsMcp = (rootHelpStdout: string): boolean =>
  // `\b` would also match `mcp-legacy`; the command name must END here.
  /^\s{2}mcp(?:\s|$)/m.test(rootHelpStdout);

const installOpenclaw = (cmd: ServerCmd): void => {
  const probe = plat === 'win32'
    ? spawnSync('where', ['openclaw'], { encoding: 'utf8' })
    : spawnSync('command', ['-v', 'openclaw'], { encoding: 'utf8', shell: true });
  if (probe.status !== 0) {
    throw new Error('openclaw CLI not on PATH — install OpenClaw, then re-run');
  }
  const bin = (probe.stdout ?? '').split(/\r?\n/)[0]?.trim();
  if (!bin) throw new Error('openclaw CLI not resolvable on PATH');

  const rootHelp = spawnSync(bin, ['--help'], { encoding: 'utf8' });
  if (!openclawSupportsMcp(rootHelp.stdout ?? '')) {
    const ver = (spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout ?? '').trim();
    throw new Error(
      `this OpenClaw build${ver ? ` (${ver})` : ''} has no MCP support — run \`openclaw update\` first`,
    );
  }

  const args = ['mcp', 'add', SERVER_NAME, '--command', cmd.command];
  for (const a of cmd.args) args.push('--arg', a);
  const add = spawnSync(bin, args, { encoding: 'utf8' });
  if (add.status === 0) return;

  // Re-running the installer must be a no-op, not a failure.
  const err = `${add.stderr ?? ''}${add.stdout ?? ''}`;
  if (/already exists|duplicate/i.test(err)) return;
  throw new Error(err.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? 'openclaw mcp add failed');
};

const writeFor = (h: Harness, cmd: ServerCmd): void => {
  if (h.shape === 'openclaw') {
    installOpenclaw(cmd);
    return;
  }
  const cfg = parseJson(h.configPath);

  if (h.shape === 'opencode') {
    const mcp = (cfg.mcp ?? {}) as Record<string, unknown>;
    mcp[SERVER_NAME] = {
      type: 'local',
      command: [cmd.command, ...cmd.args],
      enabled: true,
    };
    cfg.mcp = mcp;
    if (!cfg.$schema) cfg.$schema = 'https://opencode.ai/config.json';
  } else {
    const key = h.shape; // 'mcpServers' | 'context_servers'
    const servers = (cfg[key] ?? {}) as Record<string, unknown>;
    servers[SERVER_NAME] = { command: cmd.command, args: [...cmd.args], env: {} };
    cfg[key] = servers;
  }

  mkdirSync(dirname(h.configPath), { recursive: true });
  writeFileSync(h.configPath, JSON.stringify(cfg, null, 2) + '\n');
};

// ─────────────── flag parsing ───────────────

interface Flags {
  readonly all: boolean;
  readonly dryRun: boolean;
  readonly only?: ReadonlySet<string>;
  readonly pkg: string;
}

const parseFlags = (args: readonly string[]): Flags => {
  let all = false;
  let dryRun = false;
  let only: Set<string> | undefined;
  let pkg = PKG_NAME;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string => args[++i] ?? '';
    if (a === '--all') all = true;
    else if (a === '--dry-run' || a === '-n') dryRun = true;
    else if (a === '--only') only = new Set(next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a.startsWith('--only=')) only = new Set(a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--package') pkg = next();
    else if (a.startsWith('--package=')) pkg = a.slice('--package='.length);
  }
  return { all, dryRun, only, pkg };
};

// ─────────────── subcommands ───────────────

const list = (): number => {
  console.log('folklore harness — MCP targets\n');
  for (const h of HARNESSES) {
    const mark = isDetected(h) ? '✓ detected' : '· not found';
    console.log(`  ${mark}  ${h.label.padEnd(16)} ${h.configPath}`);
  }
  console.log('\n  run `folklore harness install` to register the folklore MCP server in every detected harness');
  console.log('  (use --all to write to all of them even if not yet detected, --only <id,..> to pick)');
  return 0;
};

const install = (flags: Flags): number => {
  const cmd = resolveServerCmd(flags.pkg);
  console.log('folklore harness install\n');
  console.log(`  server command: ${cmd.command} ${cmd.args.join(' ')}\n`);

  let wrote = 0;
  let skipped = 0;
  let failed = 0;
  for (const h of HARNESSES) {
    if (flags.only && !flags.only.has(h.id)) continue;
    const detected = isDetected(h);
    if (!detected && !flags.all) {
      console.log(`  · skip   ${h.label.padEnd(16)} (not detected — use --all to force)`);
      skipped++;
      continue;
    }
    if (flags.dryRun) {
      console.log(`  → would write ${h.label.padEnd(16)} ${h.configPath}`);
      wrote++;
      continue;
    }
    try {
      writeFor(h, cmd);
      console.log(`  ✓ wrote  ${h.label.padEnd(16)} ${h.configPath}`);
      wrote++;
    } catch (e) {
      console.error(`  ✗ skip   ${h.label.padEnd(16)} ${(e as Error).message}`);
      failed++;
    }
  }

  console.log(`\n  ${flags.dryRun ? 'would register' : 'registered'} in ${wrote} harness(es)` +
    `${skipped ? `, ${skipped} not detected` : ''}${failed ? `, ${failed} failed` : ''}.`);
  console.log('  Restart the harness to pick up the folklore MCP server.');
  return failed > 0 ? 1 : 0;
};

const USAGE = `usage: folklore harness <list|install> [flags]

  list                 show every MCP harness target and whether it's detected
  install              register the folklore MCP server in each detected harness

  --all                write even to harnesses whose config dir doesn't exist yet
  --only <id,..>       restrict to specific harness ids (cursor,zed,opencode,…)
  --package <name>     npx package name to launch (default: ${SERVER_NAME})
  --dry-run, -n        print what would change without writing

  Targets: ${HARNESSES.map((h) => h.id).join(', ')}.
  The folklore MCP server exposes search / ask / get_node / get_neighbors to
  any MCP-capable harness, independent of the LLM provider it drives.`;

export const harness = async (args: readonly string[]): Promise<number> => {
  const [sub, ...rest] = args;
  if (sub === '--help' || sub === '-h' || sub === 'help' || sub === undefined) {
    console.log(USAGE);
    return sub === undefined ? 1 : 0;
  }
  const flags = parseFlags(rest);
  switch (sub) {
    case 'list':
      return list();
    case 'install':
      return install(flags);
    default:
      console.error(`harness: unknown subcommand '${sub}'. try: list | install`);
      return 1;
  }
};
