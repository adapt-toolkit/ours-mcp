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

import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';

export const PROFILE_REGISTRY_VERSION = 1;
export const HARNESS_APPLICATIONS = ['claude-code', 'codex', 'hermes'];
export const DEFAULT_PROFILE_ID = 'default';
export const DEFAULT_PROFILE_PORT = 3050;
const PROFILE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9])?$/;
const SECRET_KEYS = /token|secret|password|credential|apiKey/i;

export class ProfileRegistryError extends Error {
  constructor(message, code = 'INVALID_REGISTRY') {
    super(message);
    this.name = 'ProfileRegistryError';
    this.code = code;
  }
}

export function profilesPath(env = process.env, home = homedir()) {
  return env.OURS_INSTALL_PROFILES
    ? normalizeProfilePath(env.OURS_INSTALL_PROFILES, 'OURS_INSTALL_PROFILES')
    : join(home, '.ours', 'installer-profiles.json');
}

export function emptyRegistry() {
  return { version: PROFILE_REGISTRY_VERSION, profiles: {}, harnessAssociations: {} };
}

export function normalizeLoopbackHost(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'localhost' || value === '127.0.0.1') return '127.0.0.1';
  throw new ProfileRegistryError(
    `host must be localhost or 127.0.0.1 (got ${JSON.stringify(raw)})`,
    'UNSAFE_HOST',
  );
}

export function normalizeProfileId(raw, { allowDefault = true } = {}) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new ProfileRegistryError('profile id is required', 'INVALID_PROFILE_ID');
  if (!allowDefault && value === DEFAULT_PROFILE_ID) {
    throw new ProfileRegistryError('profile id "default" is reserved', 'INVALID_PROFILE_ID');
  }
  if (value.length > 32 || !PROFILE_ID_RE.test(value)) {
    throw new ProfileRegistryError(
      'profile id must be 1–32 letters, digits, hyphens or underscores, starting and ending with a letter or digit',
      'INVALID_PROFILE_ID',
    );
  }
  return value;
}

export function normalizeProfilePath(raw, field) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ProfileRegistryError(`${field} must be a non-empty absolute path`, 'UNSAFE_PATH');
  }
  const value = raw.trim();
  if (value.includes('\0') || !isAbsolute(value) || normalize(value) !== value || value === '/') {
    throw new ProfileRegistryError(`${field} must be a normalized absolute path below the filesystem root`, 'UNSAFE_PATH');
  }
  return value;
}

export function normalizeServiceName(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  if (value.length > 32 || !PROFILE_ID_RE.test(value)) {
    throw new ProfileRegistryError(
      'serviceName must be empty or use the 1–32 character daemon instance-name format',
      'INVALID_SERVICE_NAME',
    );
  }
  return value;
}

function boolOwnership(value, field) {
  if (typeof value !== 'boolean') {
    throw new ProfileRegistryError(`ownership.${field} must be boolean`, 'INVALID_OWNERSHIP');
  }
  return value;
}

function assertNoSecrets(value, where = 'registry') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) {
      throw new ProfileRegistryError(`${where} must never contain secret field ${JSON.stringify(key)}`, 'SECRET_IN_REGISTRY');
    }
    if (nested && typeof nested === 'object') assertNoSecrets(nested, `${where}.${key}`);
  }
}

function assertOnlyKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ProfileRegistryError(`${where} contains unsupported field ${JSON.stringify(key)}`, 'INVALID_SCHEMA');
    }
  }
}

export function normalizeProfile(id, input) {
  const profileId = normalizeProfileId(id);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProfileRegistryError(`profile ${profileId} must be an object`, 'INVALID_PROFILE');
  }
  assertNoSecrets(input, `profiles.${profileId}`);
  assertOnlyKeys(input, ['label', 'host', 'port', 'configPath', 'stateDir', 'serviceName', 'ownership'], `profiles.${profileId}`);
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || label.length > 120 || /[\r\n\0]/.test(label)) {
    throw new ProfileRegistryError(`profile ${profileId} label must be 1–120 printable characters`, 'INVALID_PROFILE');
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProfileRegistryError(`profile ${profileId} port must be an integer from 1 to 65535`, 'INVALID_PORT');
  }
  const configPath = normalizeProfilePath(input.configPath, `profiles.${profileId}.configPath`);
  const stateDir = normalizeProfilePath(input.stateDir, `profiles.${profileId}.stateDir`);
  if (configPath === stateDir || dirname(configPath) === configPath) {
    throw new ProfileRegistryError(`profile ${profileId} configPath and stateDir must be distinct`, 'UNSAFE_PATH');
  }
  const ownership = input.ownership;
  if (!ownership || typeof ownership !== 'object' || Array.isArray(ownership)) {
    throw new ProfileRegistryError(`profile ${profileId} requires explicit ownership`, 'INVALID_OWNERSHIP');
  }
  assertOnlyKeys(ownership, ['config', 'service', 'state'], `profiles.${profileId}.ownership`);
  const serviceName = normalizeServiceName(input.serviceName);
  if (profileId !== DEFAULT_PROFILE_ID && !serviceName) {
    throw new ProfileRegistryError(
      `profile ${profileId} requires a named service instance; the empty serviceName is reserved for profile "default"`,
      'INVALID_SERVICE_NAME',
    );
  }
  return {
    label,
    host: normalizeLoopbackHost(input.host),
    port,
    configPath,
    stateDir,
    serviceName,
    ownership: {
      config: boolOwnership(ownership.config, 'config'),
      service: boolOwnership(ownership.service, 'service'),
      state: boolOwnership(ownership.state, 'state'),
    },
  };
}

export function validateRegistry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProfileRegistryError('profile registry must be an object');
  }
  assertNoSecrets(input);
  assertOnlyKeys(input, ['version', 'profiles', 'harnessAssociations'], 'registry');
  if (input.version !== PROFILE_REGISTRY_VERSION) {
    throw new ProfileRegistryError(
      `unsupported profile registry version ${JSON.stringify(input.version)}; expected ${PROFILE_REGISTRY_VERSION}`,
      'UNSUPPORTED_VERSION',
    );
  }
  if (!input.profiles || typeof input.profiles !== 'object' || Array.isArray(input.profiles)) {
    throw new ProfileRegistryError('profile registry profiles must be an object');
  }
  if (!input.harnessAssociations || typeof input.harnessAssociations !== 'object' || Array.isArray(input.harnessAssociations)) {
    throw new ProfileRegistryError('profile registry harnessAssociations must be an object');
  }
  const profiles = {};
  for (const [id, value] of Object.entries(input.profiles)) profiles[normalizeProfileId(id)] = normalizeProfile(id, value);
  const harnessAssociations = {};
  for (const [application, profileId] of Object.entries(input.harnessAssociations)) {
    if (!HARNESS_APPLICATIONS.includes(application)) {
      throw new ProfileRegistryError(`unknown harness association ${JSON.stringify(application)}`, 'INVALID_ASSOCIATION');
    }
    if (typeof profileId !== 'string' || !profiles[profileId]) {
      throw new ProfileRegistryError(`association ${application} names missing profile ${JSON.stringify(profileId)}`, 'INVALID_ASSOCIATION');
    }
    harnessAssociations[application] = profileId;
  }
  const normalized = { version: PROFILE_REGISTRY_VERSION, profiles, harnessAssociations };
  assertNoProfileCollisions(normalized.profiles);
  return normalized;
}

export function readRegistry(path = profilesPath(), { allowMissing = true } = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return emptyRegistry();
    throw new ProfileRegistryError(`cannot read profile registry ${path}: ${error?.message || error}`, 'READ_FAILED');
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new ProfileRegistryError(`profile registry ${path} is corrupt JSON: ${error.message}`, 'CORRUPT_JSON'); }
  return validateRegistry(parsed);
}

export function registryText(registry) {
  return JSON.stringify(validateRegistry(registry), null, 2) + '\n';
}

export function writeRegistry(path, registry, { rename = renameSync } = {}) {
  const text = registryText(registry);
  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === text) {
      chmodSync(path, 0o600);
      return { changed: false, path };
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600);
      rename(tmp, path);
      chmodSync(path, 0o600);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* absent or renamed */ }
      throw error;
    }
    return { changed: true, path };
  } catch (error) {
    if (error instanceof ProfileRegistryError) throw error;
    throw new ProfileRegistryError(`cannot atomically write profile registry ${path}: ${error?.message || error}`, 'WRITE_FAILED');
  }
}

export function endpointKey(profile) {
  return `${normalizeLoopbackHost(profile.host)}:${Number(profile.port)}`;
}

export function canonicalStateDir(path, realpath = realpathSync) {
  const normalized = normalizeProfilePath(path, 'stateDir');
  try { return realpath(normalized); } catch { return normalized; }
}

function canonicalStateForDependency(path, realpath) {
  const normalized = resolve(path);
  const suffix = [];
  let existingAncestor = normalized;
  while (true) {
    try {
      const canonicalAncestor = realpath(existingAncestor);
      return { known: true, path: resolve(canonicalAncestor, ...suffix.reverse()) };
    } catch (error) {
      // A nonexistent leaf is deterministic: canonicalize its nearest existing
      // ancestor so symlinked parents and lexical missing paths still compare.
      // Permission/I/O failures are ambiguous and must remain fail-closed.
      if (error?.code !== 'ENOENT') return { known: false };
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return { known: false };
      suffix.push(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

export function compareDependencyStateDirs(left, right, { realpath = realpathSync } = {}) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  if (normalizedLeft === normalizedRight) return 'equal';
  const canonicalLeft = canonicalStateForDependency(normalizedLeft, realpath);
  const canonicalRight = canonicalStateForDependency(normalizedRight, realpath);
  if (!canonicalLeft.known || !canonicalRight.known) return 'unknown';
  return canonicalLeft.path === canonicalRight.path ? 'equal' : 'different';
}

export function profileConflicts(profiles, id, candidate, { realpath = realpathSync } = {}) {
  const normalized = normalizeProfile(id, candidate);
  const endpoint = endpointKey(normalized);
  const state = canonicalStateDir(normalized.stateDir, realpath);
  const conflicts = [];
  for (const [otherId, otherValue] of Object.entries(profiles || {})) {
    if (otherId === id) continue;
    const other = normalizeProfile(otherId, otherValue);
    if (endpointKey(other) === endpoint) conflicts.push({ field: 'endpoint', profileId: otherId, value: endpoint });
    if (canonicalStateDir(other.stateDir, realpath) === state) conflicts.push({ field: 'stateDir', profileId: otherId, value: state });
    if (other.configPath === normalized.configPath) conflicts.push({ field: 'configPath', profileId: otherId, value: normalized.configPath });
    if (other.serviceName === normalized.serviceName) conflicts.push({ field: 'serviceName', profileId: otherId, value: normalized.serviceName });
  }
  return conflicts;
}

export function assertNoProfileCollisions(profiles, options) {
  for (const [id, profile] of Object.entries(profiles || {})) {
    const conflicts = profileConflicts(profiles, id, profile, options);
    if (conflicts.length) {
      const c = conflicts[0];
      throw new ProfileRegistryError(
        `profile ${id} collides with ${c.profileId} on ${c.field} ${JSON.stringify(c.value)}`,
        'PROFILE_COLLISION',
      );
    }
  }
}

export function upsertProfile(registry, id, profile, options) {
  const current = validateRegistry(registry);
  const profileId = normalizeProfileId(id);
  const nextProfile = normalizeProfile(profileId, profile);
  const conflicts = profileConflicts(current.profiles, profileId, nextProfile, options);
  if (conflicts.length) {
    const c = conflicts[0];
    throw new ProfileRegistryError(
      `profile ${profileId} collides with ${c.profileId} on ${c.field} ${JSON.stringify(c.value)}`,
      'PROFILE_COLLISION',
    );
  }
  return { ...current, profiles: { ...current.profiles, [profileId]: nextProfile } };
}

export function associateHarness(registry, application, profileId, { allowReassign = false } = {}) {
  const current = validateRegistry(registry);
  if (!HARNESS_APPLICATIONS.includes(application)) {
    throw new ProfileRegistryError(`unknown harness ${JSON.stringify(application)}`, 'INVALID_ASSOCIATION');
  }
  if (!current.profiles[profileId]) {
    throw new ProfileRegistryError(`cannot associate ${application} with missing profile ${JSON.stringify(profileId)}`, 'INVALID_ASSOCIATION');
  }
  const previous = current.harnessAssociations[application];
  if (previous && previous !== profileId && !allowReassign) {
    throw new ProfileRegistryError(
      `${application} is already associated with profile ${previous}; explicit reassignment confirmation is required`,
      'REASSIGN_CONFIRMATION_REQUIRED',
    );
  }
  return {
    registry: {
      ...current,
      harnessAssociations: { ...current.harnessAssociations, [application]: profileId },
    },
    changed: previous !== profileId,
    previous,
  };
}

export function removeHarnessAssociation(registry, application) {
  const current = validateRegistry(registry);
  const previous = current.harnessAssociations[application];
  if (!previous) return { registry: current, changed: false };
  const harnessAssociations = { ...current.harnessAssociations };
  delete harnessAssociations[application];
  return { registry: { ...current, harnessAssociations }, changed: true, previous };
}

function externalDaemon(value) {
  if (!value || typeof value !== 'object') return null;
  const endpoint = value.endpoint || value.daemonUrl;
  const stateDir = value.stateDir || value.daemonStateDir;
  if (typeof endpoint !== 'string' || typeof stateDir !== 'string') return null;
  let url;
  try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  let host;
  try { host = normalizeLoopbackHost(url.hostname); } catch { return null; }
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, stateDir: resolve(stateDir) };
}

export function reverseApplicationIndex(registry, { telegramConfig, roomsConfig } = {}, options = {}) {
  const current = validateRegistry(registry);
  const index = Object.fromEntries(Object.keys(current.profiles).map((id) => [id, []]));
  for (const [application, profileId] of Object.entries(current.harnessAssociations)) index[profileId].push(application);
  const connectorTargets = [
    ['telegram', externalDaemon(telegramConfig)],
    ['rooms', externalDaemon(roomsConfig?.daemon)],
  ];
  for (const [application, target] of connectorTargets) {
    if (!target) continue;
    for (const [id, profile] of Object.entries(current.profiles)) {
      if (endpointKey(profile) !== `${target.host}:${target.port}`) continue;
      const stateComparison = compareDependencyStateDirs(profile.stateDir, target.stateDir, options);
      // Unknown canonicalization is a dependency for deletion safety. Operators
      // can still proceed through an explicit connector lifecycle action.
      if (stateComparison !== 'different') {
        index[id].push(application);
      }
    }
  }
  for (const applications of Object.values(index)) applications.sort();
  return index;
}

function candidateFromProfile(id, profile, origin) {
  const value = normalizeProfile(id, {
    label: profile.label,
    host: profile.host,
    port: profile.port,
    configPath: profile.configPath,
    stateDir: profile.stateDir,
    serviceName: profile.serviceName,
    ownership: profile.ownership,
  });
  return { id, ...value, origin, configured: true, reachable: false };
}

export function dedupeCandidates(candidates, { realpath = realpathSync } = {}) {
  const accepted = [];
  for (const raw of candidates) {
    const id = normalizeProfileId(raw.id);
    const candidate = { ...candidateFromProfile(id, raw, raw.origin || 'candidate'), ...raw, id };
    const endpoint = endpointKey(candidate);
    const state = canonicalStateDir(candidate.stateDir, realpath);
    const exact = accepted.find((item) => endpointKey(item) === endpoint && canonicalStateDir(item.stateDir, realpath) === state);
    if (exact) {
      exact.origins = [...new Set([...(exact.origins || [exact.origin]), ...(candidate.origins || [candidate.origin])])];
      exact.reachable ||= candidate.reachable;
      continue;
    }
    const endpointConflict = accepted.find((item) => endpointKey(item) === endpoint);
    if (endpointConflict) {
      throw new ProfileRegistryError(
        `candidate endpoint ${endpoint} names different state directories (${endpointConflict.stateDir} and ${candidate.stateDir})`,
        'DISCOVERY_COLLISION',
      );
    }
    const stateConflict = accepted.find((item) => canonicalStateDir(item.stateDir, realpath) === state);
    if (stateConflict) {
      throw new ProfileRegistryError(
        `candidate state directory ${state} names different endpoints (${endpointKey(stateConflict)} and ${endpoint})`,
        'DISCOVERY_COLLISION',
      );
    }
    accepted.push({ ...candidate, origins: candidate.origins || [candidate.origin] });
  }
  return accepted;
}

export async function probeProfileCandidate(candidate, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  const normalized = candidateFromProfile(candidate.id, candidate, candidate.origin || 'candidate');
  const base = `http://${normalized.host}:${normalized.port}`;
  const request = async (path) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetchImpl(`${base}${path}`, { signal: controller.signal }); }
    finally { clearTimeout(timer); }
  };
  try {
    const infoResponse = await request('/info');
    if (!infoResponse.ok) return { ...normalized, reachable: true, compatible: false, error: `HTTP ${infoResponse.status} from /info` };
    const info = await infoResponse.json();
    if (info?.name !== 'ours' || typeof info?.stateDir !== 'string') {
      return { ...normalized, reachable: true, compatible: false, error: 'endpoint is not an ours daemon' };
    }
    if (canonicalStateDir(info.stateDir) !== canonicalStateDir(normalized.stateDir)) {
      return { ...normalized, reachable: true, compatible: false, drift: true, error: `daemon reports stateDir ${info.stateDir}` };
    }
    let versionResponse;
    try {
      versionResponse = await request('/version');
    } catch (error) {
      return { ...normalized, reachable: true, compatible: false, info, error: `/version failed: ${String(error?.message || error)}` };
    }
    if (!versionResponse.ok) {
      return { ...normalized, reachable: true, compatible: false, info, error: `HTTP ${versionResponse.status} from /version` };
    }
    let version = '';
    try { version = String((await versionResponse.json())?.version || ''); }
    catch { return { ...normalized, reachable: true, compatible: false, info, error: '/version returned invalid JSON' }; }
    if (!version) return { ...normalized, reachable: true, compatible: false, info, error: '/version did not report a version' };
    if (typeof info.version === 'string' && info.version && info.version !== version) {
      return { ...normalized, reachable: true, compatible: false, info, version, error: `/info and /version disagree (${info.version} vs ${version})` };
    }
    return { ...normalized, reachable: true, compatible: true, info, version };
  } catch (error) {
    return { ...normalized, reachable: false, compatible: null, error: error?.name === 'AbortError' ? 'probe timed out' : String(error?.message || error) };
  }
}

export async function discoverProfileCandidates({
  registry = emptyRegistry(), defaultCandidate, legacyCandidates = [], connectorCandidates = [],
  serviceCandidates = [], manualCandidate, probe = probeProfileCandidate, realpath = realpathSync,
} = {}) {
  const current = validateRegistry(registry);
  const ordered = [];
  for (const [id, profile] of Object.entries(current.profiles)) ordered.push(candidateFromProfile(id, profile, 'registry'));
  if (defaultCandidate) ordered.push({ ...defaultCandidate, origin: 'default-config' });
  for (const candidate of legacyCandidates) ordered.push({ ...candidate, origin: candidate.origin || 'legacy-config' });
  for (const candidate of connectorCandidates) ordered.push({ ...candidate, origin: candidate.origin || 'connector-config' });
  for (const candidate of serviceCandidates) ordered.push({ ...candidate, origin: candidate.origin || 'known-service' });
  if (manualCandidate) ordered.push({ ...manualCandidate, origin: 'manual' });
  const deduped = dedupeCandidates(ordered, { realpath });
  const out = [];
  for (const candidate of deduped) out.push(await probe(candidate));
  return out;
}

export function defaultHistoricalProfile(home = homedir()) {
  return {
    label: 'Default ours daemon', host: '127.0.0.1', port: DEFAULT_PROFILE_PORT,
    configPath: join(home, '.ours', 'config.json'), stateDir: join(home, '.ours'), serviceName: '',
    ownership: { config: true, service: true, state: true },
  };
}

export function fileMode(path) {
  return statSync(path).mode & 0o777;
}
