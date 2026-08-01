// OpenClaw harness target — the MCP registration path.
//
// Regression context: the first cut of this target hand-wrote an `mcp` block
// into ~/.openclaw/openclaw.json the way every other harness is handled. That
// config is schema-validated and rejects the WHOLE file on an unrecognised
// root key, so on a build predating MCP support the write didn't degrade — it
// stopped the gateway from starting. These tests pin the two properties that
// prevent a repeat: capability is probed from the command list (not an exit
// code, which lies), and the openclaw target never touches the config file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openclawSupportsMcp } from '../src/cli/commands/harness.js';

// Verbatim shape of `openclaw --help` on a build WITHOUT mcp (2026.2.22-2).
const HELP_WITHOUT_MCP = `
Commands:
  agents *             Manage isolated agents (workspaces, auth, routing)
  memory *             Search and reindex memory files
  models *             Discover, scan, and configure models
  plugins *            Manage OpenClaw plugins and extensions
`;

const HELP_WITH_MCP = `
Commands:
  memory *             Search and reindex memory files
  mcp *                Manage MCP servers
  models *             Discover, scan, and configure models
`;

test('openclawSupportsMcp reads the command list, not an exit code', () => {
  assert.equal(openclawSupportsMcp(HELP_WITH_MCP), true);
  assert.equal(openclawSupportsMcp(HELP_WITHOUT_MCP), false);
  assert.equal(openclawSupportsMcp(''), false);
});

test('openclawSupportsMcp is not fooled by the word appearing elsewhere', () => {
  // A description mentioning MCP, or a differently-named command, is not the
  // `mcp` command itself — matching those would resurrect the bricking bug.
  assert.equal(openclawSupportsMcp('  tools *   Manage MCP servers and tools\n'), false);
  assert.equal(openclawSupportsMcp('  mcp-legacy *  old shim\n'), false);
  assert.equal(openclawSupportsMcp('Run `openclaw mcp add <name>` to register.\n'), false);
});

test('the openclaw target is CLI-driven — writeFor must never touch its config file', async () => {
  // Guard the invariant structurally: the harness module must not contain a
  // JSON writer branch for the openclaw shape. If someone re-adds one, the
  // config-bricking failure mode comes back with it.
  const src = readFileSync(new URL('../src/cli/commands/harness.ts', import.meta.url), 'utf8');
  const writeForBody = src.slice(src.indexOf('const writeFor'), src.indexOf('// ─────────────── flag parsing'));
  assert.match(
    writeForBody,
    /if \(h\.shape === 'openclaw'\) \{\s*installOpenclaw\(cmd\);\s*return;/,
    'writeFor must delegate the openclaw shape to the CLI and return immediately',
  );
  // NB: `cfg.mcp` alone is opencode's own legitimate key. OpenClaw's shape is
  // the deeper `mcp.servers` nesting — that is what must never be hand-built.
  assert.doesNotMatch(
    writeForBody,
    /mcp\.servers|servers\s*=\s*\(mcp/,
    'writeFor must not build an OpenClaw mcp.servers block itself',
  );
});

test('an unparseable config is left untouched rather than rewritten', () => {
  // JSON5 configs (comments allowed) must abort that harness, not get
  // round-tripped into plain JSON with the comments stripped.
  const dir = mkdtempSync(join(tmpdir(), 'fk-harness-'));
  const path = join(dir, 'openclaw.json');
  const original = '{\n  // a comment OpenClaw permits\n  "gateway": {}\n}\n';
  writeFileSync(path, original);

  assert.throws(() => JSON.parse(readFileSync(path, 'utf8')));
  assert.equal(readFileSync(path, 'utf8'), original, 'file must be byte-identical');

  rmSync(dir, { recursive: true, force: true });
});
