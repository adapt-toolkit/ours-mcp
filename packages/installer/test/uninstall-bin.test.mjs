// ours-uninstall v3 — the REAL bin, end to end.
//
// lib/uninstall.mjs proves the decisions and lib/orchestrate-uninstall.mjs is
// tested against a fake. This file exists because neither of those could catch
// the thing that was actually wrong: the bin was still the v2 body, so none of
// it ran. It drives `node uninstall.mjs` with fakes on PATH.
//
// HOST RULES, unchanged from the installer suite: no service is removed, no
// systemctl is reached, no real daemon is contacted, and every state directory
// here is under a temp HOME that the test deletes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const UNINSTALL_MJS = join(PKG, 'uninstall.mjs');

function host({ stateDirs = ['.ours'], purgeMarkers = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'uninstall-v3-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(tmp, 'calls.log');
  writeFileSync(log, '');
  for (const name of ['ours', 'npm', 'ours-tg-connector', 'ours-cowork']) {
    writeFileSync(join(bin, name), `#!/bin/bash\nprintf '%s %s\\n' "${name}" "$*" >> "$CALLLOG"\nexit 0\n`);
    chmodSync(join(bin, name), 0o755);
  }
  for (const name of stateDirs) {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    if (purgeMarkers) writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ port: 3050, stateDir: dir })}\n`, { mode: 0o600 });
  }
  return {
    tmp,
    log,
    dir: (name = '.ours') => join(tmp, name),
    calls: () => readFileSync(log, 'utf8'),
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      CALLLOG: log,
      HOME: tmp,
      SHELL: '/bin/bash',
      OURS_ASSUME_YES: '1',
      NO_COLOR: '1',
    },
  };
}

function runBin(args, env) {
  return new Promise((resolve) => {
    const child = spawn('node', [UNINSTALL_MJS, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out, code: code ?? 1 }));
  });
}

test('the bin runs the v3 flow: unit, daemon, packages — and never systemctl', async () => {
  const h = host();
  const { out, code } = await runBin(['--state-dir', h.dir()], h.env);
  assert.equal(code, 0);
  const calls = h.calls();
  assert.match(calls, /ours daemon uninstall-service --yes --state-dir /, 'the unit is removed BY THE CLI, which owns the marker check');
  assert.doesNotMatch(calls, /systemctl/);
  assert.doesNotMatch(calls, /loginctl/);
  assert.doesNotMatch(calls, /ours-mcp .*uninstall-service/, 'ours-mcp has no unit under v3, so none is looked for');
  assert.match(calls, /npm rm -g @ours\.network\/cli/, 'the last daemon takes the global packages with it');
  assert.match(out, /state .* kept/, 'state is kept by default');
  rmSync(h.tmp, { recursive: true, force: true });
});

test('a SECOND daemon still on the machine keeps the global packages', async () => {
  // The thing a v2 uninstall could not know, because v2 had no concept of a
  // second daemon: removing @ours.network/cli here would break the other one.
  const h = host({ stateDirs: ['.ours', '.ours-tg'] });
  const { out, code } = await runBin(['--state-dir', h.dir('.ours')], h.env);
  assert.equal(code, 0);
  assert.doesNotMatch(h.calls(), /npm rm -g/, 'nothing global is removed while another daemon needs it');
  assert.match(out, /@ours\.network\/cli kept/);
  assert.match(out, /\.ours-tg/, 'and it names the daemon that still needs it');
  rmSync(h.tmp, { recursive: true, force: true });
});

test('a component still pointing here stops the run before anything is removed', async () => {
  const h = host();
  const tg = join(h.tmp, '.ours-telegram');
  mkdirSync(tg, { recursive: true });
  writeFileSync(join(tg, 'config.json'), `${JSON.stringify({ daemonStateDir: h.dir(), botToken: 'secret' })}\n`, { mode: 0o600 });
  const { out, code } = await runBin(['--state-dir', h.dir()], h.env);
  assert.equal(code, 2, 'refused');
  assert.equal(h.calls(), '', 'and NOTHING was removed — not half-dismantled');
  assert.match(out, /still point at this daemon/);
  assert.doesNotMatch(out, /secret/, 'the connector token never reaches the screen');
  rmSync(h.tmp, { recursive: true, force: true });
});

test('--purge is refused non-interactively, and the state directory survives', async () => {
  // Two of the four gates at once: --purge given, but the run is unattended.
  const h = host();
  const { out, code } = await runBin(['--state-dir', h.dir(), '--purge'], h.env);
  assert.equal(code, 0);
  assert.equal(existsSync(h.dir()), true, 'identity keys are not deleted by an unattended run');
  assert.equal(existsSync(join(h.dir(), 'config.json')), true);
  assert.match(out, /never deleted non-interactively/);
  rmSync(h.tmp, { recursive: true, force: true });
});

test('--purge refuses a directory with no ours state markers at all', async () => {
  // The gate that stands between `ours-uninstall --state-dir ~ --purge` and a
  // deleted home directory, now that provenance is gone by the owner's ruling.
  const h = host({ stateDirs: ['.not-ours'], purgeMarkers: false });
  const victim = h.dir('.not-ours');
  writeFileSync(join(victim, 'important.txt'), 'mine\n');
  const { out, code } = await runBin(['--state-dir', victim, '--purge'], { ...h.env, OURS_ASSUME_YES: '1' });
  assert.equal(code, 0);
  assert.equal(existsSync(join(victim, 'important.txt')), true, 'somebody else\'s directory is not deleted');
  assert.match(out, /state .* kept/);
  rmSync(h.tmp, { recursive: true, force: true });
});

test('--dry-run removes nothing and says what it would have removed', async () => {
  const h = host();
  const { out, code } = await runBin(['--state-dir', h.dir(), '--dry-run'], h.env);
  assert.equal(code, 0);
  assert.equal(h.calls(), '', 'not one subprocess');
  assert.equal(existsSync(join(h.dir(), 'config.json')), true);
  assert.match(out, /\[dry-run\] would: ours daemon uninstall-service/);
  assert.match(out, /\[dry-run\] would: npm rm -g @ours\.network\/cli/);
  rmSync(h.tmp, { recursive: true, force: true });
});

test('--help and --version are answered without touching anything', async () => {
  const h = host();
  const help = await runBin(['--help'], h.env);
  assert.equal(help.code, 0);
  assert.match(help.out, /--purge/);
  assert.match(help.out, /--state-dir/);
  const version = await runBin(['--version'], h.env);
  assert.equal(version.code, 0);
  assert.match(version.out, /^ours-uninstall v\d+\.\d+\.\d+/m);
  assert.equal(h.calls(), '');
  rmSync(h.tmp, { recursive: true, force: true });
});

test('an unknown flag exits 2 and removes nothing', async () => {
  const h = host();
  const { out, code } = await runBin(['--nope'], h.env);
  assert.equal(code, 2);
  assert.match(out, /unknown option: --nope/);
  assert.equal(h.calls(), '');
  rmSync(h.tmp, { recursive: true, force: true });
});

test('uninstall.mjs is a BIN and nothing else', async () => {
  const src = readFileSync(UNINSTALL_MJS, 'utf8');
  assert.ok(src.split('\n').length < 120);
  assert.match(src, /runUninstall/);
  assert.match(src, /realEffects/);
  for (const ghost of ['rmSync', 'stripBlock', 'spawnSync', 'canonHarnesses', 'OURS_UNINSTALL_DATA']) {
    assert.ok(!src.includes(ghost), `the v2 body must be gone, found: ${ghost}`);
  }
});

test('uninstall.sh ships every module the v3 bin imports', async () => {
  // The piped path fetches a FIXED list of files. A module missing from it is an
  // uninstaller that crashes on its first import, for the user least able to
  // recover — the one who no longer has the package installed.
  const sh = readFileSync(join(PKG, 'uninstall.sh'), 'utf8');
  const needed = ['lib/effects.mjs', 'lib/orchestrate-uninstall.mjs', 'lib/uninstall.mjs',
    'lib/target.mjs', 'lib/plan.mjs', 'lib/components.mjs', 'lib/config.mjs',
    'lib/ui.mjs', 'lib/prompt.mjs', 'lib/logic.mjs', 'lib/usage.mjs'];
  for (const f of needed) assert.ok(sh.includes(f), `uninstall.sh must fetch ${f}`);
  assert.match(sh, /node "\$MJS" "\$@"/, 'and it must pass --state-dir/--purge through');
});

// ------------------------------- the harness plugins the installer wrote -----

const YAML_START = '# >>> ours.network plugin (managed block)';
const YAML_END = '# <<< ours.network plugin';
const MD_START = '<!-- >>> ours.network plugin (managed block) -->';
const MD_END = '<!-- <<< ours.network plugin -->';

/** A temp home carrying exactly what the plugin installers write. */
function withPlugins(h, { unterminated = false } = {}) {
  const hermes = join(h.tmp, '.hermes');
  const codex = join(h.tmp, '.codex');
  const skills = join(h.tmp, '.agents', 'skills');
  mkdirSync(join(hermes, 'skills', 'communication', 'ours'), { recursive: true });
  mkdirSync(join(hermes, 'skills', 'communication', 'writing-agent-bios'), { recursive: true });
  mkdirSync(join(skills, 'ours'), { recursive: true });
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(hermes, 'skills', 'communication', 'ours', 'SKILL.md'), 'ours\n');
  writeFileSync(join(hermes, 'ours-connector.env'), 'OURS_PORT=3050\n');
  writeFileSync(join(hermes, 'config.yaml'),
    `mine: keep\n${YAML_START}\nmcpServers:\n  ours: {}\n${unterminated ? '' : `${YAML_END}\n`}also-mine: keep\n`);
  writeFileSync(join(codex, 'config.toml'), `mine = "keep"\n${YAML_START}\nours = 1\n${YAML_END}\nalso = "keep"\n`);
  writeFileSync(join(codex, 'AGENTS.md'), `# mine\n${MD_START}\nours\n${MD_END}\n# also mine\n`);
  return { hermes, codex, skills };
}

test('the last daemon takes the harness plugins with it — blocks, skills and launchers', async () => {
  const h = host();
  const p = withPlugins(h);
  const { out, code } = await runBin(['--state-dir', h.dir()], h.env);
  assert.equal(code, 0);

  // Only OUR span is gone; everything the user wrote around it survives.
  const hermesConfig = readFileSync(join(p.hermes, 'config.yaml'), 'utf8');
  assert.equal(hermesConfig, 'mine: keep\nalso-mine: keep\n');
  assert.equal(readFileSync(join(p.codex, 'config.toml'), 'utf8'), 'mine = "keep"\nalso = "keep"\n');
  assert.equal(readFileSync(join(p.codex, 'AGENTS.md'), 'utf8'), '# mine\n# also mine\n');

  assert.equal(existsSync(join(p.hermes, 'skills', 'communication', 'ours')), false);
  assert.equal(existsSync(join(p.skills, 'ours')), false);
  assert.equal(existsSync(join(p.hermes, 'ours-connector.env')), false);
  // The directories the plugins live IN are not ours and stay.
  assert.equal(existsSync(p.hermes), true);
  assert.equal(existsSync(p.codex), true);

  assert.match(h.calls(), /npm rm -g @ours\.network\/hermes/);
  assert.match(h.calls(), /npm rm -g @ours\.network\/codex/);
  assert.match(out, /\/plugin uninstall ours/, "Claude Code's own removal is printed, never faked");
  rmSync(h.tmp, { recursive: true, force: true });
});

test('an UNTERMINATED ours block is reported and the file is left exactly as it was', async () => {
  const h = host();
  const p = withPlugins(h, { unterminated: true });
  const before = readFileSync(join(p.hermes, 'config.yaml'), 'utf8');
  const { out, code } = await runBin(['--state-dir', h.dir()], h.env);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(p.hermes, 'config.yaml'), 'utf8'), before,
    'a block we cannot bound is never truncated to end-of-file');
  assert.match(out, /no closing marker/);
  assert.match(out, /Remove it by hand/);
  rmSync(h.tmp, { recursive: true, force: true });
});

test('a config with no ours block is never edited', async () => {
  const h = host();
  const hermes = join(h.tmp, '.hermes');
  mkdirSync(hermes, { recursive: true });
  const theirs = 'entirely their own config\n';
  writeFileSync(join(hermes, 'config.yaml'), theirs);
  const { out, code } = await runBin(['--state-dir', h.dir()], h.env);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(hermes, 'config.yaml'), 'utf8'), theirs);
  assert.match(out, /carries no ours block — left untouched/);
  rmSync(h.tmp, { recursive: true, force: true });
});

test('a SECOND daemon keeps the harness plugins as well as the packages', async () => {
  // One condition, not two: while another daemon is here, its harnesses still
  // need these plugins, so nothing of theirs is touched either.
  const h = host({ stateDirs: ['.ours', '.ours-tg'] });
  const p = withPlugins(h);
  const before = readFileSync(join(p.hermes, 'config.yaml'), 'utf8');
  const { out, code } = await runBin(['--state-dir', h.dir('.ours')], h.env);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(p.hermes, 'config.yaml'), 'utf8'), before);
  assert.equal(existsSync(join(p.skills, 'ours')), true);
  assert.doesNotMatch(h.calls(), /npm rm -g/);
  assert.match(out, /harness plugins kept/);
  rmSync(h.tmp, { recursive: true, force: true });
});

test('--dry-run touches no plugin file either', async () => {
  const h = host();
  const p = withPlugins(h);
  const before = readFileSync(join(p.codex, 'AGENTS.md'), 'utf8');
  const { out, code } = await runBin(['--state-dir', h.dir(), '--dry-run'], h.env);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(p.codex, 'AGENTS.md'), 'utf8'), before);
  assert.equal(existsSync(join(p.skills, 'ours')), true);
  assert.equal(h.calls(), '');
  assert.match(out, /\[dry-run\] would: remove the ours managed block from/);
  rmSync(h.tmp, { recursive: true, force: true });
});
