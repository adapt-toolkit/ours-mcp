import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

const DEFAULT_PORT = 3050;

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ours: ${value} is not a valid TCP port`);
  return port;
}

export function parseOursArgs(argv = []) {
  const codexArgs = [];
  let port;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ours-port') {
      if (argv[i + 1] == null) throw new Error('ours: --ours-port requires a value');
      port = validPort(argv[++i]);
    } else if (arg.startsWith('--ours-port=')) {
      port = validPort(arg.slice('--ours-port='.length));
    } else {
      codexArgs.push(arg);
    }
  }
  return { port, codexArgs };
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return {}; }
}

async function readRequiredJson(path, kind) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { throw rerun(`cannot read ${kind} ${path}: ${error.message}`); }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value;
  } catch (error) { throw rerun(`${kind} ${path} is corrupt JSON: ${error.message}`); }
}

async function readRegistryJson(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try { return JSON.parse(text); }
  catch (error) { throw rerun(`registry ${path} is corrupt JSON: ${error.message}`); }
}

async function readOwnerToken(stateDir) {
  try { return (await readFile(join(stateDir, 'daemon-token'), 'utf8')).trim() || null; } catch { return null; }
}

const rerun = (message) => new Error(`ours profile association: ${message}. Re-run the Nightly installer to repair this association`);
const PROFILE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9])?$/;
const APPLICATIONS = ['claude-code', 'codex', 'hermes'];

function associatedPath(value, profileId, field) {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || value === '/') {
    throw rerun(`profile ${profileId} has unsafe ${field}`);
  }
  return value;
}

function validateProfile(profileId, value) {
  if (!PROFILE_ID.test(profileId)) throw rerun(`invalid profile id ${JSON.stringify(profileId)}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw rerun(`profile ${profileId} is not an object`);
  for (const key of Object.keys(value)) {
    if (!['label', 'host', 'port', 'configPath', 'stateDir', 'serviceName', 'ownership'].includes(key)) {
      throw rerun(`profile ${profileId} contains unsupported field ${JSON.stringify(key)}`);
    }
  }
  if (typeof value.label !== 'string' || !value.label.trim()) throw rerun(`profile ${profileId} has no label`);
  const host = String(value.host || '').toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1') throw rerun(`profile ${profileId} uses non-loopback host ${JSON.stringify(value.host)}`);
  let port;
  try { port = validPort(value.port); }
  catch { throw rerun(`profile ${profileId} has invalid port`); }
  const configPath = associatedPath(value.configPath, profileId, 'configPath');
  const stateDir = associatedPath(value.stateDir, profileId, 'stateDir');
  const serviceName = typeof value.serviceName === 'string' ? value.serviceName.trim() : '';
  if ((profileId !== 'default' && !serviceName) || (serviceName && !PROFILE_ID.test(serviceName))) {
    throw rerun(`profile ${profileId} has invalid serviceName`);
  }
  const ownership = value.ownership;
  if (!ownership || typeof ownership !== 'object' || Array.isArray(ownership)) throw rerun(`profile ${profileId} has no explicit ownership`);
  for (const key of Object.keys(ownership)) if (!['config', 'service', 'state'].includes(key)) throw rerun(`profile ${profileId} ownership contains unsupported field ${JSON.stringify(key)}`);
  if (typeof ownership.config !== 'boolean' || typeof ownership.service !== 'boolean' || typeof ownership.state !== 'boolean') {
    throw rerun(`profile ${profileId} has invalid ownership`);
  }
  return { ...value, label: value.label.trim(), host: '127.0.0.1', port, configPath, stateDir, serviceName };
}

function associatedProfile(registry, application) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw rerun('registry is not an object');
  for (const key of Object.keys(registry)) if (!['version', 'profiles', 'harnessAssociations'].includes(key)) throw rerun(`registry contains unsupported field ${JSON.stringify(key)}`);
  if (registry.version !== 1) throw rerun(`unsupported registry version ${JSON.stringify(registry.version)}`);
  if (!registry.profiles || typeof registry.profiles !== 'object' || Array.isArray(registry.profiles) ||
      !registry.harnessAssociations || typeof registry.harnessAssociations !== 'object' || Array.isArray(registry.harnessAssociations)) {
    throw rerun('registry profiles and harnessAssociations must be objects');
  }
  const profiles = Object.fromEntries(Object.entries(registry.profiles).map(([id, value]) => [id, validateProfile(id, value)]));
  const profileEntries = Object.entries(profiles);
  for (let index = 0; index < profileEntries.length; index += 1) {
    const [id, profile] = profileEntries[index];
    for (const [otherId, other] of profileEntries.slice(index + 1)) {
      const collision = profile.port === other.port ? 'endpoint'
        : resolve(profile.stateDir) === resolve(other.stateDir) ? 'stateDir'
          : profile.configPath === other.configPath ? 'configPath'
            : profile.serviceName === other.serviceName ? 'serviceName' : '';
      if (collision) throw rerun(`profiles ${id} and ${otherId} collide on ${collision}`);
    }
  }
  for (const [key, value] of Object.entries(registry.harnessAssociations)) {
    if (!APPLICATIONS.includes(key) || typeof value !== 'string' || !profiles[value]) {
      throw rerun(`invalid association ${JSON.stringify(key)} -> ${JSON.stringify(value)}`);
    }
  }
  const profileId = registry.harnessAssociations[application];
  if (profileId == null) return null;
  return { profileId, ...profiles[profileId] };
}

export async function resolveDaemonProfile({ argv = [], env = process.env, readConfig, fetch: fetchImpl = globalThis.fetch } = {}) {
  const parsed = parseOursArgs(argv);
  const home = env.HOME || homedir();
  const defaultConfigPath = join(home, '.ours', 'config.json');
  const explicitPort = parsed.port != null || (env.OURS_PORT != null && env.OURS_PORT !== '');
  const explicitConfig = !!env.OURS_CONFIG;
  const explicitState = !!env.OURS_STATE_DIR;
  let association = null;
  if (!explicitPort && !explicitConfig && !explicitState) {
    const registryPath = env.OURS_INSTALL_PROFILES || join(home, '.ours', 'installer-profiles.json');
    if (env.OURS_INSTALL_PROFILES && (!isAbsolute(registryPath) || normalize(registryPath) !== registryPath || registryPath === '/')) {
      throw rerun('OURS_INSTALL_PROFILES must be a normalized absolute path');
    }
    let registry;
    try { registry = await readRegistryJson(registryPath); }
    catch (error) {
      if (String(error?.message || '').startsWith('ours profile association:')) throw error;
      throw rerun(`cannot read registry ${registryPath}: ${error?.message || error}`);
    }
    if (registry) association = associatedProfile(registry, 'codex');
  }
  const configPath = env.OURS_CONFIG || association?.configPath || defaultConfigPath;
  const config = await (readConfig ? readConfig(configPath) : association
    ? readRequiredJson(configPath, `associated config for ${association.profileId}`)
    : readJson(configPath));
  let source = 'default';
  let port = DEFAULT_PORT;
  if (config?.port != null) { port = validPort(config.port); source = env.OURS_CONFIG ? 'OURS_CONFIG' : association ? 'registry' : 'config'; }
  if (association) {
    const configState = resolve(config?.stateDir || join(home, '.ours'));
    if (port !== association.port || configState !== resolve(association.stateDir)) {
      throw rerun(`profile ${association.profileId} disagrees with ${configPath} on port/stateDir`);
    }
  }
  if (env.OURS_PORT != null && env.OURS_PORT !== '') { port = validPort(env.OURS_PORT); source = 'OURS_PORT'; }
  if (parsed.port != null) { port = parsed.port; source = '--ours-port'; }

  const baseUrl = `http://127.0.0.1:${port}`;
  let response;
  try { response = await fetchImpl(`${baseUrl}/info`, { signal: AbortSignal.timeout(2000) }); }
  catch (error) {
    throw new Error(`ours daemon on port ${port} is not reachable; ours-codex never starts it. Start the selected daemon first. (${error?.message || error})`);
  }
  if (!response.ok) throw new Error(`ours daemon on port ${port} returned HTTP ${response.status}`);
  const info = await response.json();
  if (info?.name !== 'ours' || !Number.isInteger(info?.protocol) || info.protocol < 1 || typeof info?.stateDir !== 'string') {
    throw new Error(`incompatible service on port ${port}; expected an ours daemon with notification protocol 1`);
  }
  const stateDir = resolve(info.stateDir);
  const expectedStateDir = env.OURS_STATE_DIR ? resolve(env.OURS_STATE_DIR) : association ? resolve(association.stateDir) : null;
  if (expectedStateDir && stateDir !== expectedStateDir) {
    throw association
      ? rerun(`profile ${association.profileId} expects stateDir ${expectedStateDir}, daemon reports ${stateDir}`)
      : new Error(`ours daemon stateDir mismatch: expected ${expectedStateDir}, daemon reports ${stateDir}`);
  }
  const selectedStateDir = expectedStateDir || stateDir;
  const token = env.OURS_API_TOKEN?.trim() || config?.apiToken?.trim() || await readOwnerToken(selectedStateDir);
  const headers = token ? { 'x-ours-api-token': token } : {};
  let capability;
  try { capability = await fetchImpl(`${baseUrl}/identities`, { headers, signal: AbortSignal.timeout(2000) }); }
  catch (error) { throw new Error(`ours daemon capability check failed: ${error?.message || error}`); }
  if (capability.status === 401 || capability.status === 403) throw new Error(`ours daemon authentication failed on port ${port}; supply the matching OURS_API_TOKEN/config`);
  if (!capability.ok) throw new Error(`selected daemon lacks the notification API (HTTP ${capability.status})`);
  let unread;
  try { unread = await fetchImpl(`${baseUrl}/unread`, { headers, signal: AbortSignal.timeout(2000) }); }
  catch (error) { throw new Error(`ours daemon unread capability check failed: ${error?.message || error}`); }
  if (unread.status === 401 || unread.status === 403) throw new Error(`ours daemon authentication failed on port ${port}; supply the matching OURS_API_TOKEN/config`);
  if (!unread.ok) throw new Error(`selected daemon lacks the body-free unread API (HTTP ${unread.status}); install the testing daemon build and restart that daemon explicitly`);

  return {
    port, stateDir: selectedStateDir, token: token || null,
    visibility: env.OURS_API_VISIBILITY || config?.apiVisibility || 'owner',
    source, info, baseUrl, configPath, codexArgs: parsed.codexArgs,
    ...(association ? { profileId: association.profileId, association } : {}),
  };
}
