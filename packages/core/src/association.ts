import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { OursConfig } from './config';
import { resolveRuntimeEndpointFileValues } from './runtime-config-values';

export const INSTALLER_PROFILES_VERSION = 1;
export const ASSOCIATED_APPLICATIONS = ['claude-code', 'codex', 'hermes'] as const;
export type AssociatedApplication = (typeof ASSOCIATED_APPLICATIONS)[number];

export interface InstallerProfile {
  label: string;
  host: '127.0.0.1';
  port: number;
  configPath: string;
  stateDir: string;
  serviceName: string;
  ownership: { config: boolean; service: boolean; state: boolean };
}

export interface RuntimeAssociation {
  application: AssociatedApplication;
  profileId: string;
  profile: InstallerProfile;
  registryPath: string;
}

export class AssociationError extends Error {
  code: string;
  constructor(message: string, code = 'INVALID_ASSOCIATION') {
    super(`ours profile association: ${message}. Re-run the Nightly installer to repair this association`);
    this.name = 'AssociationError';
    this.code = code;
  }
}

function requireKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new AssociationError(`${where} contains unsupported field ${JSON.stringify(key)}`);
  }
}

export function parseApplicationArgs(argv: string[]): { application?: AssociatedApplication; argv: string[] } {
  const out: string[] = [];
  let application: AssociatedApplication | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === '--application') {
      if (argv[i + 1] === undefined) throw new AssociationError('--application requires a value', 'INVALID_APPLICATION');
      value = argv[++i];
    } else if (arg.startsWith('--application=')) {
      value = arg.slice('--application='.length);
    } else {
      out.push(arg);
      continue;
    }
    if (!(ASSOCIATED_APPLICATIONS as readonly string[]).includes(value)) {
      throw new AssociationError(`unknown application ${JSON.stringify(value)}`, 'INVALID_APPLICATION');
    }
    if (application && application !== value) {
      throw new AssociationError('only one --application value may be supplied', 'INVALID_APPLICATION');
    }
    application = value as AssociatedApplication;
  }
  return { application, argv: out };
}

export function assertApplicationCommand(
  application: AssociatedApplication | undefined,
  command: string,
): void {
  if (application && command !== 'proxy' && command !== 'watch') {
    throw new AssociationError(
      `--application is legal only for client commands proxy and watch, not ${command}`,
      'APPLICATION_NOT_ALLOWED',
    );
  }
}

export function installerProfilesPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.OURS_INSTALL_PROFILES
    ? safePath(env.OURS_INSTALL_PROFILES, 'OURS_INSTALL_PROFILES')
    : join(home, '.ours', 'installer-profiles.json');
}

function safePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !isAbsolute(value) || normalize(value) !== value || value === '/') {
    throw new AssociationError(`${field} must be a normalized absolute path`, 'UNSAFE_PATH');
  }
  return value;
}

function safeProfile(value: unknown, profileId: string): InstallerProfile {
  const instancePattern = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9])?$/;
  if (!instancePattern.test(profileId)) throw new AssociationError(`invalid profile id ${JSON.stringify(profileId)}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssociationError(`profile ${JSON.stringify(profileId)} is not an object`);
  }
  const raw = value as Record<string, unknown>;
  requireKeys(raw, ['label', 'host', 'port', 'configPath', 'stateDir', 'serviceName', 'ownership'], `profile ${profileId}`);
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) throw new AssociationError(`profile ${JSON.stringify(profileId)} has no label`);
  const host = String(raw.host ?? '').toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new AssociationError(`profile ${JSON.stringify(profileId)} uses non-loopback host ${JSON.stringify(raw.host)}`, 'UNSAFE_HOST');
  }
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AssociationError(`profile ${JSON.stringify(profileId)} has invalid port`, 'INVALID_PORT');
  }
  const ownership = raw.ownership;
  if (!ownership || typeof ownership !== 'object' || Array.isArray(ownership)) {
    throw new AssociationError(`profile ${JSON.stringify(profileId)} has no explicit ownership`);
  }
  const own = ownership as Record<string, unknown>;
  requireKeys(own, ['config', 'service', 'state'], `profile ${profileId} ownership`);
  if (typeof own.config !== 'boolean' || typeof own.service !== 'boolean' || typeof own.state !== 'boolean') {
    throw new AssociationError(`profile ${JSON.stringify(profileId)} has invalid ownership`);
  }
  const serviceName = typeof raw.serviceName === 'string' ? raw.serviceName.trim() : '';
  if ((profileId !== 'default' && !serviceName) || (serviceName && !instancePattern.test(serviceName))) {
    throw new AssociationError(`profile ${JSON.stringify(profileId)} has invalid serviceName`);
  }
  return {
    label,
    host: '127.0.0.1',
    port,
    configPath: safePath(raw.configPath, `profile ${profileId} configPath`),
    stateDir: safePath(raw.stateDir, `profile ${profileId} stateDir`),
    serviceName,
    ownership: { config: own.config, service: own.service, state: own.state },
  };
}

function readJson(path: string, kind: string): Record<string, unknown> {
  let text: string;
  try { text = fs.readFileSync(path, 'utf8'); }
  catch (error) {
    throw new AssociationError(`cannot read ${kind} ${path}: ${(error as NodeJS.ErrnoException).message}`, 'READ_FAILED');
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value as Record<string, unknown>;
  } catch (error) {
    throw new AssociationError(`${kind} ${path} is corrupt JSON: ${(error as Error).message}`, 'CORRUPT_JSON');
  }
}

function canonical(path: string): string {
  try { return fs.realpathSync(path); } catch { return resolve(path); }
}

export function resolveRuntimeAssociation(
  application: AssociatedApplication | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): RuntimeAssociation | null {
  if (!application) return null;
  // An operator selecting an endpoint/config explicitly outranks the installer association.
  if (env.OURS_CONFIG || env.OURS_PORT || env.OURS_STATE_DIR) return null;
  const registryPath = installerProfilesPath(env, home);
  if (!fs.existsSync(registryPath)) return null;
  const registry = readJson(registryPath, 'installer profile registry');
  requireKeys(registry, ['version', 'profiles', 'harnessAssociations'], 'registry');
  if (registry.version !== INSTALLER_PROFILES_VERSION) {
    throw new AssociationError(`registry version is ${JSON.stringify(registry.version)}, expected ${INSTALLER_PROFILES_VERSION}`, 'UNSUPPORTED_VERSION');
  }
  const profiles = registry.profiles;
  const associations = registry.harnessAssociations;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles) ||
      !associations || typeof associations !== 'object' || Array.isArray(associations)) {
    throw new AssociationError('registry schema is invalid');
  }
  const profileMap = profiles as Record<string, unknown>;
  const associationMap = associations as Record<string, unknown>;
  const normalizedProfiles = Object.fromEntries(
    Object.entries(profileMap).map(([id, value]) => [id, safeProfile(value, id)]),
  ) as Record<string, InstallerProfile>;
  const entries = Object.entries(normalizedProfiles);
  for (let index = 0; index < entries.length; index += 1) {
    const [id, profile] = entries[index];
    for (const [otherId, other] of entries.slice(index + 1)) {
      const collision = profile.port === other.port ? 'endpoint'
        : canonical(profile.stateDir) === canonical(other.stateDir) ? 'stateDir'
          : profile.configPath === other.configPath ? 'configPath'
            : profile.serviceName === other.serviceName ? 'serviceName' : '';
      if (collision) throw new AssociationError(`profiles ${id} and ${otherId} collide on ${collision}`, 'PROFILE_COLLISION');
    }
  }
  for (const [key, value] of Object.entries(associationMap)) {
    if (!(ASSOCIATED_APPLICATIONS as readonly string[]).includes(key) || typeof value !== 'string' || !(value in profileMap)) {
      throw new AssociationError(`registry contains invalid association ${JSON.stringify(key)} -> ${JSON.stringify(value)}`);
    }
  }
  const profileId = associationMap[application];
  if (profileId === undefined) return null;
  if (typeof profileId !== 'string' || !(profileId in profileMap)) {
    throw new AssociationError(`${application} names missing profile ${JSON.stringify(profileId)}`);
  }
  const profile = safeProfile(profileMap[profileId], profileId);
  const config = readJson(profile.configPath, `associated daemon config for ${profileId}`);
  const configured = resolveRuntimeEndpointFileValues(config, home);
  const configuredState = canonical(configured.stateDir);
  if (configured.port !== profile.port) {
    throw new AssociationError(
      `profile ${profileId} expects port ${profile.port} but ${profile.configPath} resolves port ${configured.port}`,
      'CONFIG_DRIFT',
    );
  }
  if (configuredState !== canonical(profile.stateDir)) {
    throw new AssociationError(
      `profile ${profileId} expects stateDir ${profile.stateDir} but ${profile.configPath} resolves ${configuredState}`,
      'CONFIG_DRIFT',
    );
  }
  return { application, profileId, profile, registryPath };
}

export async function verifyRuntimeAssociation(
  association: RuntimeAssociation | null,
  config: Pick<OursConfig, 'port' | 'stateDir'>,
  token: string | undefined,
  { fetch: fetchImpl = globalThis.fetch, timeoutMs = 2000 }: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  if (!association) return;
  const { profileId, profile } = association;
  if (config.port !== profile.port || canonical(config.stateDir) !== canonical(profile.stateDir)) {
    throw new AssociationError(`resolved runtime config drifted from profile ${profileId}`, 'CONFIG_DRIFT');
  }
  const request = async (path: string, headers?: Record<string, string>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`http://127.0.0.1:${profile.port}${path}`, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  let infoResponse: Response;
  try { infoResponse = await request('/info'); }
  catch (error) {
    throw new AssociationError(`profile ${profileId} daemon is unreachable on 127.0.0.1:${profile.port}: ${(error as Error).message}`, 'UNREACHABLE');
  }
  if (!infoResponse.ok) {
    throw new AssociationError(`profile ${profileId} /info returned HTTP ${infoResponse.status}`, 'INCOMPATIBLE_DAEMON');
  }
  const info = await infoResponse.json() as { name?: unknown; stateDir?: unknown };
  if (info?.name !== 'ours' || typeof info?.stateDir !== 'string') {
    throw new AssociationError(`profile ${profileId} endpoint is not an ours daemon`, 'INCOMPATIBLE_DAEMON');
  }
  if (canonical(info.stateDir) !== canonical(profile.stateDir)) {
    throw new AssociationError(
      `profile ${profileId} expects stateDir ${profile.stateDir} but the daemon reports ${info.stateDir}`,
      'DAEMON_DRIFT',
    );
  }
  let protectedResponse: Response;
  try {
    protectedResponse = await request('/identities', token ? { 'x-ours-api-token': token } : undefined);
  } catch (error) {
    throw new AssociationError(`profile ${profileId} protected API probe failed: ${(error as Error).message}`, 'AUTH_PROBE_FAILED');
  }
  if (protectedResponse.status === 401 || protectedResponse.status === 403) {
    throw new AssociationError(`profile ${profileId} rejected its selected authentication`, 'AUTH_FAILED');
  }
  if (!protectedResponse.ok) {
    throw new AssociationError(`profile ${profileId} protected API returned HTTP ${protectedResponse.status}`, 'INCOMPATIBLE_DAEMON');
  }
}
