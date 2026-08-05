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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'cli.js');
const CONFIG_URL = pathToFileURL(join(HERE, '..', 'dist', 'config.js')).href;
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
//
// DELETING OURS_CONFIG IS NOT ISOLATION. It was what this did, and it is worse
// than doing nothing: with the variable unset, config.ts falls back to
// <home>/.ours/config.json — the LIVE file. strace showed every child opening it.
// That file can carry apiVisibility, an apiToken, and an STT provider key, any of
// which would silently steer a test daemon or pull a real secret into it.
//
// So every child gets, positively:
//   OURS_CONFIG — a test-owned empty {} file. Semantically identical to "no
//                 config" (readFileConfig returns {} either way) but ours.
//   HOME        — a temp dir, so every ~/-derived path resolves inside tmpdir:
//                 DEFAULT_CONFIG.stateDir AND configPath()'s fallback alike.
//                 It must be set at SPAWN time; config.ts reads homedir() at
//                 module load, so mutating it in-process would do nothing.
// Both are defence in depth over the explicit OURS_PORT/OURS_STATE_DIR that
// almost every child also gets — the point is that no child depends on them.
const TEST_HOME = tempState('home');
const TEST_CONFIG = join(tempState('cfg'), 'config.json');
writeFileSync(TEST_CONFIG, '{}\n');

function childEnv(extra) {
  const env = { ...process.env };
  for (const k of ['OURS_CONFIG', 'OURS_API_TOKEN', 'OURS_API_VISIBILITY', 'OURS_STATE_DIR', 'OURS_PORT', 'OURS_INSTANCE', 'OURS_AUTOSTART']) {
    delete env[k];
  }
  return {
    ...env,
    HOME: TEST_HOME,
    OURS_CONFIG: TEST_CONFIG,
    OURS_TRANSPORT: 'http',
    OURS_BROKER_URL: BROKER,
    ...extra,
  };
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
const LIVE_CONFIG = join(HOME_STATE, 'config.json');
const TMP_ROOT = resolve(tmpdir());
const underTmp = (p) => typeof p === 'string' && resolve(p).startsWith(TMP_ROOT);

const dirA = tempState('a');
const dirB = tempState('b');
const dirC = tempState('c');
for (const [label, dir] of [['A', dirA], ['B', dirB], ['C', dirC]]) {
  const under = underTmp(dir);
  ok(under && resolve(dir) !== HOME_STATE, `guard: state dir ${label} is a temp dir, not ${HOME_STATE}`);
  if (!under || resolve(dir) === HOME_STATE) {
    console.log('\nrefusing to run against non-temporary state.');
    process.exit(1);
  }
}

// ─── preflight: the daemon cannot boot without its compiled packet ───────────
// index.ts resolves the ADAPT packet from dist/mufl_code, then ../mufl_code, and
// throws when neither holds a *.muflo. Children run with stdio:'ignore', so that
// throw is invisible: waitVersion would burn its full 60 s budget per daemon and
// the suite would then blame "both daemons must be up" — true, and useless. Cost
// of finding out the honest way: about two minutes. Cost of this check: one stat.
const MUFL_DIRS = [join(HERE, '..', 'dist', 'mufl_code'), join(HERE, '..', 'mufl_code')];
const havePacket = MUFL_DIRS.some((d) => {
  try {
    return readdirSync(d).some((f) => f.endsWith('.muflo'));
  } catch {
    return false;
  }
});
ok(havePacket, 'preflight: a compiled .muflo packet exists, so the daemon can boot at all');
if (!havePacket) {
  console.log(
    `\nrefusing to run: no *.muflo packet in any of:\n  ${MUFL_DIRS.join('\n  ')}\n` +
      'Run `npm run build` in packages/core first — every daemon in this suite would\n' +
      'otherwise fail to boot and be misreported as a timeout.',
  );
  console.log(`\ntwo-daemons: ${pass} passed, ${fail} failed`);
  process.exit(1);
}

// ─── regression: no child may resolve a LIVE ~/.ours path ────────────────────
// Structural, not host-dependent. Two layers:
//   (a) over the env BUILDER, which covers every child by construction rather
//       than by inspecting them one at a time;
//   (b) over the REAL shipped resolver, run in a fresh process on that exact env,
//       because what matters is the paths config.ts actually computes — not the
//       ones we believe it will. Resolution only: it binds no port and starts no
//       daemon.
{
  const e = childEnv({});
  ok(underTmp(e.OURS_CONFIG), 'childEnv points every child at an OURS_CONFIG under tmpdir');
  ok(resolve(e.OURS_CONFIG) !== LIVE_CONFIG, 'childEnv never points a child at the live config file');
  ok(underTmp(e.HOME), 'childEnv gives every child a HOME under tmpdir');
  ok(resolve(e.HOME) !== resolve(homedir()), 'childEnv never leaves a child on the live HOME');

  const probe = spawnSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(CONFIG_URL)}).then((m) => process.stdout.write(JSON.stringify({ cfg: m.configPath(), state: m.loadConfig().stateDir })));`],
    { env: childEnv({}), encoding: 'utf8', timeout: 30_000 },
  );
  let seen = null;
  try { seen = JSON.parse(probe.stdout); } catch { /* reported below */ }
  ok(seen !== null, `the resolver probe returned JSON (stderr: ${probe.stderr?.trim().slice(0, 200) || 'none'})`);
  if (seen) {
    ok(resolve(seen.cfg) !== LIVE_CONFIG, 'a child never RESOLVES the live ~/.ours/config.json');
    ok(underTmp(seen.cfg), 'the config path a child resolves is under tmpdir');
    ok(resolve(seen.state) !== HOME_STATE, 'a child never resolves the live state dir');
    ok(underTmp(seen.state), 'the state dir a child resolves is under tmpdir, even with no OURS_STATE_DIR set');
  }
}

// ─── config-only spawn safety ────────────────────────────────────────────────
// One case below deliberately spawns a daemon with NO OURS_PORT and NO
// OURS_STATE_DIR, because that is the only way to prove config.json beats the
// built-in defaults. It is also the one place in this file where a fallback can
// escape: readFileConfig() swallows every read and parse error and returns {},
// so an unreadable or malformed temp config resolves to DEFAULT_CONFIG — port
// 3050 and ~/.ours, i.e. the LIVE daemon's endpoint and state directory. The
// child would then create and release ~/.ours/daemon.lock and probe the live port.
//
// Two independent defences, because either alone can be defeated:
//   GUARD   — refuse to spawn unless the file demonstrably supplies a non-default
//             port AND a temp state dir. It fails closed: anything it cannot
//             positively verify is a refusal, and a refusal aborts before spawn.
//   SANDBOX — give the child a temp HOME. os.homedir() reads $HOME, and both
//             DEFAULT_CONFIG.stateDir and configPath() derive from it, so even a
//             fallback that somehow happened lands inside tmpdir.
const DEFAULT_PORT = 3050;

// Resolve what the child will actually read out of the file, mirroring
// readFileConfig()'s accepted shapes. null means "cannot be trusted" — which is
// exactly the condition under which the daemon would fall back.
function resolveConfigFile(cfgPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const port = typeof parsed.port === 'number' && Number.isFinite(parsed.port) ? parsed.port : null;
  const stateDir = typeof parsed.stateDir === 'string' ? resolve(parsed.stateDir) : null;
  return port === null || stateDir === null ? null : { port, stateDir };
}

function configOnlyGuard(cfgPath) {
  const r = resolveConfigFile(cfgPath);
  if (!r) return { ok: false, reason: 'config unreadable or missing port/stateDir — the daemon would fall back to DEFAULT_CONFIG' };
  if (r.port === DEFAULT_PORT) return { ok: false, reason: `config resolves to the default port ${DEFAULT_PORT}` };
  if (r.stateDir === HOME_STATE) return { ok: false, reason: `config resolves to the live state dir ${HOME_STATE}` };
  if (!r.stateDir.startsWith(resolve(tmpdir()))) return { ok: false, reason: `config state dir ${r.stateDir} is not under ${tmpdir()}` };
  return { ok: true, port: r.port, stateDir: r.stateDir };
}

// ─── regression: the config-only fallback cannot escape ──────────────────────
// Pure and local — spawns nothing, binds nothing, touches no port.
{
  const probe = tempState('guard');
  const sandbox = tempState('guard-home');
  const cfg = join(probe, 'cfg.json');

  for (const [label, body] of [
    ['malformed JSON', '{ not json'],
    ['empty file', ''],
    ['JSON that is not an object', '"a string"'],
    ['valid JSON without port or stateDir', JSON.stringify({ brokerUrl: BROKER })],
    ['port present, stateDir missing', JSON.stringify({ port: 3999 })],
    ['stateDir present, port missing', JSON.stringify({ stateDir: probe })],
    ['the default port 3050', JSON.stringify({ port: DEFAULT_PORT, stateDir: probe })],
    ['the live state dir', JSON.stringify({ port: 3999, stateDir: HOME_STATE })],
    ['a state dir outside tmpdir', JSON.stringify({ port: 3999, stateDir: '/var/lib/not-mktemp' })],
  ]) {
    writeFileSync(cfg, body);
    ok(!configOnlyGuard(cfg).ok, `guard refuses a config-only spawn: ${label}`);
  }
  ok(!configOnlyGuard(join(probe, 'absent.json')).ok, 'guard refuses a config-only spawn: file does not exist');
  writeFileSync(cfg, JSON.stringify({ port: 3999, stateDir: probe }));
  ok(configOnlyGuard(cfg).ok, 'guard admits a config that supplies a non-default port and a temp state dir');

  // The SANDBOX defence, proven against the REAL shipped resolver.
  //
  // It must be proven in a FRESH PROCESS, and that is not a testing convenience —
  // it is the mechanism. config.ts computes DEFAULT_CONFIG.stateDir as
  // resolve(homedir(), '.ours') at MODULE LOAD, so $HOME is read exactly once,
  // when the process starts. Setting process.env.HOME inside an already-running
  // process therefore changes nothing. A spawned child reads the sandbox HOME
  // before it loads config.js, which is precisely the case being defended.
  //
  // Resolution only: this child imports the resolver and prints. It binds no
  // port, starts no daemon, and never contacts 3050.
  writeFileSync(cfg, '{ not json');
  const configUrl = CONFIG_URL;
  const probeEnv = childEnv({ OURS_CONFIG: cfg, HOME: sandbox });
  delete probeEnv.OURS_PORT;
  delete probeEnv.OURS_STATE_DIR;
  const printed = spawnSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(configUrl)}).then((m) => { const c = m.loadConfig(); process.stdout.write(JSON.stringify({ stateDir: c.stateDir, port: c.port })); });`],
    { env: probeEnv, encoding: 'utf8', timeout: 30_000 },
  );
  let fell = null;
  try { fell = JSON.parse(printed.stdout); } catch { /* reported below */ }
  ok(fell !== null, `the resolver probe returned JSON (stderr: ${printed.stderr?.trim().slice(0, 200) || 'none'})`);
  if (fell) {
    ok(resolve(fell.stateDir).startsWith(resolve(sandbox)), 'HOME sandbox: a malformed config falls back INSIDE the sandbox');
    ok(resolve(fell.stateDir) !== HOME_STATE, 'HOME sandbox: the fallback is never the live state dir');
    ok(fell.port === DEFAULT_PORT, 'the fallback port really is 3050 — which is why the GUARD, not the sandbox, is what must stop it');
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
  if (!upA || !upB) {
    // The compiled-packet preflight above already ruled out the usual cause, so
    // say what is left rather than repeating the symptom: children run with
    // stdio:'ignore', so their own diagnostics are not on this stream.
    throw new Error(
      `both daemons must be up for the rest of the suite (A=${upA}, B=${upB}) — ` +
        'the .muflo preflight passed, so re-run one by hand with stdio inherited to see why it did not boot: ' +
        `OURS_TRANSPORT=http OURS_BROKER_URL=${BROKER} OURS_PORT=<free> OURS_STATE_DIR=<tmp> node ${CLI} serve`,
    );
  }

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
    // This is the ONLY child in this file with no OURS_PORT and no
    // OURS_STATE_DIR, so it is gated twice before it is allowed to exist.
    const sandboxHome = tempState('prec-home');
    const guard = configOnlyGuard(cfgPath);
    ok(guard.ok, `config-only spawn admitted by the guard${guard.ok ? '' : ` — ${guard.reason}`}`);
    if (!guard.ok) throw new Error(`refusing to spawn a config-only daemon: ${guard.reason}`);
    ok(
      guard.port === filePort && guard.stateDir === resolve(fileState),
      'the guard resolved exactly the port and state dir the child will use',
    );
    const viaFile = spawn(process.execPath, [CLI, 'serve'], {
      env: (() => {
        const e = childEnv({ OURS_CONFIG: cfgPath });
        delete e.OURS_PORT;
        delete e.OURS_STATE_DIR;
        // Backstop: if resolution ever fell back despite the guard, ~/.ours
        // resolves inside tmpdir rather than to the live state directory.
        e.HOME = sandboxHome;
        return e;
      })(),
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

  // ─── E2E: two REAL daemons race one stale-locked state dir, 10 rounds ──────
  // The unit-level race harness (test/lock-race.test.mjs) drives acquireStateLock
  // directly. This drives the actual product: two `ours-mcp serve` processes,
  // different ports, SAME state directory, with a stale lock pre-seeded so both
  // take the reclaim path. Dual-live must be zero — not rare, zero.
  {
    const corpse = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    let dualLive = 0;
    let rounds = 0;
    const exitCodes = [];

    for (let round = 0; round < 10; round++) {
      const dir = tempState(`e2e-${round}`);
      writeFileSync(
        join(dir, 'daemon.lock'),
        JSON.stringify({
          pid: corpse.pid, port: 3050, instance: 'ghost', stateDir: dir,
          stateFingerprint: 'x', version: '0', startedAt: 'then',
        }),
      );
      const p1 = await freePort();
      const p2 = await freePort();
      const spawnRacer = (port) => {
        const child = spawn(process.execPath, [CLI, 'serve'], {
          env: childEnv({ OURS_PORT: String(port), OURS_STATE_DIR: dir }),
          stdio: 'ignore', detached: true,
        });
        running.push(child);
        child.on('exit', (code) => { child.exitCode_ = code; });
        return child;
      };
      const c1 = spawnRacer(p1);
      const c2 = spawnRacer(p2);

      // Settle: wait until one has exited (the refusal is immediate — it happens
      // at lock acquisition, before any ADAPT boot) or the budget runs out.
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && c1.exitCode_ === undefined && c2.exitCode_ === undefined) {
        await sleep(200);
      }
      // Give the winner a moment to finish binding before asking who is serving.
      const winnerPort = c1.exitCode_ === undefined ? p1 : p2;
      await waitVersion(winnerPort, 40_000);

      const live = (await Promise.all([p1, p2].map(async (p) => {
        try { return (await fetch(`http://127.0.0.1:${p}/info`)).ok; } catch { return false; }
      }))).filter(Boolean).length;
      if (live > 1) dualLive++;
      rounds++;
      const loserCode = c1.exitCode_ ?? c2.exitCode_;
      if (loserCode !== undefined && loserCode !== null) exitCodes.push(loserCode);

      kill(c1);
      kill(c2);
      await sleep(200);
    }

    ok(rounds === 10, `the stale-seeded E2E completed all 10 rounds (got ${rounds})`);
    ok(dualLive === 0, `zero rounds had BOTH daemons live on one state dir (got ${dualLive}/10)`);
    ok(
      exitCodes.length > 0 && exitCodes.every((c) => c === 4),
      `every refused daemon exited 4 (state collision) — got [${exitCodes.join(', ')}]`,
    );
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
