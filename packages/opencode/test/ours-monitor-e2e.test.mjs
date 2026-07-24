// REQUIRED — a REAL end-to-end proof, not a mock. Every other test in this package mocks
// Bun.spawn/client (ours-monitor.test.mjs) or only checks config-file shape
// (opencode-integration.test.mjs); only this test exercises the full real path end to end. It:
//   1. installs the REAL plugin files (ours-monitor.mjs + ours-monitor.impl.mjs) the way
//      install.sh would, registered via the config `plugin` key (not createOpencode({plugins}))
//   2. boots a REAL opencode server (@opencode-ai/sdk's createOpencode) against an ISOLATED
//      throwaway ours-mcp daemon (its own OURS_STATE_DIR/OURS_PORT — never the host's real
//      fleet daemon) with two real, disposable identities
//   3. drives a REAL model turn that calls ours_monitor_start for real
//   4. sends a REAL message from a second identity via a raw MCP stdio client
//   5. asserts the plugin's own log shows TICK + INJECTED (not just "no crash") AND that the
//      agent produced a real autonomous reply — the actual wake, not a proxy for it
//
// Skips gracefully (t.skip) if: the ours-mcp binary is unavailable, no model auth is
// configured on this host (~/.local/share/opencode/auth.json), or opencode-ai/@opencode-ai/sdk
// fail to install (no network). Must still run locally where both are available — this is the
// end-to-end gate for the monitor, not an optional nice-to-have.
//
// Safety: every throwaway directory here comes from mktemp, bound to its own dedicated
// variable — NEVER reused as HOME and then rm -rf'd. Nothing here ever touches the real
// ~/.ours daemon, ~/.config/opencode, or ~/.local/share/opencode/opencode.db.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const REAL_AUTH_PATH = join(homedir(), '.local', 'share', 'opencode', 'auth.json');

let SETUP_DIR = null;
let createOpencode = null;
let OURS_MCP_AVAILABLE = false;
let SKIP_REASON = null;

before(() => {
  if (!existsSync(REAL_AUTH_PATH)) {
    SKIP_REASON = `no opencode model auth configured on this host (${REAL_AUTH_PATH} missing) — e2e-tier, skipping`;
    return;
  }
  try {
    execFileSync('ours-mcp', ['--version'], { stdio: 'pipe' });
    OURS_MCP_AVAILABLE = true;
  } catch (err) {
    SKIP_REASON = `ours-mcp binary unavailable (${err.message}) — e2e-tier, skipping`;
    return;
  }
  SETUP_DIR = mkdtempSync(join(tmpdir(), 'opencode-e2e-setup-'));
  try {
    execFileSync('npm', ['install', 'opencode-ai@latest', '@opencode-ai/sdk@latest', '--no-save', '--no-audit', '--no-fund'], {
      cwd: SETUP_DIR,
      stdio: 'pipe',
      timeout: 180_000,
    });
    const binCandidate = join(SETUP_DIR, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (!existsSync(binCandidate)) throw new Error('opencode-ai installed but binary not found at expected path');
    chmodSync(binCandidate, 0o755);
    // put the throwaway opencode-ai bin ahead of PATH so @opencode-ai/sdk's cross-spawn("opencode", ...)
    // resolves to THIS install, not any other opencode on the host's PATH.
    const shim = join(SETUP_DIR, 'path-shim');
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, 'opencode'), `#!/bin/sh\nexec "${binCandidate}" "$@"\n`);
    chmodSync(join(shim, 'opencode'), 0o755);
    process.env.PATH = `${shim}:${process.env.PATH}`;
  } catch (err) {
    SKIP_REASON = `opencode-ai/@opencode-ai/sdk unavailable (npm install failed: ${err.message}) — e2e-tier, skipping`;
    SETUP_DIR = null;
    return;
  }
});

after(() => {
  // Deliberately no rm -rf of SETUP_DIR or any per-test sandbox — every throwaway dir here
  // comes from mktemp; /tmp gets reaped by the host, and that's a much safer default than any
  // rm -rf near a variable that could ever resolve to something real.
});

// --- minimal MCP stdio client (JSON-RPC 2.0, newline-delimited, matching ours-mcp proxy's
// transport) — used ONLY to drive the "sender" side (create identities, send a message) from
// OUTSIDE the opencode session being tested, exactly like a peer agent would. ---
function mcpClient(env) {
  // ours-mcp proxy's "session-restore" self-recovers a prior identity binding keyed by the
  // ambient CLAUDE_CODE_SESSION_ID env var. Every proxy process this test spawns would otherwise
  // inherit the SAME session id from this shell, so the sender and receiver connections would
  // collide on one restore slot and clobber each other's binding. A fresh random id per
  // connection means each one is a "new session" with nothing to restore.
  const proc = spawn('ours-mcp', ['proxy'], {
    env: { ...process.env, ...env, CLAUDE_CODE_SESSION_ID: randomUUID() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = createInterface({ input: proc.stdout });
  const pending = new Map();
  let id = 0;
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  function request(method, params) {
    const myId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(myId); reject(new Error(`mcp request ${method} timed out`)); }, 20_000);
      pending.set(myId, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
  }
  async function callTool(name, args) {
    const res = await request('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`${name} failed: ${JSON.stringify(res.error)}`);
    return res.result;
  }
  async function init() {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ours-monitor-e2e-test', version: '0.0.1' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  function close() {
    proc.kill();
  }
  return { init, callTool, close };
}

async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test('REQUIRED (real-e2e) — arm the monitor in a real opencode, send a real message from a second identity, and observe a real autonomous reply', async (t) => {
  if (!OURS_MCP_AVAILABLE || SKIP_REASON) return t.skip(SKIP_REASON ?? 'prerequisites unavailable');

  const suffix = randomUUID().slice(0, 8);
  const senderIdentity = `e2e-sender-${suffix}`;
  const receiverIdentity = `e2e-receiver-${suffix}`;

  // Isolated throwaway daemon — NEVER the host's real ~/.ours fleet daemon.
  const daemonSandbox = mkdtempSync(join(tmpdir(), 'ours-e2e-daemon-'));
  const daemonStateDir = join(daemonSandbox, 'state');
  const daemonPort = String(31000 + Math.floor(Math.random() * 3000));
  const daemonEnv = { OURS_STATE_DIR: daemonStateDir, OURS_PORT: daemonPort };

  execFileSync('ours-mcp', ['start'], { env: { ...process.env, ...daemonEnv }, stdio: 'pipe', timeout: 20_000 });
  t.after(() => {
    try { execFileSync('ours-mcp', ['stop'], { env: { ...process.env, ...daemonEnv }, stdio: 'pipe', timeout: 20_000 }); } catch { /* best-effort */ }
  });

  // Receiver must exist BEFORE the sender is created/bound — the daemon's local contact-book
  // auto-discovery only picks up identities that already existed at that point, so creating the
  // sender first leaves it unable to resolve the receiver as a contact for send_message. This is
  // the same order test/ours-monitor-live-watch.test.mjs uses.
  const receiverSetup = mcpClient(daemonEnv);
  await receiverSetup.init();
  await receiverSetup.callTool('create_identity', { name: receiverIdentity });
  receiverSetup.close();

  const sender = mcpClient(daemonEnv);
  await sender.init();
  await sender.callTool('create_identity', { name: senderIdentity });
  t.after(() => sender.close());
  // Bind explicitly right before the send so this test never silently sends from the wrong
  // identity, regardless of whatever ours-mcp proxy's own session-restore does on connect.
  await sender.callTool('choose_identity', { name: senderIdentity });

  // --- isolated OpenCode home: real shipped plugin files, real config, real model auth ---
  const opencodeHome = mkdtempSync(join(tmpdir(), 'opencode-e2e-home-'));
  const configDir = join(opencodeHome, '.config', 'opencode');
  const pluginDestDir = join(configDir, 'plugin');
  mkdirSync(pluginDestDir, { recursive: true });
  mkdirSync(join(opencodeHome, '.local', 'share', 'opencode'), { recursive: true });
  cpSync(REAL_AUTH_PATH, join(opencodeHome, '.local', 'share', 'opencode', 'auth.json'));

  cpSync(join(PKG, 'plugin', 'ours-monitor.mjs'), join(pluginDestDir, 'ours-monitor.mjs'));
  cpSync(join(PKG, 'plugin', 'ours-monitor.impl.mjs'), join(pluginDestDir, 'ours-monitor.impl.mjs'));
  mkdirSync(join(configDir, 'node_modules'), { recursive: true });
  cpSync(join(PKG, '..', '..', 'node_modules', 'zod'), join(configDir, 'node_modules', 'zod'), { recursive: true });

  const pluginPath = join(pluginDestDir, 'ours-monitor.mjs');
  writeFileSync(
    join(configDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        mcp: { ours: { type: 'local', command: ['ours-mcp', 'proxy'], enabled: true } },
        plugin: [pluginPath],
      },
      null,
      2,
    ),
  );

  process.env.HOME = opencodeHome;
  process.env.OURS_STATE_DIR = daemonStateDir;
  process.env.OURS_PORT = daemonPort;

  const sdkPath = pathToFileURL(join(SETUP_DIR, 'node_modules', '@opencode-ai', 'sdk', 'dist', 'index.js')).href;
  if (!createOpencode) ({ createOpencode } = await import(sdkPath));

  const { client, server } = await createOpencode({ port: 0, timeout: 60_000 });
  t.after(() => server.close());

  const sessionResp = await client.session.create({ body: {} });
  const sessionID = sessionResp.data.id;

  const armRes = await client.session.promptAsync({
    path: { id: sessionID },
    query: { directory: opencodeHome },
    body: {
      parts: [
        {
          type: 'text',
          text:
            `Call choose_identity with name "${receiverIdentity}" (it already exists — do not create it). ` +
            `Then call ours_monitor_start with identity "${receiverIdentity}". Do exactly those two tool calls and nothing else — no explanation needed.`,
        },
      ],
    },
  });
  assert.equal(armRes.response.status, 204, 'arming prompt was accepted');

  const monitorLogPath = join(configDir, 'ours-monitor.log');
  const opencodeLogPath = join(opencodeHome, '.local', 'share', 'opencode', 'log', 'opencode.log');
  // The model turn's own failure is invisible to the client: promptAsync returns 204
  // ("accepted") regardless of whether the underlying provider call actually succeeds; a
  // provider-side error (e.g. billing/quota) only ever shows up in opencode's OWN log, never in
  // anything this test's client sees directly. Detect that specific case and skip with a clear,
  // honest message instead of a hard assertion failure — an outage-driven skip must never look
  // like a plugin regression to a future reader.
  const billingOrProviderError = () => {
    if (!existsSync(opencodeLogPath)) return null;
    const log = readFileSync(opencodeLogPath, 'utf8');
    const match = log.match(/error\.error="(AI_APICallError:[^"]*)"/);
    return match ? match[1] : null;
  };
  const armed = await waitFor(async () => {
    if (!existsSync(monitorLogPath)) return null;
    const text = readFileSync(monitorLogPath, 'utf8');
    return text.includes(`START`) && text.includes(receiverIdentity) ? text : null;
  }, { timeoutMs: 90_000, intervalMs: 5000 });
  if (!armed) {
    const providerError = billingOrProviderError();
    if (providerError) {
      return t.skip(
        `model provider unavailable (not a plugin regression): ${providerError} — see ` +
          'test/ours-monitor-live-watch.test.mjs for a billing-independent proof of the watch/wake mechanism.',
      );
    }
  }
  assert.ok(armed, `expected ours-monitor.log to show a START for ${receiverIdentity} within 90s (agent must actually call ours_monitor_start)`);

  // The underlying `ours-mcp watch <identity>` process (spawned inside ours_monitor_start, before
  // START is even logged) needs a brief moment after spawning to establish its subscription to
  // the daemon's notification stream. `armed` only proves the tool call returned, not that the
  // subscription underneath it is live yet. This settle delay is not masking the property under
  // test (real tick delivery once subscribed); it mirrors the natural gap a real caller would
  // have between arming and a message arriving.
  await new Promise((r) => setTimeout(r, 2000));

  // --- the real wake trigger: an ACTUAL message from a second identity, over the real daemon ---
  const pingText = `e2e ping ${suffix}`;
  const sendRes = await sender.callTool('send_message', { contact: receiverIdentity, text: pingText });
  assert.equal(sendRes.isError, false, `send_message should succeed: ${JSON.stringify(sendRes)}`);

  const wokeUp = await waitFor(() => {
    const text = readFileSync(monitorLogPath, 'utf8');
    const hasTick = /TICK .*identity=/.test(text);
    const hasInjected = /INJECTED .*identity=/.test(text);
    return hasTick && hasInjected ? text : null;
  }, { timeoutMs: 60_000 });
  if (!wokeUp) {
    const text = existsSync(monitorLogPath) ? readFileSync(monitorLogPath, 'utf8') : '';
    // TICK requires only the local watch loop (no model call) — if it's missing, this can't be
    // the billing outage. INJECTED requires promptAsync to resolve, which (like the arming
    // prompt) returns as soon as the turn is accepted, regardless of whether the underlying
    // provider call then fails — so a provider error here still shows TICK, just possibly not
    // a subsequent successful reply. Only treat this as a skip-worthy outage if a provider error
    // is present AND we at least got as far as TICK (i.e. the plugin mechanism itself worked).
    const hasTick = /TICK .*identity=/.test(text);
    const providerError = billingOrProviderError();
    if (hasTick && providerError) {
      return t.skip(
        `model provider unavailable (not a plugin regression): ${providerError} — TICK was observed (the watch/wake ` +
          'mechanism worked), only the model turn failed. See test/ours-monitor-live-watch.test.mjs for the billing-' +
          'independent proof of the wake mechanism itself.',
      );
    }
  }
  assert.ok(
    wokeUp,
    `expected ours-monitor.log to show BOTH a TICK and an INJECTED line within 60s of sending a real message — ` +
      `zero ticks would mean the watch process never delivered anything, or leaked. Log contents:\n${
        existsSync(monitorLogPath) ? readFileSync(monitorLogPath, 'utf8') : '(no log file)'
      }`,
  );

  // --- confirm the agent actually produced a real autonomous reply, not just an injected prompt ---
  const repliedWithEvidence = await waitFor(async () => {
    const msgs = await client.session.messages({ path: { id: sessionID } });
    const parts = (msgs.data ?? []).flatMap((m) => m.parts ?? []);
    const calledGetMessages = parts.some(
      (p) => p.type === 'tool' && typeof p.tool === 'string' && p.tool.includes('get_messages'),
    );
    return calledGetMessages ? msgs.data : null;
  }, { timeoutMs: 30_000 });
  assert.ok(
    repliedWithEvidence,
    'expected the autonomously-injected turn to actually call get_messages (real reactive behavior), not just log a TICK with no follow-through',
  );
});
