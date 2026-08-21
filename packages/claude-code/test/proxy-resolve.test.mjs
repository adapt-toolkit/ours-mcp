// proxy.mjs dependency resolution — regression for the npm-cache layout bug.
//
// The plugin's MCP server is `node ${CLAUDE_PLUGIN_ROOT}/bin/proxy.mjs`, which
// resolves @ours.network/mcp (the daemon) and spawns its `cli.js proxy`.
// Claude Code installs that dependency in one of two layouts depending on its
// version: inside the plugin's own per-version node_modules (reachable by Node's
// default walk-up), or in a SHARED `~/.claude/plugins/npm-cache/node_modules`
// tree that is a SIBLING of the plugin cache root — unreachable by a walk-up.
// The 0.17.2 plugin only handled the first, so on hosts with the shared layout
// require.resolve threw MODULE_NOT_FOUND and the MCP connection closed.
//
// Each case builds a throwaway plugin tree, copies the real proxy.mjs into it,
// runs it, and asserts whether the stub core CLI ran (proving resolution) — the
// stub exits 0 immediately so no daemon is started.
//
// Self-contained; no build step. Run with:
//   npm --workspace @ours.network/claude-code test
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓', msg);
  } else {
    fail++;
    console.log('  ✗ FAIL:', msg);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_PROXY = join(HERE, '..', 'bin', 'proxy.mjs');
const MARKER = 'CORE_CLI_RAN';

// Build a plugin cache tree under `root` and return the proxy.mjs path.
// `coreBaseRel` is the dir (relative to root) that should CONTAIN
// node_modules/@ours.network/mcp — or null to install no dependency.
function makeTree(root, coreBaseRel) {
  const pluginDir = join(root, 'plugins', 'cache', 'ours', 'ours', '0.17.2');
  mkdirSync(join(pluginDir, 'bin'), { recursive: true });
  const proxy = join(pluginDir, 'bin', 'proxy.mjs');
  copyFileSync(REAL_PROXY, proxy);
  if (coreBaseRel !== null) {
    const coreDir = join(root, coreBaseRel, 'node_modules', '@ours.network', 'mcp');
    mkdirSync(join(coreDir, 'dist'), { recursive: true });
    writeFileSync(join(coreDir, 'package.json'), '{"name":"@ours.network/mcp","version":"0.18.3"}');
    // Stub cli.js: prove it ran with the forwarded `proxy` arg, then exit.
    writeFileSync(
      join(coreDir, 'dist', 'cli.js'),
      `console.error("${MARKER} args=" + process.argv.slice(2).join(",")); process.exit(0);\n`,
    );
  }
  return proxy;
}

function runProxy(proxyPath, env = {}) {
  return spawnSync(process.execPath, [proxyPath], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const roots = [];
function freshRoot(prefix) {
  const r = mkdtempSync(join(tmpdir(), prefix));
  roots.push(r);
  return r;
}

console.log('proxy.mjs dependency resolution');

// Case A — shared sibling npm-cache (the reported broken layout).
{
  const root = freshRoot('a2a-proxy-shared-');
  // npm-cache sits at plugins/npm-cache, a SIBLING of plugins/cache.
  const proxy = makeTree(root, join('plugins', 'npm-cache'));
  const r = runProxy(proxy);
  assert(r.status === 0, 'shared npm-cache: proxy exits 0');
  assert(r.stderr.includes(MARKER), 'shared npm-cache: core cli resolved + launched');
  assert(r.stderr.includes('args=proxy'), 'shared npm-cache: launches the shared-daemon proxy');
}

// Case B — per-version node_modules (the healthy layout) still works.
{
  const root = freshRoot('a2a-proxy-perver-');
  const proxy = makeTree(root, join('plugins', 'cache', 'ours', 'ours', '0.17.2'));
  const r = runProxy(proxy);
  assert(r.status === 0 && r.stderr.includes(MARKER), 'per-version node_modules: core cli resolved + launched');
}

// Case C — CLAUDE_PLUGIN_DATA tree (documented persistent-deps pattern).
{
  const root = freshRoot('a2a-proxy-data-');
  const dataDir = join(root, 'plugindata');
  const proxy = makeTree(root, join('plugindata'));
  const r = runProxy(proxy, { CLAUDE_PLUGIN_DATA: dataDir });
  assert(r.status === 0 && r.stderr.includes(MARKER), 'CLAUDE_PLUGIN_DATA: core cli resolved + launched');
}

// Case D — dependency installed nowhere: clean error, exit 1, no marker.
{
  const root = freshRoot('a2a-proxy-missing-');
  const proxy = makeTree(root, null);
  const r = runProxy(proxy);
  assert(r.status === 1, 'missing dep: exits 1');
  assert(!r.stderr.includes(MARKER), 'missing dep: core cli never launched');
  assert(r.stderr.includes('cannot resolve @ours.network/mcp'), 'missing dep: actionable error message');
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
