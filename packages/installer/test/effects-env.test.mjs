// ours-install v3 — the daemon pair, and the one place it can be built.
//
// Spec §2: a state directory and an endpoint always travel together, and
// "endpoint selected, state directory defaulted" must be unreachable. Downstream
// every consumer FALLS BACK to ~/.ours for whichever name is missing, so a half
// pair does not fail loudly — it silently attaches to the wrong daemon. These
// tests are the guard against that, and nothing here spawns a process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { daemonEnv, isWholeDaemonEnv, DAEMON_ENV_KEYS, realEffects } from '../lib/effects.mjs';

const TG = resolve('/home/me', '.ours-tg');

test('daemonEnv emits the WHOLE pair or nothing — it cannot be asked for half', () => {
  const env = daemonEnv(TG, 3061);
  assert.deepEqual(env, {
    OURS_CONFIG: join(TG, 'config.json'),
    OURS_STATE_DIR: TG,
    OURS_PORT: '3061',
  });
  assert.deepEqual(Object.keys(env).sort(), [...DAEMON_ENV_KEYS].sort());
  assert.ok(isWholeDaemonEnv(env));

  // Every way of asking for one half is a refusal, not a default.
  for (const bad of [[null, 3061], ['', 3061], ['   ', 3061], [TG, null], [TG, undefined], [TG, 0], [TG, 70000], [TG, 3061.5], [TG, '3061']]) {
    assert.throws(() => daemonEnv(bad[0], bad[1]), /refusing to build half of the daemon pair/,
      `daemonEnv(${JSON.stringify(bad[0])}, ${JSON.stringify(bad[1])}) must refuse`);
  }
});

test('the port is carried explicitly, not left to whatever config.json happens to say', () => {
  // OURS_CONFIG alone would resolve the port from the file — and the file and
  // the running daemon are exactly the two things lib/target.mjs's second
  // lookup exists because they diverge.
  assert.equal(daemonEnv(TG, 3061).OURS_PORT, '3061');
  assert.equal(daemonEnv(TG, 3050).OURS_PORT, '3050');
});

test('a relative state directory is resolved before it is handed to a child', () => {
  const env = daemonEnv('.', 3050);
  assert.equal(env.OURS_STATE_DIR, resolve('.'));
  assert.equal(env.OURS_CONFIG, join(resolve('.'), 'config.json'));
});

test('isWholeDaemonEnv rejects every half pair, and an inconsistent one', () => {
  assert.ok(isWholeDaemonEnv(null), 'no daemon env at all is fine');
  assert.ok(isWholeDaemonEnv({}), 'and so is an unrelated env');
  assert.ok(isWholeDaemonEnv({ PATH: '/usr/bin' }));
  for (const key of DAEMON_ENV_KEYS) {
    const half = { ...daemonEnv(TG, 3061) };
    delete half[key];
    assert.equal(isWholeDaemonEnv(half), false, `dropping ${key} must not pass`);
    const blank = { ...daemonEnv(TG, 3061), [key]: '' };
    assert.equal(isWholeDaemonEnv(blank), false, `blanking ${key} must not pass`);
  }
  const mismatched = { ...daemonEnv(TG, 3061), OURS_CONFIG: '/somewhere/else/config.json' };
  assert.equal(isWholeDaemonEnv(mismatched), false, 'a config pointing outside its own state dir is a split pair');
});

test('effects.run applies the pair to the CHILD only, never to the installer itself', async () => {
  // The installer may target a state directory the operator did not otherwise
  // choose. If that leaked into process.env, everything the operator started
  // afterwards from this process would silently inherit it.
  //
  // The child is `node -e`, printing back what it was given. No service, no
  // daemon, no network — the only subprocess in this file.
  const before = DAEMON_ENV_KEYS.map((k) => process.env[k]);
  // A base env with no daemon names in it: this host's own shell exports some,
  // and the question here is what the installer hands over, not what it inherited.
  const base = { ...process.env };
  for (const key of DAEMON_ENV_KEYS) delete base[key];
  const effects = realEffects({ env: base, out: () => {} });
  const echo = ['-e', "process.stdout.write(JSON.stringify([process.env.OURS_CONFIG||'',process.env.OURS_STATE_DIR||'',process.env.OURS_PORT||'']))"];

  const withPair = await effects.run(process.execPath, echo, { env: daemonEnv(TG, 3061) });
  assert.deepEqual(JSON.parse(withPair.stdout), [join(TG, 'config.json'), TG, '3061']);

  const without = await effects.run(process.execPath, echo);
  assert.deepEqual(JSON.parse(without.stdout), ['', '', ''], 'no env asked for, none handed over');

  assert.deepEqual(DAEMON_ENV_KEYS.map((k) => process.env[k]), before, 'the installer process is unchanged');
});
