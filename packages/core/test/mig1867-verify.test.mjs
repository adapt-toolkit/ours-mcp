// #1867 readout — parses the FROZEN §4 e2e-migration log contract (DAEMON-INTEGRATION.md §4, as
// frozen by MigrationImpl3) and asserts the double-ratchet property: app data rides the MIGRATED
// (rotated) session on both peers. The daemon formats these lines from core's notifies; this module
// is the verifier the #1867 N-node co-verify run uses. Built + tested against the frozen format NOW,
// ahead of core's app-e2e notify build. Pure functions (no daemon) → fast, hermetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Frozen §4 line formats:
//   [e2e-app] send cid=<cid> session_id=<hex> olm_type=<int> wire_id=<id>
//   [e2e-app] recv cid=<cid> session_id=<hex> ok=<bool> wire_id=<id>
//   [migration] active cid=<cid> role=<initiator|responder> epoch=<hex> session_id=<hex>
export function parseE2eLogs(text) {
  const sends = [], recvs = [], actives = [];
  for (const line of String(text).split('\n')) {
    let m;
    if ((m = line.match(/\[e2e-app\] send cid=(\S+) session_id=(\S+) olm_type=(\S+) wire_id=(\S+)/)))
      sends.push({ cid: m[1], session_id: m[2], olm_type: m[3], wire_id: m[4] });
    else if ((m = line.match(/\[e2e-app\] recv cid=(\S+) session_id=(\S+) ok=(\S+) wire_id=(\S+)/)))
      recvs.push({ cid: m[1], session_id: m[2], ok: m[3] === 'true', wire_id: m[4] });
    else if ((m = line.match(/\[migration\] active cid=(\S+) role=(\S+) epoch=(\S+) session_id=(\S+)/)))
      actives.push({ cid: m[1], role: m[2], epoch: m[3], session_id: m[4] });
  }
  return { sends, recvs, actives };
}

// #1867 assertion for ONE migrated contact on ONE node's logs. The session_id in every [e2e-app]
// send/recv MUST equal the [migration] active pin, the pin MUST differ from the pre-migration session
// id (it rotated), and there MUST be at least one app send/recv over the migrated session (proof that
// app data actually traversed it).
//
// `snap.pre` / `snap.post` are AUTHORITATIVE active_session_id(cid) snapshots taken by the harness via
// the readonly trn — pre-migration and post-active. Passing `snap.post` breaks the circularity
// MigrationReview flagged: if the app-send session_id in the log ONLY matched the pin because both were
// re-reads of active_session_id, they could agree while masking a send-on-a-stale-session bug. Anchoring
// on the independent authoritative snapshot (`session_id == snap.post ∧ snap.post != snap.pre`) makes
// the proof non-circular from the readout side, regardless of how core sources the notify session_id.
export function verify1867ForCid(logs, cid, snap = {}) {
  const pre = typeof snap === 'string' ? snap : snap.pre;  // back-compat: a bare string == pre snapshot
  const post = typeof snap === 'string' ? undefined : snap.post;
  const { sends, recvs, actives } = parseE2eLogs(logs);
  const active = actives.find((a) => a.cid === cid);
  const problems = [];
  if (!active) problems.push('no [migration] active line for cid');
  const pin = active?.session_id;
  if (active && pre && pin === pre) problems.push('active session_id did not rotate (== pre-migration)');
  // Anchor on the authoritative post-migration snapshot when available (non-circular proof).
  if (active && post) {
    if (pin !== post) problems.push(`active pin ${pin} != authoritative active_session_id ${post}`);
    if (pre && post === pre) problems.push('authoritative active_session_id did not rotate (post == pre)');
  }
  const truth = post || pin; // compare app lines against the authoritative value when we have it
  const mySends = sends.filter((s) => s.cid === cid);
  const myRecvs = recvs.filter((r) => r.cid === cid);
  for (const s of mySends) if (s.session_id !== truth) problems.push(`send wire_id=${s.wire_id} session_id ${s.session_id} != ${post ? 'authoritative' : 'active pin'} ${truth}`);
  for (const r of myRecvs) if (r.session_id !== truth) problems.push(`recv wire_id=${r.wire_id} session_id ${r.session_id} != ${post ? 'authoritative' : 'active pin'} ${truth}`);
  for (const r of myRecvs) if (!r.ok) problems.push(`recv wire_id=${r.wire_id} ok=false (decrypt failed)`);
  const appLines = mySends.length + myRecvs.length;
  if (active && appLines === 0) problems.push('no [e2e-app] send/recv for cid — no app data proven over the migrated session');
  return { ok: problems.length === 0, pin, appLines, sends: mySends.length, recvs: myRecvs.length, problems };
}

// --- tests against synthetic FROZEN-format lines ----------------------------------------------
const CID = 'CID123', PRE = 'aa'.repeat(16), POST = 'bb'.repeat(16);

test('parseE2eLogs: extracts send/recv/active from the frozen §4 format', () => {
  const logs = [
    `ours: [migration] active cid=${CID} role=initiator epoch=${'ee'.repeat(16)} session_id=${POST}`,
    `ours: [e2e-app] send cid=${CID} session_id=${POST} olm_type=1 wire_id=w1`,
    `ours: [e2e-app] recv cid=${CID} session_id=${POST} ok=true wire_id=w2`,
    'ours: [e2e-route] cid=CID123 wire_id=w1 verdict=e2e (core delivered over migrated session)', // daemon verdict line — ignored
  ].join('\n');
  const p = parseE2eLogs(logs);
  assert.equal(p.actives.length, 1);
  assert.equal(p.actives[0].role, 'initiator');
  assert.equal(p.sends.length, 1);
  assert.equal(p.sends[0].olm_type, '1');
  assert.equal(p.recvs.length, 1);
  assert.equal(p.recvs[0].ok, true);
});

test('verify1867ForCid: PASSES when app data rides the rotated session on both send + recv', () => {
  const logs = [
    `[migration] active cid=${CID} role=responder epoch=${'ee'.repeat(16)} session_id=${POST}`,
    `[e2e-app] send cid=${CID} session_id=${POST} olm_type=0 wire_id=w1`,
    `[e2e-app] recv cid=${CID} session_id=${POST} ok=true wire_id=w2`,
  ].join('\n');
  const r = verify1867ForCid(logs, CID, PRE);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.pin, POST);
  assert.equal(r.appLines, 2);
});

test('verify1867ForCid: FAILS when the session did not rotate (pin == pre-migration)', () => {
  const logs = [
    `[migration] active cid=${CID} role=initiator epoch=${'ee'.repeat(16)} session_id=${PRE}`,
    `[e2e-app] send cid=${CID} session_id=${PRE} olm_type=1 wire_id=w1`,
  ].join('\n');
  const r = verify1867ForCid(logs, CID, PRE);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /did not rotate/);
});

test('verify1867ForCid: FAILS when an app send used a different session than the active pin', () => {
  const logs = [
    `[migration] active cid=${CID} role=initiator epoch=${'ee'.repeat(16)} session_id=${POST}`,
    `[e2e-app] send cid=${CID} session_id=${'cc'.repeat(16)} olm_type=1 wire_id=w1`,
  ].join('\n');
  const r = verify1867ForCid(logs, CID, PRE);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /!= active pin/);
});

test('verify1867ForCid: FAILS when active is present but NO app data traversed the migrated session', () => {
  const logs = `[migration] active cid=${CID} role=initiator epoch=${'ee'.repeat(16)} session_id=${POST}`;
  const r = verify1867ForCid(logs, CID, PRE);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /no \[e2e-app\] send\/recv/);
});

test('verify1867ForCid: FAILS on a recv that did not decrypt (ok=false)', () => {
  const logs = [
    `[migration] active cid=${CID} role=responder epoch=${'ee'.repeat(16)} session_id=${POST}`,
    `[e2e-app] recv cid=${CID} session_id=${POST} ok=false wire_id=w2`,
  ].join('\n');
  const r = verify1867ForCid(logs, CID, PRE);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /ok=false/);
});

// --- authoritative-snapshot anchoring (non-circular, per MigrationReview's soundness note) -----
test('verify1867ForCid: PASSES against the authoritative {pre,post} active_session_id snapshot', () => {
  const logs = [
    `[migration] active cid=${CID} role=initiator epoch=${'ee'.repeat(16)} session_id=${POST}`,
    `[e2e-app] send cid=${CID} session_id=${POST} olm_type=1 wire_id=w1`,
    `[e2e-app] recv cid=${CID} session_id=${POST} ok=true wire_id=w2`,
  ].join('\n');
  const r = verify1867ForCid(logs, CID, { pre: PRE, post: POST });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('verify1867ForCid: CATCHES a stale-session send that a circular (pin-only) check would miss', () => {
  // The notify pin re-read active_session_id (== POST) but the app actually sent on the OLD session
  // (PRE). A pin-only check would pass; anchoring on the authoritative POST snapshot catches it.
  const logs = [
    `[migration] active cid=${CID} role=initiator epoch=${'ee'.repeat(16)} session_id=${POST}`,
    `[e2e-app] send cid=${CID} session_id=${PRE} olm_type=1 wire_id=w1`,
  ].join('\n');
  assert.equal(verify1867ForCid(logs, CID, PRE).ok, false, 'even pin-only catches PRE != POST pin here');
  const r = verify1867ForCid(logs, CID, { pre: PRE, post: POST });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /!= authoritative/);
});

test('verify1867ForCid: FAILS when the authoritative snapshot did not rotate (post == pre)', () => {
  const logs = [
    `[migration] active cid=${CID} role=initiator epoch=${'ee'.repeat(16)} session_id=${PRE}`,
    `[e2e-app] send cid=${CID} session_id=${PRE} olm_type=1 wire_id=w1`,
  ].join('\n');
  const r = verify1867ForCid(logs, CID, { pre: PRE, post: PRE });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /did not rotate/);
});
