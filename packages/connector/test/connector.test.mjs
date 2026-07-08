// Tests for the connector validation fixes (behavior changes on the vendored baseline):
//   1. config default success code is 200 (Hermes webhook adapter returns 200, not 202)
//   2. the reference gateway refuses to start on the default/placeholder HMAC secret
//   3. the reference gateway serves and acks 200 with a real secret + valid signature
//   4. the observe->poke watcher sends a Hermes-matchable event (X-GitHub-Event header
//      AND an event_type body field), correctly HMAC-SHA256 signed.
//
// Only the external ours daemon (ours-mcp) is faked; the code under test — the
// watcher's HTTP contract and the gateway's auth — runs for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(HERE);
const WATCH = join(PKG, 'connector-watch.sh');
const CONFIG = join(PKG, 'connector.config.sh');
const HANDLER = join(PKG, 'connector-reference-handler.mjs');
const DEFAULT_SECRET = 'CHANGE_ME_local_webhook_hmac';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A one-shot recording HTTP server: answers GET readiness probes, records the
// first POST (headers + body) and replies with `okCode`.
function recordingServer(okCode = 200) {
  let resolveFirst;
  const firstPost = new Promise((r) => (resolveFirst = r));
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(200).end('ready'); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(okCode).end();
      resolveFirst({ method: req.method, url: req.url, headers: req.headers, body });
    });
  });
  return new Promise((r) => server.listen(0, () => r({ server, port: server.address().port, firstPost })));
}

test('config: default success code is 200', () => {
  const out = execFileSync('bash', ['-c', `unset CONNECTOR_WEBHOOK_OK_CODE; . '${CONFIG}'; printf '%s' "$CONNECTOR_WEBHOOK_OK_CODE"`], { encoding: 'utf8' });
  assert.equal(out, '200');
});

test('gateway: refuses to start on the default HMAC secret', async () => {
  const proc = spawn('node', [HANDLER], {
    env: { ...process.env, CONNECTOR_HMAC_SECRET: DEFAULT_SECRET, CONNECTOR_IDENTITIES: 'TestId', CONNECTOR_WEBHOOK_URL: 'http://localhost:0/webhooks/ours-wake' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  proc.stderr.on('data', (d) => (err += d));
  proc.stdout.on('data', (d) => (err += d));
  const code = await new Promise((r) => {
    proc.on('exit', r);
    setTimeout(() => { proc.kill('SIGKILL'); r('timeout'); }, 4000);
  });
  assert.notEqual(code, 0, 'handler must exit non-zero on the default secret');
  assert.notEqual(code, 'timeout', 'handler must not keep running on the default secret');
  assert.match(err, /secret/i);
});

test('gateway: serves and acks 200 with a real secret + valid signature', async () => {
  const port = 18700 + Math.floor(process.pid % 1000);
  const url = `http://localhost:${port}/webhooks/ours-wake`;
  const secret = 'real-test-secret-xyz';
  const proc = spawn('node', [HANDLER], {
    env: { ...process.env, CONNECTOR_HMAC_SECRET: secret, CONNECTOR_IDENTITIES: 'TestId', CONNECTOR_WEBHOOK_URL: url, CONNECTOR_CLI: '/bin/true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // wait for listen
    for (let i = 0; i < 40; i++) {
      try { await fetch(`http://localhost:${port}/health`); break; } catch { await sleep(50); }
    }
    const body = JSON.stringify({ event_type: 'ours_wake', event: 'ours_wake', identity: 'TestId' });
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
    assert.equal(res.status, 200, 'valid signed wake must ack 200 (default OK code)');

    const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' }, body });
    assert.equal(bad.status, 401, 'bad signature must be 401');
  } finally {
    proc.kill('SIGKILL');
  }
});

test('watcher: pokes with X-GitHub-Event + event_type, HMAC-signed', async () => {
  const { server, port, firstPost } = await recordingServer(200);
  const tmp = mkdtempSync(join(tmpdir(), 'conn-test-'));
  // fake ours-mcp: `watch <id>` blocks briefly then exits; anything else is a no-op.
  const fakeCli = join(tmp, 'ours-mcp');
  writeFileSync(fakeCli, '#!/bin/bash\nif [ "$1" = "watch" ]; then sleep 3; fi\nexit 0\n');
  chmodSync(fakeCli, 0o755);
  const secret = 'watcher-test-secret';
  const proc = spawn('bash', [WATCH], {
    env: {
      ...process.env,
      CONNECTOR_CLI: fakeCli,
      CONNECTOR_IDENTITIES: 'TestId',
      CONNECTOR_HMAC_SECRET: secret,
      CONNECTOR_EVENT: 'ours_wake',
      CONNECTOR_WEBHOOK_URL: `http://localhost:${port}/webhooks/ours-wake`,
      CONNECTOR_POKE_BACKOFF: '0',
      CONNECTOR_WEBHOOK_OK_CODE: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const req = await Promise.race([firstPost, sleep(8000).then(() => null)]);
    assert.ok(req, 'watcher should POST a poke to the gateway');
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/webhooks/ours-wake');
    // Hermes matches the route event via X-GitHub-Event header or an event_type field.
    assert.equal(req.headers['x-github-event'], 'ours_wake', 'must send X-GitHub-Event header');
    const parsed = JSON.parse(req.body);
    assert.equal(parsed.event_type, 'ours_wake', 'body must carry event_type (Hermes field)');
    assert.equal(parsed.identity, 'TestId', 'body must carry the identity for routing');
    // Signature must verify over the exact body sent.
    const want = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    assert.equal(req.headers['x-hub-signature-256'], want, 'HMAC-SHA256 over the exact body');
  } finally {
    proc.kill('SIGKILL');
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
