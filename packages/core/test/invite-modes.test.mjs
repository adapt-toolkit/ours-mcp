// packages/core/test/invite-modes.test.mjs
// Typed invite kinds (core 0.13) through the MCP tool surface: default one_time,
// explicit one_time/public, invalid kind rejection, public+name refusal, and the
// list_invites / revoke_invite management pair. Minting and revocation are local
// to the inviter's packet, so this runs offline (invalid broker); cross-node
// redemption of each kind is covered by the upstream core suite and the
// remove-me mufl script.
import { connectConnector } from './fixtures/connector-client.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

async function connector(_url, token, pid) {
  // `_url` is ignored: the connector is spawned, not dialled, and takes its port
  // and state dir from the env. The token and pid still select the session.
  const c = await connectConnector({ port: PORT, stateDir: dir, leaseToken: token, clientPid: pid });
  return { client: c.client, call: c.call, close: c.close };
}
const text = (r) => (Array.isArray(r.content) ? r.content.map((c) => c.text || '').join(' ') : '');
const isErr = (r) => r.isError === true;

const dir = mkdtempSync(join(tmpdir(), 'a2a-invmode-'));
const PORT = await freePort();
const daemon = spawn('node', [CLI, 'serve'], { env: { ...process.env, OURS_TRANSPORT: 'http', OURS_PORT: String(PORT), OURS_STATE_DIR: dir, OURS_BROKER_URL: 'wss://invalid.local/none', OURS_API_VISIBILITY: 'open' }, stdio: 'ignore' });
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) break; } catch {} await sleep(250); }

  const A = await connector(`http://127.0.0.1:${PORT}/mcp`, 'tokA', process.pid);
  await A.call('create_identity', { name: 'Inviter', expose_local: false });

  // Omitted kind => documented one_time default.
  const def = await A.call('generate_invite', {});
  ok(!isErr(def) && /One-time invite created/.test(text(def)), 'omitted mode defaults to a one-time invite');
  ok(/invite_id [0-9A-F]+/i.test(text(def)), 'result surfaces the invite_id');

  // Explicit one_time, with an assigned name.
  const oneT = await A.call('generate_invite', { name: 'Bob', mode: 'one_time' });
  ok(!isErr(oneT) && /One-time invite for "Bob"/.test(text(oneT)), 'explicit one_time with assigned name');

  // Public: reusable, no assigned name allowed.
  const pub = await A.call('generate_invite', { mode: 'public' });
  ok(!isErr(pub) && /Reusable public invite created/.test(text(pub)), 'public invite minted');
  ok(/NOT survive a daemon restart/.test(text(pub)), 'public invite result states the restart limitation');
  const pubId = (text(pub).match(/invite_id ([0-9A-F]+)/i) || [])[1];
  ok(!!pubId, 'public invite_id extractable from the result');

  const pubNamed = await A.call('generate_invite', { name: 'Eve', mode: 'public' });
  ok(isErr(pubNamed) && /cannot pre-assign a contact name/.test(text(pubNamed)), 'public + name is refused');

  // Unknown kind: rejected by the closed schema (structured MCP error, no invite minted).
  let invalidRejected = false;
  try {
    const r = await A.call('generate_invite', { mode: 'future_mode' });
    invalidRejected = isErr(r);
  } catch { invalidRejected = true; }
  ok(invalidRejected, 'an unknown invite kind is rejected with a structured error');

  // list_invites shows all three outstanding invites with their kinds.
  const listed = text(await A.call('list_invites', {}));
  ok(/Outstanding invites \(3\)/.test(listed), 'list_invites shows the 3 outstanding invites');
  ok(/public/.test(listed) && /one_time/.test(listed), 'list_invites shows both kinds');
  ok(/assigned name "Bob"/.test(listed), 'list_invites shows the assigned name');

  // Revoke the public invite; idempotent on repeat.
  const rev = await A.call('revoke_invite', { invite_id: pubId });
  ok(!isErr(rev) && /\(public\) revoked/.test(text(rev)), 'revoke_invite closes the public invite');
  const rev2 = await A.call('revoke_invite', { invite_id: pubId });
  ok(!isErr(rev2) && /nothing to revoke/.test(text(rev2)), 'second revoke is an idempotent no-op');
  ok(/Outstanding invites \(2\)/.test(text(await A.call('list_invites', {}))), 'revoked invite left the list');

  await A.close();
} finally {
  daemon.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ninvite-modes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
