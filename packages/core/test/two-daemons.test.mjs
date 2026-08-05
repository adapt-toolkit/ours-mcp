// two-daemons — the multi-daemon reliability contract, end to end.
//
// Two real daemons run at once on dynamic ports over mkdtemp state dirs, and we
// assert the four things that used to go wrong silently:
//   1. each daemon can prove WHICH daemon it is (/info identity)
//   2. a daemon that cannot have the port says so, actionably, without a stack
//   3. a daemon may never share another's state directory
//   4. `start` never reports success for somebody else's daemon
// plus the config precedence (env > config.json > default) those depend on.
//
// SAFETY: every state dir is a fresh mkdtemp and every port is bound-then-freed
// by the OS. The live daemon and ~/.ours are never touched — asserted below
// before anything is spawned.
//
// Self-contained: spawns the BUILT daemon. Run after `npm run build`.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
// Deliberately unreachable: these daemons must never talk to a real broker.
const BROKER = 'ws://127.0.0.1:59997/nobroker';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const stateDirs = [];
function tempState(tag) {
  const dir = mkdtempSync(join(tmpdir(), `ours-two-${tag}-`));
  stateDirs.push(dir);
  return dir;
}

// A clean environment for every child: the host running this suite may itself be
// an ours user, and an inherited OURS_CONFIG/OURS_API_TOKEN/OURS_STATE_DIR would
// silently point a test daemon at the real installation.
function childEnv(extra) {
  const env = { ...process.env };
  for (const k of ['OURS_CONFIG', 'OURS_API_TOKEN', 'OURS_API_VISIBILITY', 'OURS_STATE_DIR', 'OURS_PORT', 'OURS_INSTANCE', 'OURS_AUTOSTART']) {
    delete env[k];
  }
  return { ...env, OURS_TRANSPORT: 'http', OURS_BROKER_URL: BROKER, ...extra };
}

const running = [];
function startDaemon(port, dir, extra = {}) {
  const child = spawn(process.execPath, [CLI, 'serve'], {
    env: childEnv({ OURS_PORT: String(port), OURS_STATE_DIR: dir, ...extra }),
    stdio: 'ignore',
    detached: true,
  });
  running.push(child);
  return child;
}
const kill = (child) => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };

async function waitVersion(port, maxMs = 60_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}
const info = async (port) => (await fetch(`http://127.0.0.1:${port}/info`)).json();

console.log('two-daemons\n');

// ─── guard: nothing here may touch the live installation ─────────────────────
const HOME_STATE = resolve(homedir(), '.ours');
const dirA = tempState('a');
const dirB = tempState('b');
const dirC = tempState('c');
for (const [label, dir] of [['A', dirA], ['B', dirB], ['C', dirC]]) {
  const under = resolve(dir).startsWith(resolve(tmpdir()));
  ok(under && resolve(dir) !== HOME_STATE, `guard: state dir ${label} is a temp dir, not ${HOME_STATE}`);
  if (!under || resolve(dir) === HOME_STATE) {
    console.log('\nrefusing to run against non-temporary state.');
    process.exit(1);
  }
}

const portA = await freePort();
const portB = await freePort();

try {
  // ─── two daemons, live at the same time ────────────────────────────────────
  const a = startDaemon(portA, dirA, { OURS_INSTANCE: 'alpha' });
  const b = startDaemon(portB, dirB, { OURS_INSTANCE: 'beta' });
  const upA = await waitVersion(portA);
  const upB = await waitVersion(portB);
  ok(upA, 'daemon A boots on its own port + state dir');
  ok(upB, 'daemon B boots simultaneously on a different port + state dir');
  if (!upA || !upB) throw new Error('both daemons must be up for the rest of the suite');

  // ─── 1. each daemon can prove which daemon it is ───────────────────────────
  const infoA = await info(portA);
  const infoB = await info(portB);
  ok(resolve(infoA.stateDir) === resolve(dirA), 'A reports its OWN state dir over /info');
  ok(resolve(infoB.stateDir) === resolve(dirB), 'B reports its OWN state dir over /info');
  ok(infoA.instance === 'alpha' && infoB.instance === 'beta', '/info carries the instance label');
  ok(infoA.port === portA && infoB.port === portB, '/info carries the endpoint it is serving');
  ok(
    typeof infoA.stateFingerprint === 'string' && infoA.stateFingerprint !== infoB.stateFingerprint,
    'the two daemons have distinct state fingerprints',
  );
  ok(typeof infoA.startedAt === 'string', '/info reports when the daemon started');
  ok(infoA.name === 'ours' && Number.isInteger(infoA.protocol), '/info still identifies the service and protocol');
  ok(!JSON.stringify(infoA).includes('daemon-token'), '/info leaks no token material');

  // /info is the collision-diagnostics channel, so it must work without a token
  // even in owner mode (the default these daemons are running under).
  ok((await fetch(`http://127.0.0.1:${portA}/info`)).status === 200, '/info stays unauthenticated');
  ok((await fetch(`http://127.0.0.1:${portA}/identities`)).status === 401, 'the identity list stays behind auth');

  // ─── 2. port collision: actionable, no stack trace ─────────────────────────
  {
    const clash = spawnSync(process.execPath, [CLI, 'serve'], {
      env: childEnv({ OURS_PORT: String(portA), OURS_STATE_DIR: dirC }),
      encoding: 'utf8',
      timeout: 90_000,
    });
    const text = `${clash.stdout}${clash.stderr}`;
    ok(clash.status === 3, `a daemon aimed at a taken port exits 3 (got ${clash.status})`);
    ok(/already in use by another ours daemon/.test(text), 'it says the port belongs to another ours daemon');
    ok(/instance "alpha"/.test(text) && text.includes(dirA), 'it names WHICH daemon is there');
    ok(/OURS_PORT=.*OURS_STATE_DIR=/.test(text), 'it prescribes a different port AND state dir');
    ok(!/at .*\(.*:\d+:\d+\)/.test(text) && !/EADDRINUSE/.test(text), 'no stack trace, no raw EADDRINUSE');
    ok(!existsSync(join(dirC, 'daemon.pid')), 'the refused daemon left no pidfile behind');
  }

  // ─── 3. state collision: a free port is not enough ─────────────────────────
  {
    const pidBefore = readFileSync(join(dirA, 'daemon.pid'), 'utf8').trim();
    const freeish = await freePort();
    const clash = spawnSync(process.execPath, [CLI, 'serve'], {
      env: childEnv({ OURS_PORT: String(freeish), OURS_STATE_DIR: dirA }),
      encoding: 'utf8',
      timeout: 90_000,
    });
    const text = `${clash.stdout}${clash.stderr}`;
    ok(clash.status === 4, `a daemon on a FREE port but a taken state dir exits 4 (got ${clash.status})`);
    ok(/already owned by instance "alpha"/.test(text), 'it names the instance that owns the state dir');
    ok(/NEVER share/.test(text), 'it states that sharing writable state is forbidden');
    ok(text.includes(join(dirA, 'daemon.lock')), 'it names the lock file');
    ok(!/at .*\(.*:\d+:\d+\)/.test(text), 'no stack trace');

    // The regression this ordering exists for: a refused daemon must not clobber
    // the shared pidfile of the daemon that legitimately owns the directory.
    ok(
      readFileSync(join(dirA, 'daemon.pid'), 'utf8').trim() === pidBefore,
      "the refused daemon did not overwrite the owner's daemon.pid",
    );
    ok(String(await (await fetch(`http://127.0.0.1:${portA}/info`)).status) === '200', 'daemon A is still serving');
  }

  // ─── 4. `start` never claims somebody else's daemon ────────────────────────
  {
    const start = spawnSync(process.execPath, [CLI, 'start'], {
      env: childEnv({ OURS_PORT: String(portA), OURS_STATE_DIR: dirC }),
      encoding: 'utf8',
      timeout: 90_000,
    });
    const text = `${start.stdout}${start.stderr}`;
    ok(start.status !== 0, `start against another daemon's port fails (exit ${start.status})`);
    ok(!/is up on http/.test(text), 'it does NOT print the success line for a daemon it did not start');
    ok(/already in use by another ours daemon/.test(text), 'it explains whose port it is');
    ok(!existsSync(join(dirC, 'daemon.pid')), 'and it never spawned a daemon');
  }

  // ─── `status --json` is machine-readable and knows whose daemon it found ───
  {
    const own = JSON.parse(
      spawnSync(process.execPath, [CLI, 'status', '--json'], {
        env: childEnv({ OURS_PORT: String(portA), OURS_STATE_DIR: dirA }),
        encoding: 'utf8', timeout: 30_000,
      }).stdout,
    );
    ok(own.running === true && own.reachable === true, 'status --json reports the daemon as running');
    ok(own.ownDaemon === true, 'status --json confirms the port serves THIS state dir');
    ok(own.port === portA && resolve(own.stateDir) === resolve(dirA), 'status --json echoes the resolved endpoint');
    ok(own.daemon?.instance === 'alpha', 'status --json reports the running daemon identity');
    ok(own.lockHeldBy === own.daemon?.pid, 'status --json reports the state-lock holder');
    ok(typeof own.cliVersion === 'string' && own.daemon?.version, 'status --json reports both CLI and daemon versions');

    // The multi-daemon smell: reachable, but not yours.
    const foreign = JSON.parse(
      spawnSync(process.execPath, [CLI, 'status', '--json'], {
        env: childEnv({ OURS_PORT: String(portA), OURS_STATE_DIR: dirC }),
        encoding: 'utf8', timeout: 30_000,
      }).stdout,
    );
    ok(foreign.reachable === true && foreign.ownDaemon === false, 'status --json flags a port owned by a DIFFERENT daemon');
    ok(resolve(foreign.daemon.stateDir) === resolve(dirA), 'and reports the state dir actually being served');

    const stopped = spawnSync(process.execPath, [CLI, 'status', '--json'], {
      env: childEnv({ OURS_PORT: String(await freePort()), OURS_STATE_DIR: tempState('idle') }),
      encoding: 'utf8', timeout: 30_000,
    });
    ok(stopped.status === 1, 'status --json exits 1 when nothing is running');
    ok(JSON.parse(stopped.stdout).running === false, 'and says so in the JSON');

    // The installer parses the human output; it must keep its exact shape.
    const text = spawnSync(process.execPath, [CLI, 'status'], {
      env: childEnv({ OURS_PORT: String(portA), OURS_STATE_DIR: dirA }),
      encoding: 'utf8', timeout: 30_000,
    }).stdout;
    ok(/^\s*broker:\s*\S+/m.test(text), 'human status still prints the broker line the installer parses');
    ok(new RegExp(`url:\\s*http://[^:\\s/]+:${portA}/mcp`).test(text), 'human status still prints the url line the installer parses');
  }

  // ─── identity isolation: two daemons are two separate presences ────────────
  {
    const tokenA = readFileSync(join(dirA, 'daemon-token'), 'utf8').trim();
    const tokenB = readFileSync(join(dirB, 'daemon-token'), 'utf8').trim();
    ok(tokenA !== tokenB, 'each state dir mints its own API token');
    const asA = await fetch(`http://127.0.0.1:${portA}/identities`, { headers: { 'x-ours-api-token': tokenA } });
    const crossed = await fetch(`http://127.0.0.1:${portB}/identities`, { headers: { 'x-ours-api-token': tokenA } });
    ok(asA.status === 200, "A's token works against A");
    ok(crossed.status === 401, "A's token does NOT authenticate against B");
  }

  // ─── config precedence: env > config.json > default ────────────────────────
  {
    const dir = tempState('prec');
    const filePort = await freePort();
    const envPort = await freePort();
    const cfgPath = join(dir, 'config.json');
    const fileState = tempState('prec-file');
    writeFileSync(cfgPath, JSON.stringify({ port: filePort, stateDir: fileState, brokerUrl: BROKER }));

    // config.json alone wins over the built-in defaults (3050 / ~/.ours).
    const viaFile = spawn(process.execPath, [CLI, 'serve'], {
      env: (() => { const e = childEnv({ OURS_CONFIG: cfgPath }); delete e.OURS_PORT; delete e.OURS_STATE_DIR; return e; })(),
      stdio: 'ignore', detached: true,
    });
    running.push(viaFile);
    ok(await waitVersion(filePort), 'config.json port/stateDir beat the built-in defaults');
    const fileInfo = await info(filePort);
    ok(resolve(fileInfo.stateDir) === resolve(fileState), 'config.json stateDir is what the daemon actually uses');
    ok(fileInfo.port === filePort && filePort !== 3050, 'config.json port is what the daemon actually binds');
    kill(viaFile);
    await sleep(500);

    // …and the environment beats config.json, field by field.
    const envState = tempState('prec-env');
    const viaEnv = spawn(process.execPath, [CLI, 'serve'], {
      env: childEnv({ OURS_CONFIG: cfgPath, OURS_PORT: String(envPort), OURS_STATE_DIR: envState }),
      stdio: 'ignore', detached: true,
    });
    running.push(viaEnv);
    ok(await waitVersion(envPort), 'OURS_PORT overrides the config.json port');
    const envInfo = await info(envPort);
    ok(resolve(envInfo.stateDir) === resolve(envState), 'OURS_STATE_DIR overrides the config.json stateDir');
    ok(envInfo.instance === 'default', 'no OURS_INSTANCE → the daemon reports the default label');
    kill(viaEnv);
  }

  // ─── a graceful stop hands the state directory back ────────────────────────
  {
    ok(existsSync(join(dirB, 'daemon.lock')), 'a running daemon holds its state lock');
    spawnSync(process.execPath, [CLI, 'stop'], {
      env: childEnv({ OURS_PORT: String(portB), OURS_STATE_DIR: dirB }),
      encoding: 'utf8', timeout: 30_000,
    });
    const deadline = Date.now() + 10_000;
    while (existsSync(join(dirB, 'daemon.lock')) && Date.now() < deadline) await sleep(200);
    ok(!existsSync(join(dirB, 'daemon.lock')), 'stopping the daemon releases the state lock');

    const reuse = await freePort();
    const revived = startDaemon(reuse, dirB, {});
    ok(await waitVersion(reuse), 'the released state dir can be claimed again');
    kill(revived);
  }

  kill(a);
  kill(b);
} finally {
  for (const child of running) kill(child);
  await sleep(300);
  for (const dir of stateDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(`\ntwo-daemons: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
