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
  // Each record carries `at` (line index) so the verifier can split [e2e-app] lines PRE vs POST the
  // [migration] active line — the pre ones are the pre-migration baseline for the rotation proof.
  const sends = [], recvs = [], actives = [];
  String(text).split('\n').forEach((line, at) => {
    let m;
    if ((m = line.match(/\[e2e-app\] send cid=(\S+) session_id=(\S+) olm_type=(\S+) wire_id=(\S+)/)))
      sends.push({ at, cid: m[1], session_id: m[2], olm_type: m[3], wire_id: m[4] });
    else if ((m = line.match(/\[e2e-app\] recv cid=(\S+) session_id=(\S+) ok=(\S+) wire_id=(\S+)/)))
      recvs.push({ at, cid: m[1], session_id: m[2], ok: m[3] === 'true', wire_id: m[4] });
    else if ((m = line.match(/\[migration\] active cid=(\S+) role=(\S+) epoch=(\S+) session_id=(\S+)/)))
      actives.push({ at, cid: m[1], role: m[2], epoch: m[3], session_id: m[4] });
  });
  return { sends, recvs, actives };
}

// #1867 assertion for ONE migrated contact on ONE node's logs. A real proof needs BOTH halves:
//   (1) CONSISTENCY — every POST-migration [e2e-app] send/recv session_id == the [migration] active
//       pin, and recv ok=true (app data actually rode the migrated session), AND
//   (2) ROTATION — the active pin DIFFERS from the PRE-migration baseline session (MR2's DRY fix): the
//       migrated session is a NEW ratchet, not the old one. Consistency alone is NOT #1867 — a session
//       that never rotated would still be internally consistent. So rotation is REQUIRED, not optional.
//
// The baseline comes from EITHER an authoritative `snap.pre` (a pre-migration active_session_id snapshot
// the harness captured) OR — since the e2e_active_session trn was dropped @407a3ad — the session_id of a
// PRE-migration [e2e-app] line (an [e2e-app] emit that appears in the log BEFORE the [migration] active
// line). If NEITHER exists, rotation CANNOT be proven and the verdict FAILS (it must not overclaim):
// the log-shape must include a pre-migration [e2e-app] baseline (guide §3 establishes a pre-migration
// e2e session before the migration triggers) or a snap.pre snapshot.
//
// `snap.post` (if provided) additionally anchors the pin on an INDEPENDENT authoritative value
// (pin == snap.post), hardening the reference. NOTE (MR2): app-line truthfulness (that a POST line's
// session_id came from the REAL send/recv envelope, not a re-read of active_session_id) is a
// COMPLEMENTARY core-side guarantee this readout can't establish from logs alone.
export function verify1867ForCid(logs, cid, snap = {}) {
  const preSnap = typeof snap === 'string' ? snap : snap.pre;   // back-compat: a bare string == pre snapshot
  const post = typeof snap === 'string' ? undefined : snap.post;
  const { sends, recvs, actives } = parseE2eLogs(logs);
  const active = actives.find((a) => a.cid === cid);
  const problems = [];
  if (!active) problems.push('no [migration] active line for cid');
  const pin = active?.session_id;
  const activeAt = active ? active.at : Infinity;
  const truth = post || pin;
  const mine = [...sends.filter((s) => s.cid === cid), ...recvs.filter((r) => r.cid === cid)];
  const preApp = mine.filter((x) => x.at < activeAt);            // pre-migration [e2e-app] = baseline
  const postApp = mine.filter((x) => x.at > activeAt);           // migrated [e2e-app] = must == pin

  // (1) CONSISTENCY — post-migration app lines ride the pin; recvs decrypt.
  for (const x of postApp) if (x.session_id !== truth) problems.push(`post wire_id=${x.wire_id} session_id ${x.session_id} != ${post ? 'authoritative' : 'active pin'} ${truth}`);
  for (const r of recvs.filter((r) => r.cid === cid && r.at > activeAt)) if (!r.ok) problems.push(`recv wire_id=${r.wire_id} ok=false (decrypt failed)`);
  if (active && postApp.length === 0) problems.push('no POST-migration [e2e-app] for cid — no app data proven over the migrated session');
  if (active && post && pin !== post) problems.push(`active pin ${pin} != authoritative active_session_id ${post}`);

  // (2) ROTATION — active pin must differ from the pre-migration baseline (snap.pre OR a pre-active line).
  const preSids = [...new Set(preApp.map((x) => x.session_id))];
  const baseline = preSnap ?? (preSids.length ? preSids[0] : undefined);
  let rotationProven = false;
  if (baseline !== undefined && active) {
    // rotation is only meaningful against a REAL active pin; without [migration] active there is
    // nothing to compare (an undefined pin trivially != baseline — the spurious-true trap).
    if (pin === baseline) problems.push(`session did NOT rotate: active pin == pre-migration baseline ${baseline}`);
    else rotationProven = true;
  } else if (active) {
    problems.push('rotation NOT proven: no pre-migration baseline (no [e2e-app] session_id before [migration] active, and no snap.pre) — consistency-only, does not establish #1867');
  }

  return { ok: problems.length === 0, pin, baseline, rotationProven, appLines: postApp.length, sends: postApp.filter((x) => 'olm_type' in x).length, recvs: postApp.filter((x) => 'ok' in x).length, problems };
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

const ACTIVE = (pin, role = 'responder') => `[migration] active cid=${CID} role=${role} epoch=${'ee'.repeat(16)} session_id=${pin}`;
const PRELINE = (w = 'p0') => `[e2e-app] send cid=${CID} session_id=${PRE} olm_type=1 wire_id=${w}`;  // pre-migration baseline

test('verify1867ForCid: PASSES with rotation proven from a PRE-migration [e2e-app] baseline (log-derived)', () => {
  const logs = [
    PRELINE(),                                                    // pre-migration session = PRE (baseline)
    ACTIVE(POST),                                                 // migrated pin = POST (rotated)
    `[e2e-app] send cid=${CID} session_id=${POST} olm_type=0 wire_id=w1`,
    `[e2e-app] recv cid=${CID} session_id=${POST} ok=true wire_id=w2`,
  ].join('\n');
  const r = verify1867ForCid(logs, CID);                         // no snap — baseline from the pre line
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.rotationProven, true);
  assert.equal(r.pin, POST); assert.equal(r.baseline, PRE); assert.equal(r.appLines, 2);
});

test('verify1867ForCid: does NOT overclaim — FAILS when there is NO pre-migration baseline (consistency-only)', () => {
  const logs = [
    ACTIVE(POST),
    `[e2e-app] send cid=${CID} session_id=${POST} olm_type=0 wire_id=w1`,
    `[e2e-app] recv cid=${CID} session_id=${POST} ok=true wire_id=w2`,
  ].join('\n');
  const r = verify1867ForCid(logs, CID);                         // no snap, no pre-migration [e2e-app] line
  assert.equal(r.ok, false);
  assert.equal(r.rotationProven, false);
  assert.match(r.problems.join('|'), /rotation NOT proven/);
});

test('verify1867ForCid: baseline present but NO [migration] active must NOT claim rotation (spurious-true trap)', () => {
  // The both-caps-from-boot determinism case: pre-migration baseline forms (e2e-pinned), but
  // migration never triggers (no active line). rotationProven must stay FALSE — an undefined pin
  // trivially differs from the baseline, which previously read as a false rotation proof.
  const logs = [PRELINE('p0'), PRELINE('p1')].join('\n');          // baseline lines only, no ACTIVE
  const r = verify1867ForCid(logs, CID);
  assert.equal(r.baseline, PRE);
  assert.equal(r.rotationProven, false);                           // NOT spuriously true
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /no \[migration\] active/);
});

test('verify1867ForCid: FAILS when the session did not rotate (pin == pre-migration baseline)', () => {
  const logs = [PRELINE(), ACTIVE(PRE, 'initiator'), `[e2e-app] send cid=${CID} session_id=${PRE} olm_type=1 wire_id=w1`].join('\n');
  const r = verify1867ForCid(logs, CID);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /did NOT rotate/);
});

test('verify1867ForCid: FAILS when a POST-migration app send used a different session than the pin', () => {
  const logs = [PRELINE(), ACTIVE(POST), `[e2e-app] send cid=${CID} session_id=${'cc'.repeat(16)} olm_type=1 wire_id=w1`].join('\n');
  const r = verify1867ForCid(logs, CID);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /!= active pin/);
});

test('verify1867ForCid: FAILS when there is NO post-migration app data over the migrated session', () => {
  const logs = [PRELINE(), ACTIVE(POST)].join('\n');             // baseline present, but nothing rode the new session
  const r = verify1867ForCid(logs, CID);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /no POST-migration/);
});

test('verify1867ForCid: FAILS on a recv that did not decrypt (ok=false)', () => {
  const logs = [PRELINE(), ACTIVE(POST), `[e2e-app] recv cid=${CID} session_id=${POST} ok=false wire_id=w2`].join('\n');
  const r = verify1867ForCid(logs, CID);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /ok=false/);
});

// --- authoritative-snapshot anchoring (non-circular; supplies the baseline when there's no pre line) --
test('verify1867ForCid: PASSES against the authoritative {pre,post} snapshot (rotation via snap.pre)', () => {
  const logs = [                                                 // NO pre-migration [e2e-app] line…
    ACTIVE(POST),
    `[e2e-app] send cid=${CID} session_id=${POST} olm_type=1 wire_id=w1`,
    `[e2e-app] recv cid=${CID} session_id=${POST} ok=true wire_id=w2`,
  ].join('\n');
  const r = verify1867ForCid(logs, CID, { pre: PRE, post: POST });  // …snap.pre supplies the baseline
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.rotationProven, true);
});

test('verify1867ForCid: authoritative anchoring catches a WRONG PIN that a log-only check accepts', () => {
  const W = 'dd'.repeat(16); // a wrong session id, != PRE and != POST
  const logs = [PRELINE(), ACTIVE(W), `[e2e-app] send cid=${CID} session_id=${W} olm_type=1 wire_id=w1`, `[e2e-app] recv cid=${CID} session_id=${W} ok=true wire_id=w2`].join('\n');
  assert.equal(verify1867ForCid(logs, CID).ok, true, 'log-only: W is consistent + rotated vs PRE baseline');
  const r = verify1867ForCid(logs, CID, { pre: PRE, post: POST });
  assert.equal(r.ok, false, 'anchoring rejects: pin != authoritative post');
  assert.match(r.problems.join('|'), /!= authoritative/);
});

test('verify1867ForCid: FAILS when the authoritative snapshot did not rotate (post == pre)', () => {
  const logs = [ACTIVE(PRE, 'initiator'), `[e2e-app] send cid=${CID} session_id=${PRE} olm_type=1 wire_id=w1`].join('\n');
  const r = verify1867ForCid(logs, CID, { pre: PRE, post: PRE });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('|'), /did NOT rotate/);
});
