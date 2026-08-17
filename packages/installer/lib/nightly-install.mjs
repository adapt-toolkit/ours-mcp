// ─────────────────────────────────────────────────────────────────────────────
// NO LONGER REACHED BY ANY CODE PATH, DELIBERATELY AND TEMPORARILY.
//
// The nightly channel now runs the v3 installer end to end (owner ruling
// 2026-08-17: v3 SUBSUMES the nightly flow), so the two dispatch sites that led
// here — install.mjs and uninstall.mjs — were removed. This file is retained on
// purpose rather than deleted in the same commit.
//
// WHY IT IS STILL HERE. The behaviour inventory
// (/home/fleet/work/dev1-installer-notes/NIGHTLY-BEHAVIOUR-INVENTORY.md) lists
// what this flow does that v3 does not, and that list is not finished being
// carried across. Deleting the implementation and its tests before the one-for-one
// replacement exists is how a test that was covering something real gets removed
// alongside the ones that were not. Its tests still run and still pass, because
// they exercise this module directly.
//
// The retirement — removing this file and retiring each of its tests against a
// named v3 equivalent — is its own piece of work. Until then this is ORPHANED AND
// SAID SO, which is the opposite of the failure the staging existed to prevent:
// seven commits of feature reachable by no code path, with git reporting no
// conflict and nothing saying it had happened.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { heading, ok, info, warn, c } from './ui.mjs';
import {
  DEFAULT_BROKER, DEFAULT_PORT, COWORK_DEFAULT_PORT, COWORK_EXTERNAL_MIN_VERSION,
  coworkSupportsExternalDaemon, daemonEndpoint, mergeConfig,
  planCoworkConfig, planTgDaemonConfig, pkgSpec, tgConfigPath, coworkConfigPath,
  validateBroker, validateDaemonPort,
} from './logic.mjs';
import {
  associateHarness, defaultHistoricalProfile, discoverProfileCandidates, emptyRegistry,
  normalizeLoopbackHost, normalizeProfile, normalizeProfileId, profilesPath, readRegistry,
  probeProfileCandidate, reverseApplicationIndex, upsertProfile, writeRegistry,
} from './profiles.mjs';
import { atomicWriteConfig, restoreConfig, snapshotConfig } from './config.mjs';

const line = (text = '') => process.stdout.write(`${text}\n`);
const say = (text) => line(`ours: ${text}`);
const readObject = (path, { missing = {} } = {}) => {
  if (!existsSync(path)) return missing;
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`${path} is corrupt JSON: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must contain a JSON object`);
  return value;
};

const canonicalPath = (path) => {
  try { return realpathSync(path); } catch { return resolve(path); }
};

// Mirror core's runtime-config-values + loadConfig contract for endpoint fields.
// The standalone installer cannot import the daemon package, so every installer
// discovery/validation path shares this one equivalent resolver: service env
// uses core's envInt/nullish precedence, file values keep only finite numbers
// and strings, and the historical defaults never depend on a service name.
function resolveRuntimeEndpoint(config, home, env = {}) {
  let environmentPort;
  if (env.OURS_PORT !== undefined) {
    const parsed = parseInt(env.OURS_PORT, 10);
    if (!Number.isNaN(parsed)) environmentPort = parsed;
  }
  const filePort = typeof config.port === 'number' && Number.isFinite(config.port)
    ? config.port
    : undefined;
  const stateValue = env.OURS_STATE_DIR !== undefined
    ? env.OURS_STATE_DIR
    : typeof config.stateDir === 'string'
      ? config.stateDir
      : join(home, '.ours');
  return {
    port: environmentPort ?? filePort ?? DEFAULT_PORT,
    stateDir: resolve(stateValue),
  };
}

// Keep this check aligned with the runtime association resolvers: a profile-selected
// client reads this exact config with the historical 3050 / ~/.ours defaults. A manual
// profile that merely reaches the requested daemon is still unusable when its client
// config resolves another port or state directory, so reject it before any mutation.
function assertClientConfigMatchesProfile(profile, config, home) {
  const configured = resolveRuntimeEndpoint(config, home);
  if (configured.port !== profile.port) {
    throw new Error(`client config resolves port ${configured.port}, not selected port ${profile.port}`);
  }
  if (canonicalPath(configured.stateDir) !== canonicalPath(profile.stateDir)) {
    throw new Error('client config resolves a different state directory than the selected daemon');
  }
}

function candidateFromConfig(id, label, configPath, home, { serviceName = '', ownership } = {}) {
  if (!existsSync(configPath)) return null;
  const config = readObject(configPath);
  const { stateDir, port } = resolveRuntimeEndpoint(config, home);
  return {
    id, label, host: '127.0.0.1', port, configPath: resolve(configPath), stateDir,
    serviceName: typeof config.serviceName === 'string' ? config.serviceName : serviceName,
    ownership: ownership || { config: false, service: false, state: false },
  };
}

function persistedProfile(candidate) {
  return {
    label: candidate.label,
    host: candidate.host,
    port: candidate.port,
    configPath: candidate.configPath,
    stateDir: candidate.stateDir,
    serviceName: candidate.serviceName,
    ownership: candidate.ownership,
  };
}

function candidateFromExternalConfig(id, label, daemon, home) {
  if (!daemon || typeof daemon !== 'object') return null;
  const endpoint = daemon.endpoint || daemon.daemonUrl;
  const stateDir = daemon.stateDir || daemon.daemonStateDir;
  if (typeof endpoint !== 'string' || typeof stateDir !== 'string') return null;
  let url;
  try { url = new URL(endpoint); } catch { throw new Error(`${label} names an invalid daemon endpoint`); }
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} daemon endpoint must be a credential-free loopback HTTP endpoint`);
  }
  const host = normalizeLoopbackHost(url.hostname);
  const port = Number(url.port || 80);
  const configPath = join(resolve(stateDir), 'config.json');
  return {
    id, label, host, port, configPath, stateDir: resolve(stateDir), serviceName: id,
    ownership: { config: false, service: false, state: false },
  };
}

function parseServiceFile(path, id, home) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const env = {};
  for (const key of ['OURS_CONFIG', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_SERVICE_NAME']) {
    if (path.endsWith('.plist')) {
      const marker = `<key>${key}</key>`;
      if (!text.includes(marker)) continue;
      const match = text.match(new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]*)<\\/string>`));
      if (!match) throw new Error(`${path} has malformed XML text for ${key}`);
      const undecoded = match[1];
      if (undecoded.replace(/&(?:amp|lt|gt|quot|apos);/g, '').includes('&')) {
        throw new Error(`${path} has malformed XML entity in ${key}`);
      }
      env[key] = undecoded.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
      })[entity]);
      continue;
    }
    const match = text.match(new RegExp(`(?:Environment=|<key>)${key}(?:=|<\\/key>\\s*<string>)([^\\n<]*)`));
    if (match) env[key] = match[1].replace(/^['"]|['"]$/g, '').trim();
  }
  const serviceName = env.OURS_SERVICE_NAME || (id === 'default' ? '' : id);
  const configPath = resolve(env.OURS_CONFIG || join(home, '.ours', 'config.json'));
  const configured = existsSync(configPath) ? readObject(configPath) : {};
  const { stateDir, port } = resolveRuntimeEndpoint(configured, home, env);
  return {
    id, label: id === 'default' ? 'Default ours service' : `ours service ${id}`,
    host: '127.0.0.1', port, configPath, stateDir, serviceName,
    ownership: { config: false, service: false, state: false }, origin: 'known-service',
  };
}

// The instance-name rule, byte-for-byte core's INSTANCE_RE (packages/core/src/
// service-instance.ts): 1–32 characters, starting AND ENDING with a letter or
// digit. Discovery used a looser pattern that also accepted a trailing hyphen or
// underscore, which meant it recognised unit filenames core itself refuses to
// produce and profiles.mjs then refuses to normalize — see the guard below.
const SERVICE_INSTANCE_FILE = {
  systemd: /^ours-([A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9])?)\.service$/,
  launchd: /^solutions\.adaptframework\.ours\.([A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9])?)\.plist$/,
};

function knownServiceCandidates(home) {
  const candidates = [];
  const dirs = [
    join(home, '.config', 'systemd', 'user'),
    join(home, 'Library', 'LaunchAgents'),
  ];
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).sort(); } catch { continue; }
    for (const file of files) {
      let id = null;
      if (file === 'ours.service' || file === 'solutions.adaptframework.ours.plist') id = 'default';
      else id = SERVICE_INSTANCE_FILE.systemd.exec(file)?.[1] ?? SERVICE_INSTANCE_FILE.launchd.exec(file)?.[1] ?? null;
      if (!id) continue;
      // A file whose name matches is CLAIMED, and any fault reading its contents
      // stays FATAL on purpose. That is not the same question as the one above:
      // once a definition is ours, a malformed entity or corrupt config could
      // otherwise be treated as literal path bytes and point discovery at the
      // wrong state directory, so it must fail closed before anything is probed
      // or mutated (see the launchd malformed-entity test). What the pattern
      // above fixes is the file that was never ours to claim.
      const candidate = parseServiceFile(join(dir, file), id, home);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function discoveryInputs(registry, home, env) {
  const defaultPath = join(home, '.ours', 'config.json');
  const defaultCandidate = candidateFromConfig('default', 'Default ours daemon', defaultPath, home);
  const legacyCandidates = [];
  for (const [id, dir] of [['tg', '.ours-tg'], ['rooms', '.ours-rooms']]) {
    const candidate = candidateFromConfig(id, `Legacy ${id} daemon`, join(home, dir, 'config.json'), home, { serviceName: id });
    if (candidate) legacyCandidates.push(candidate);
  }
  const connectorCandidates = [];
  const tg = readObject(tgConfigPath(env, home));
  const tgCandidate = candidateFromExternalConfig('tg-config', 'Telegram configured daemon', tg, home);
  if (tgCandidate) connectorCandidates.push(tgCandidate);
  const rooms = readObject(coworkConfigPath(env, home));
  const roomsCandidate = candidateFromExternalConfig('rooms-config', 'Rooms configured daemon', rooms.daemon, home);
  if (roomsCandidate) connectorCandidates.push(roomsCandidate);
  return {
    registry, defaultCandidate, legacyCandidates, connectorCandidates,
    serviceCandidates: knownServiceCandidates(home),
  };
}

function exactEnv(profile) {
  const env = {
    OURS_CONFIG: profile.configPath,
    OURS_PORT: String(profile.port),
    OURS_STATE_DIR: profile.stateDir,
    OURS_AUTOSTART: '0',
  };
  if (profile.serviceName) env.OURS_SERVICE_NAME = profile.serviceName;
  return env;
}

function serviceDefinitionPath(profile, home, platform = process.platform) {
  if (platform === 'linux') {
    const unit = profile.serviceName ? `ours-${profile.serviceName}.service` : 'ours.service';
    return join(home, '.config', 'systemd', 'user', unit);
  }
  if (platform === 'darwin') {
    const label = profile.serviceName
      ? `solutions.adaptframework.ours.${profile.serviceName}.plist`
      : 'solutions.adaptframework.ours.plist';
    return join(home, 'Library', 'LaunchAgents', label);
  }
  return '';
}

function ownerToken(profile, config, env) {
  if (env.OURS_API_TOKEN?.trim()) return env.OURS_API_TOKEN.trim();
  if (typeof config.apiToken === 'string' && config.apiToken.trim()) return config.apiToken.trim();
  try { return readFileSync(join(profile.stateDir, 'daemon-token'), 'utf8').trim(); } catch { return ''; }
}

async function verifyProtected(profile, { fetch: fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const config = readObject(profile.configPath);
  const base = `http://127.0.0.1:${profile.port}`;
  const request = async (path, headers) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try { return await fetchImpl(`${base}${path}`, { headers, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  };
  let infoResponse;
  try { infoResponse = await request('/info'); }
  catch (error) { throw new Error(`daemon ${base} is unreachable: ${error.message}`); }
  if (!infoResponse.ok) throw new Error(`daemon ${base} /info returned HTTP ${infoResponse.status}`);
  const daemonInfo = await infoResponse.json();
  if (daemonInfo?.name !== 'ours' || resolve(String(daemonInfo.stateDir || '')) !== resolve(profile.stateDir)) {
    throw new Error(`daemon ${base} does not report the selected state directory ${profile.stateDir}`);
  }
  const versionResponse = await request('/version');
  if (!versionResponse.ok) throw new Error(`daemon ${base} /version returned HTTP ${versionResponse.status}`);
  let runningVersion = '';
  try { runningVersion = String((await versionResponse.json())?.version || ''); }
  catch { throw new Error(`daemon ${base} /version returned invalid JSON`); }
  if (!runningVersion) throw new Error(`daemon ${base} /version did not report a version`);
  const token = ownerToken(profile, config, env);
  const auth = await request('/identities', token ? { 'x-ours-api-token': token } : undefined);
  if (auth.status === 401 || auth.status === 403) throw new Error(`daemon ${base} rejected the selected authentication`);
  if (!auth.ok) throw new Error(`daemon ${base} protected API returned HTTP ${auth.status}`);
  return daemonInfo;
}

function readChoice(ask, prompt, def) {
  return String(ask(prompt, def) ?? def).trim();
}

function newProfileSurvey({ ask, home, claimed, defaults = {} }) {
  const id = normalizeProfileId(readChoice(ask, '  Profile id: ', defaults.id || 'default'));
  const label = readChoice(ask, '  Profile label: ', defaults.label || (id === 'default' ? 'Default ours daemon' : `ours daemon ${id}`));
  const host = normalizeLoopbackHost(readChoice(ask, '  Host (localhost only): ', defaults.host || '127.0.0.1'));
  const rawPort = readChoice(ask, '  Port: ', String(defaults.port || DEFAULT_PORT));
  const checked = validateDaemonPort(rawPort, { fallback: DEFAULT_PORT, taken: claimed, isTaken: () => false });
  if (!checked.ok) throw new Error(checked.reason);
  const root = id === 'default' ? join(home, '.ours') : join(home, `.ours-${id}`);
  const stateDir = resolve(readChoice(ask, '  State directory: ', defaults.stateDir || root));
  const configPath = resolve(readChoice(ask, '  Config path: ', defaults.configPath || join(root, 'config.json')));
  const serviceName = readChoice(ask, '  Service instance name (empty only for default): ', defaults.serviceName ?? (id === 'default' ? '' : id));
  const brokerRaw = readChoice(ask, '  Broker URL: ', defaults.brokerUrl || DEFAULT_BROKER);
  const broker = validateBroker(brokerRaw);
  if (!broker.ok || broker.empty) throw new Error('broker must be a ws:// or wss:// URL');
  const profile = normalizeProfile(id, {
    label, host, port: checked.port, configPath, stateDir, serviceName,
    ownership: { config: true, service: true, state: true },
  });
  return { id, profile, brokerUrl: broker.value, kind: 'new' };
}

function manualProfileSurvey({ ask, home, claimed }) {
  const id = normalizeProfileId(readChoice(ask, '  Profile id: ', 'existing'));
  const label = readChoice(ask, '  Profile label: ', `Existing ours daemon ${id}`);
  const host = normalizeLoopbackHost(readChoice(ask, '  Host (localhost only): ', '127.0.0.1'));
  const rawPort = readChoice(ask, '  Port: ', String(DEFAULT_PORT));
  const checked = validateDaemonPort(rawPort, { fallback: DEFAULT_PORT, taken: claimed, isTaken: () => false });
  if (!checked.ok) throw new Error(checked.reason);
  const stateDir = resolve(readChoice(ask, '  Exact state directory: ', join(home, `.ours-${id}`)));
  const configPath = resolve(readChoice(ask, '  Existing/client config path: ', join(stateDir, 'config.json')));
  const serviceName = readChoice(ask, '  Service instance name: ', id === 'default' ? '' : id);
  const configExists = existsSync(configPath);
  const profile = normalizeProfile(id, {
    label, host, port: checked.port, configPath, stateDir, serviceName,
    ownership: { config: !configExists, service: false, state: false },
  });
  return { id, profile, kind: 'manual', clientConfigNeeded: !configExists };
}

function planAssociations(registry, selectedId, selectedApplications, yes) {
  let next = registry;
  const changed = [];
  for (const application of selectedApplications) {
    const previous = next.harnessAssociations[application];
    let allowReassign = false;
    if (previous && previous !== selectedId) {
      allowReassign = yes(`  ${application} currently uses profile ${previous}. Reassign it to ${selectedId}?`, false);
      if (!allowReassign) continue;
    }
    const result = associateHarness(next, application, selectedId, { allowReassign });
    next = result.registry;
    if (result.changed) changed.push({ application, previous });
  }
  return { registry: next, changed };
}

function renderProfiles(candidates, appIndex) {
  line(heading('Nightly daemon profiles'));
  if (!candidates.length) {
    line(info('No configured local ours daemons were discovered. The historical local default will be offered.'));
    return;
  }
  candidates.forEach((candidate, index) => {
    const apps = appIndex[candidate.id] || [];
    const reach = candidate.reachable
      ? `reachable${candidate.versionBefore ? `, running v${candidate.versionBefore}` : ''}`
      : 'configured/stopped';
    const owner = Object.entries(candidate.ownership).filter(([, value]) => value).map(([key]) => key).join(', ') || 'external';
    line(`  ${index + 1}) ${c.bold(candidate.label)} [${candidate.id}] — 127.0.0.1:${candidate.port} (${reach})`);
    line(`     state ${candidate.stateDir}`);
    line(`     config ${candidate.configPath} · service ${candidate.serviceName || '(default)'} · owns ${owner}`);
    line(`     applications ${apps.length ? apps.join(', ') : '(none)'}`);
  });
}

function selectedHarnessApplications(harnesses, registry, selectedId, yes, assumeYes) {
  const out = [];
  for (const harness of harnesses) {
    if (harness.status === 'absent') continue;
    const application = harness.name === 'claude' ? 'claude-code' : harness.name;
    const current = registry.harnessAssociations[application];
    const defaultAnswer = current ? current === selectedId : true;
    if (assumeYes ? (!current || current === selectedId) : yes(`  Use profile ${selectedId} for ${application}?`, defaultAnswer)) out.push(application);
  }
  return out;
}

async function installHarness(application, deps, profile) {
  const { run, runAsync, act, actSpin, npm } = deps;
  if (application === 'claude-code') {
    const add = await act('claude plugin marketplace add adapt-toolkit/ours-claude-marketplace', async () => run('claude', ['plugin', 'marketplace', 'add', 'adapt-toolkit/ours-claude-marketplace'], { capture: true }));
    return add.ok ? act('claude plugin install ours@ours.network', async () => run('claude', ['plugin', 'install', 'ours@ours.network'], { capture: true })) : add;
  }
  if (application === 'codex') {
    const add = await act('codex plugin marketplace add adapt-toolkit/ours-codex-marketplace', async () => run('codex', ['plugin', 'marketplace', 'add', 'adapt-toolkit/ours-codex-marketplace'], { capture: true }));
    const plugin = add.ok ? await act('codex plugin add ours@ours-codex-marketplace', async () => run('codex', ['plugin', 'add', 'ours@ours-codex-marketplace'], { capture: true })) : add;
    return plugin.ok ? actSpin('installing ours-codex nightly…', `npm i -g ${pkgSpec('codex', 'nightly')}`, () => runAsync(npm, ['i', '-g', pkgSpec('codex', 'nightly')])) : plugin;
  }
  const pkg = await actSpin('installing Hermes ours plugin nightly…', `npm i -g ${pkgSpec('hermes', 'nightly')}`, () => runAsync(npm, ['i', '-g', pkgSpec('hermes', 'nightly')]));
  return pkg.ok ? act(`ours-hermes-install --skip-daemon for profile ${profile.id}`, async () => run('ours-hermes-install', ['--skip-daemon'], { capture: true, env: exactEnv(profile) })) : pkg;
}

function rollbackSnapshots(snapshots) {
  for (const [path, snapshot, preserveOnFailure] of snapshots.reverse()) {
    if (preserveOnFailure) continue;
    try { restoreConfig(path, snapshot); } catch { /* report partial state at caller */ }
  }
}

export async function runNightlyInstaller(deps) {
  const { harnesses, ttyFd, interactive, yes, ask, dry, npm, run, runAsync, act, actSpin, finish } = deps;
  const home = process.env.HOME || homedir();
  const assumeYes = !!process.env.OURS_ASSUME_YES;
  const registryFile = profilesPath(process.env, home);
  let registry;
  try { registry = readRegistry(registryFile); }
  catch (error) {
    line(warn(`Nightly profile registry is unusable: ${error.message}`));
    line(info('No changes were made. Repair or move the corrupt registry, then re-run the Nightly installer.'));
    finish(ttyFd); return;
  }
  let tgExisting;
  let roomsExisting;
  try {
    tgExisting = readObject(tgConfigPath(process.env, home));
    roomsExisting = readObject(coworkConfigPath(process.env, home));
  } catch (error) {
    line(warn(error.message)); finish(ttyFd); return;
  }
  const appIndex = reverseApplicationIndex(registry, { telegramConfig: tgExisting, roomsConfig: roomsExisting });
  let candidates;
  try {
    candidates = await discoverProfileCandidates({
      ...discoveryInputs(registry, home, process.env),
      probe: deps.probe || (dry
        ? async (candidate) => ({ ...candidate, reachable: true, compatible: true, info: { name: 'ours', stateDir: candidate.stateDir } })
        : undefined),
    });
  } catch (error) {
    line(warn(`Nightly discovery stopped on a collision or unsafe candidate: ${error.message}`));
    line(info('No changes were made. Resolve the conflicting config/service definitions and re-run.'));
    finish(ttyFd); return;
  }
  // Discovery queried /version before any global npm change. Keep the running
  // value diagnostic-only: it is displayed for comparison and never persisted.
  for (const candidate of candidates) {
    candidate.versionBefore = candidate.reachable && candidate.compatible ? candidate.version : '';
  }
  renderProfiles(candidates, appIndex);

  const defaultIndex = Math.max(0, candidates.findIndex((candidate) => candidate.id === 'default'));
  let selection;
  try {
    if (assumeYes && !candidates.length) {
      selection = newProfileSurvey({ ask, home, claimed: [], defaults: { id: 'default' } });
    } else {
      const choice = readChoice(
        ask,
        `  Choose profile 1-${candidates.length || 0}, (m)anual existing, or (n)ew: `,
        candidates.length ? String(defaultIndex + 1) : 'n',
      ).toLowerCase();
      if (choice === 'm' || choice === 'manual') selection = manualProfileSurvey({ ask, home, claimed: candidates.map((c) => c.port) });
      else if (choice === 'n' || choice === 'new' || !candidates.length) selection = newProfileSurvey({ ask, home, claimed: candidates.map((c) => c.port) });
      else {
        const index = Number(choice) - 1;
        if (!Number.isInteger(index) || !candidates[index]) throw new Error('that profile selection does not exist');
        const candidate = candidates[index];
        if (candidate.reachable && !candidate.compatible) {
          throw new Error(`profile ${candidate.id} failed daemon validation: ${candidate.error || 'incompatible endpoint'}`);
        }
        const update = !assumeYes && readChoice(ask, '  Press Enter to use as-is, or type u to update/repair this profile: ', '') === 'u';
        selection = {
          id: candidate.id,
          profile: normalizeProfile(candidate.id, persistedProfile(candidate)),
          kind: update ? 'update' : 'existing',
          reachable: candidate.reachable,
        };
      }
    }
  } catch (error) {
    line(warn(`Cannot use that daemon profile: ${error.message}`)); finish(ttyFd); return;
  }

  if ((selection.kind === 'manual' || selection.kind === 'existing') && !selection.clientConfigNeeded) {
    try {
      assertClientConfigMatchesProfile(selection.profile, readObject(selection.profile.configPath), home);
    } catch (error) {
      line(warn(`Selected client config does not match the selected daemon: ${error.message}`));
      line(info('No package, service, harness, identity, or registry changes were made.'));
      finish(ttyFd); return;
    }
  }

  if (selection.kind === 'new' && !dry) {
    if (existsSync(selection.profile.configPath)) {
      line(warn(`New profile config path already exists: ${selection.profile.configPath}. It will not be overwritten.`));
      line(info('Choose the discovered/manual-existing flow, or choose a new config path. No changes were made.'));
      finish(ttyFd); return;
    }
    const stateExisted = existsSync(selection.profile.stateDir);
    if (stateExisted) {
      let entries = [];
      try { entries = readdirSync(selection.profile.stateDir); } catch { entries = ['unreadable']; }
      if (entries.length) {
        line(warn(`New profile state directory is not empty: ${selection.profile.stateDir}. It will not be reused.`));
        line(info('Choose manual existing for that state, or choose a new empty path. No changes were made.'));
        finish(ttyFd); return;
      }
    }
    // An explicitly accepted empty directory may be used, but it remains operator-owned.
    // Only a state directory absent at preflight can become installer-owned.
    selection.profile = normalizeProfile(selection.id, {
      ...selection.profile,
      ownership: { ...selection.profile.ownership, state: !stateExisted },
    });
    const servicePath = serviceDefinitionPath(selection.profile, home);
    if (servicePath && existsSync(servicePath)) {
      line(warn(`New profile service definition already exists: ${servicePath}. It will not be overwritten.`));
      line(info('Choose the discovered/update flow, or choose another service instance name. No changes were made.'));
      finish(ttyFd); return;
    }
    const exactProbe = await probeProfileCandidate({ id: selection.id, ...selection.profile }, { fetch: deps.fetch });
    if (exactProbe.reachable) {
      line(warn(exactProbe.compatible
        ? `An ours daemon already answers on 127.0.0.1:${selection.profile.port}; it will not be overwritten.`
        : `A service already answers on 127.0.0.1:${selection.profile.port}; it is incompatible or has different state.`));
      line(info('Choose “manual existing” and verify its exact state/config, or choose another port. No changes were made.'));
      finish(ttyFd); return;
    }
  }

  let plannedRegistry;
  try { plannedRegistry = upsertProfile(registry, selection.id, selection.profile); }
  catch (error) { line(warn(`Profile collision: ${error.message}`)); finish(ttyFd); return; }

  if (selection.kind === 'manual' && !dry) {
    try {
      const checked = await probeProfileCandidate({ id: selection.id, ...selection.profile }, { fetch: deps.fetch });
      if (!checked.reachable || !checked.compatible) throw new Error(checked.error || 'daemon is unreachable');
      await verifyProtected(selection.profile, { fetch: deps.fetch });
      selection.reachable = true;
    }
    catch (error) { line(warn(`Manual daemon verification failed: ${error.message}`)); line(info('No registry entry was written.')); finish(ttyFd); return; }
  }

  line(heading('Applications for this exact daemon'));
  const applications = selectedHarnessApplications(harnesses, registry, selection.id, yes, assumeYes);
  let associationPlan;
  try { associationPlan = planAssociations(plannedRegistry, selection.id, applications, yes); }
  catch (error) { line(warn(error.message)); finish(ttyFd); return; }
  plannedRegistry = associationPlan.registry;
  const wantFleet = assumeYes ? true : yes('  Install/update ours-fleet (roles inherit their harness association)?', true);
  const wantTelegram = assumeYes ? false : yes(`  Point Telegram at profile ${selection.id}?`, false);
  const wantRooms = assumeYes ? false : yes(`  Point Rooms/cowork at profile ${selection.id}?`, false);
  let identityName = 'me';
  try { identityName = userInfo().username || identityName; } catch { /* fallback */ }
  identityName = readChoice(ask, '  Human identity name (created only if this daemon has none): ', identityName);

  line(heading('Review Nightly topology'));
  line(`  profile ${c.bold(selection.profile.label)} [${selection.id}]`);
  line(`  endpoint http://127.0.0.1:${selection.profile.port} · state ${selection.profile.stateDir}`);
  line(`  config ${selection.profile.configPath} · service ${selection.profile.serviceName || '(default)'}`);
  line(`  action ${selection.kind} · harnesses ${applications.join(', ') || '(unchanged)'}`);
  line(`  Telegram ${wantTelegram ? 'use selected profile' : 'unchanged'} · Rooms ${wantRooms ? 'use selected profile' : 'unchanged'} · fleet ${wantFleet ? 'installed' : 'unchanged'}`);
  if (!yes('  Apply this Nightly plan?', true)) {
    line(info('Cancelled before changes.')); finish(ttyFd); return;
  }

  const snapshots = [];
  const snap = (path, { preserveOnFailure = false } = {}) => {
    if (!snapshots.some(([p]) => p === path)) snapshots.push([path, snapshotConfig(path), preserveOnFailure]);
  };
  let partial = false;
  const newArtifactBaseline = selection.kind === 'new' && !dry ? {
    config: existsSync(selection.profile.configPath),
    state: existsSync(selection.profile.stateDir),
    servicePath: serviceDefinitionPath(selection.profile, home),
    service: !!serviceDefinitionPath(selection.profile, home) && existsSync(serviceDefinitionPath(selection.profile, home)),
  } : null;
  let daemonReady = !!selection.reachable;
  const appliedApps = [];
  try {
    // One global package installation/update, regardless of profile count.
    if (selection.kind === 'new' || selection.kind === 'update') {
      const ensured = await actSpin(`ensuring ${pkgSpec('mcp', 'nightly')} once…`, `npm i -g ${pkgSpec('mcp', 'nightly')}`, () => runAsync(npm, ['i', '-g', pkgSpec('mcp', 'nightly')]));
      if (!ensured.ok) throw new Error('global Nightly daemon package update failed');
      partial = true; // npm cannot be rolled back
    }

    if (selection.kind === 'new' || selection.clientConfigNeeded || (selection.kind === 'update' && selection.profile.ownership.config)) {
      snap(selection.profile.configPath, { preserveOnFailure: selection.kind === 'new' });
      const existing = existsSync(selection.profile.configPath) ? readObject(selection.profile.configPath) : {};
      const config = mergeConfig(existing, {
        port: selection.profile.port, stateDir: selection.profile.stateDir,
        serviceName: selection.profile.serviceName || undefined,
        brokerUrl: selection.brokerUrl || existing.brokerUrl || DEFAULT_BROKER,
        autoStart: false,
      });
      await act(`write selected daemon config ${selection.profile.configPath}`, async () => {
        atomicWriteConfig(selection.profile.configPath, config); return { ok: true };
      });
    }

    if (selection.kind === 'new') {
      const selectedEnv = exactEnv(selection.profile);
      const started = await act(`start selected profile ${selection.id}`, async () => run('ours-mcp', ['start'], { env: selectedEnv }));
      if (!started.ok) throw new Error(`selected profile ${selection.id} failed to start`);
      const service = await act(`install exact service for profile ${selection.id}`, async () => run('ours-mcp', ['install-service'], { env: selectedEnv }));
      if (!service.ok && !dry) {
        // install-service can stop the daemon before failing; recover foreground state.
        const recovered = run('ours-mcp', ['start'], { env: selectedEnv });
        if (!recovered.ok) throw new Error(`service apply failed and profile ${selection.id} could not be restarted`);
        throw new Error(`service apply failed for profile ${selection.id}; daemon was recovered and no association was committed`);
      }
      daemonReady = true;
    } else if (selection.kind === 'update' && selection.profile.ownership.service) {
      const selectedEnv = exactEnv(selection.profile);
      const service = await act(`repair/reinstall only selected installer-owned service ${selection.id}`, async () => run('ours-mcp', ['install-service'], { env: selectedEnv }));
      if (!service.ok && !dry) {
        const recovered = run('ours-mcp', ['start'], { env: selectedEnv });
        if (!recovered.ok) throw new Error(`selected profile ${selection.id} service repair failed and daemon recovery failed`);
        throw new Error(`selected profile ${selection.id} service repair failed; daemon was recovered`);
      }
      daemonReady = true;
    }

    if (!dry) {
      try { await verifyProtected(selection.profile, { fetch: deps.fetch }); daemonReady = true; }
      catch (error) { throw new Error(`selected daemon validation failed before association commit: ${error.message}`); }
    }
    if (!daemonReady && !dry) throw new Error('selected daemon is not reachable; associations were not committed');

    for (const application of applications) {
      const installed = await installHarness(application, deps, { ...selection.profile, id: selection.id });
      if (installed.ok) appliedApps.push(application);
      else throw new Error(`${application} installation failed`);
    }
    if (wantFleet) {
      const fleetPkg = await actSpin('installing ours-fleet Nightly…', `npm i -g ${pkgSpec('fleet', 'nightly')}`, () => runAsync(npm, ['i', '-g', pkgSpec('fleet', 'nightly')]));
      if (!fleetPkg.ok) throw new Error('ours-fleet package installation failed');
      // ours-fleet resolves its daemon from OURS_CONFIG / OURS_PORT / OURS_STATE_DIR,
      // falling back to ~/.ours and 3050. It has no concept of this registry, so an
      // init run without the selected profile's environment points every role at the
      // historical default daemon — which, when the selected profile is not the
      // default, is a daemon the user may not even have. Hand it the same exact
      // environment every other selected-profile command here gets.
      const initialized = await act(`ours-fleet init for profile ${selection.id}`, async () => run('ours-fleet', ['init'], { env: exactEnv(selection.profile) }));
      if (!initialized.ok) throw new Error('ours-fleet init failed');
    }

    if (wantTelegram) {
      const path = tgConfigPath(process.env, home);
      const configPlan = planTgDaemonConfig(tgExisting, {
        daemonUrl: daemonEndpoint(selection.profile.port), daemonStateDir: selection.profile.stateDir,
        brokerUrl: selection.brokerUrl || DEFAULT_BROKER,
      });
      const pkg = await actSpin('installing Telegram connector Nightly…', `npm i -g ${pkgSpec('tg-connector', 'nightly')}`, () => runAsync(npm, ['i', '-g', pkgSpec('tg-connector', 'nightly')]));
      if (!pkg.ok) throw new Error('Telegram package installation failed');
      if (configPlan.changed) {
        snap(path);
        await act(`write Telegram config before service apply`, async () => { atomicWriteConfig(path, configPlan.text); return { ok: true }; });
      }
      const service = await act('reinstall Telegram service with selected daemon snapshot', async () => run('ours-tg-connector', ['install-service']));
      if (!service.ok) throw new Error('Telegram service apply failed');
    }

    if (wantRooms) {
      const path = coworkConfigPath(process.env, home);
      const pkg = await actSpin('installing Rooms Nightly…', `npm i -g ${pkgSpec('cowork', 'nightly')}`, () => runAsync(npm, ['i', '-g', pkgSpec('cowork', 'nightly')]));
      if (!pkg.ok) throw new Error('Rooms package installation failed');
      if (!dry) {
        const installed = run(npm, ['ls', '-g', '@ours.network/cowork', '--json'], { capture: true });
        let version = '';
        try { version = JSON.parse(installed.out || '{}')?.dependencies?.['@ours.network/cowork']?.version || ''; }
        catch { /* fail closed below */ }
        if (!coworkSupportsExternalDaemon(version)) {
          throw new Error(`Rooms build ${version || '(unknown)'} cannot use an external daemon; requires ${COWORK_EXTERNAL_MIN_VERSION} or newer`);
        }
      }
      const roomsPlan = planCoworkConfig(roomsExisting, {
        brokerUrl: selection.brokerUrl || DEFAULT_BROKER,
        stateDir: roomsExisting.stateDir || join(home, '.ours-cowork'),
        restPort: roomsExisting.rest?.port || COWORK_DEFAULT_PORT,
        daemon: { endpoint: daemonEndpoint(selection.profile.port), stateDir: selection.profile.stateDir },
      });
      if (roomsPlan.error) throw new Error(roomsPlan.error);
      if (roomsPlan.changed) {
        snap(path);
        await act('write Rooms external daemon config before service apply', async () => { atomicWriteConfig(path, roomsPlan.text); return { ok: true }; });
      }
      const service = await act('reinstall Rooms service with selected daemon snapshot', async () => run('ours-cowork', ['install-service']));
      if (!service.ok) throw new Error('Rooms service apply failed');
    }

    if (!dry) {
      const identity = run('ours-mcp', ['create-root', identityName], { capture: true, env: exactEnv(selection.profile) });
      if (!identity.ok) throw new Error(`human identity creation failed for selected profile ${selection.id}`);
    } else {
      line(`  ${c.dim(`[dry-run] would: create human identity on profile ${selection.id}`)}`);
    }

    snap(registryFile);
    await act(`commit profile registry ${registryFile}`, async () => { writeRegistry(registryFile, plannedRegistry); return { ok: true }; });
  } catch (error) {
    if (!dry) rollbackSnapshots(snapshots);
    let recovery = '';
    if (newArtifactBaseline) {
      const ownership = {
        config: !newArtifactBaseline.config && existsSync(selection.profile.configPath),
        service: !!newArtifactBaseline.servicePath && !newArtifactBaseline.service && existsSync(newArtifactBaseline.servicePath),
        state: !newArtifactBaseline.state && existsSync(selection.profile.stateDir),
      };
      if (Object.values(ownership).some(Boolean)) {
        try {
          const recoveredProfile = normalizeProfile(selection.id, { ...selection.profile, ownership });
          const recoveredRegistry = upsertProfile(registry, selection.id, recoveredProfile);
          writeRegistry(registryFile, recoveredRegistry);
          recovery = ` Recovery metadata recorded installer ownership for: ${Object.entries(ownership).filter(([, owned]) => owned).map(([name]) => name).join(', ')}.`;
        } catch (recoveryError) {
          recovery = ` Recovery metadata could not be recorded: ${recoveryError.message}.`;
        }
      }
    }
    line(warn(`Nightly plan did not complete: ${error.message}`));
    line(info(`Snapshotted config/registry bytes were rolled back${partial ? '; completed package/plugin installs were not rolled back' : ''}.`));
    line(info(`New daemon artifacts and identities were retained for recovery; inspect the selected service before re-running.${recovery}`));
    finish(ttyFd); return;
  }

  const finalIndex = reverseApplicationIndex(plannedRegistry, {
    telegramConfig: wantTelegram ? { daemonUrl: daemonEndpoint(selection.profile.port), daemonStateDir: selection.profile.stateDir } : tgExisting,
    roomsConfig: wantRooms ? { daemon: { endpoint: daemonEndpoint(selection.profile.port), stateDir: selection.profile.stateDir } } : roomsExisting,
  });
  line(heading('Nightly install complete'));
  line(ok(`${selection.profile.label} [${selection.id}] — http://127.0.0.1:${selection.profile.port}`));
  for (const application of finalIndex[selection.id] || []) {
    const restart = application === 'claude-code' ? 'restart Claude Code'
      : application === 'codex' ? 'start a new Codex/ours-codex session'
        : application === 'hermes' ? 'run /reload-mcp in Hermes'
          : application === 'telegram' ? 'restart ours-tg-connector' : 'restart ours-cowork';
    line(`  ${c.green('✓')} ${application} → ${selection.profile.label} (${restart})`);
  }
  if (!appliedApps.length && applications.length) line(info('Existing harness associations were kept; no duplicate MCP registrations were created.'));
  say(`Registry: ${registryFile} (schema v1, mode 0600; no tokens/status/pids stored).`);
  finish(ttyFd);
}
