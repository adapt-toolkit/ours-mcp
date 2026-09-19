import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type HostProfile = Readonly<{
  endpoint: string;
  expectedInstanceId: string;
  credentialPath: string;
}>;

const PROFILE_KEYS = ['endpoint', 'expectedInstanceId', 'credentialPath'] as const;
const LEGACY_SELECTION_KEYS = ['port', 'stateDir', 'apiToken', 'apiVisibility'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONFLICTING_ENV = ['OURS_API_TOKEN', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_DAEMON_ID'] as const;

function profileError(reason: string): Error {
  return new Error(`Invalid external host profile: ${reason}`);
}

export function validateHostProfile(value: unknown): HostProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw profileError('expected a complete host profile object.');
  }
  const record = value as Record<string, unknown>;
  const present = PROFILE_KEYS.filter((key) => Object.hasOwn(record, key));
  if (present.length !== PROFILE_KEYS.length) {
    throw profileError('expected a complete host profile tuple: endpoint, expectedInstanceId, credentialPath.');
  }
  const mixed = LEGACY_SELECTION_KEYS.filter((key) => Object.hasOwn(record, key));
  if (mixed.length) throw profileError(`legacy selection keys cannot be mixed with a host profile (${mixed.join(', ')}).`);

  const endpoint = record.endpoint;
  const expectedInstanceId = record.expectedInstanceId;
  const credentialPath = record.credentialPath;
  if (typeof endpoint !== 'string' || endpoint.trim() !== endpoint || endpoint === '') {
    throw profileError('endpoint must be a non-empty HTTP or HTTPS base URL.');
  }
  if (typeof expectedInstanceId !== 'string' || !UUID.test(expectedInstanceId)) {
    throw profileError('expectedInstanceId must be a lowercase UUID.');
  }
  if (typeof credentialPath !== 'string' || credentialPath === '' || !credentialPath.startsWith('/') || resolve(credentialPath) !== credentialPath) {
    throw profileError('credentialPath must be a normalized absolute path.');
  }

  // Validate raw path before URL normalization can erase dot segments.
  if (/[\s\\?#]/.test(endpoint)) throw profileError('endpoint must be a safe HTTP or HTTPS base URL.');
  const raw = /^(https?:\/\/[^/]+)(\/.*)?$/.exec(endpoint);
  if (!raw) throw profileError('endpoint must be an HTTP or HTTPS base URL.');
  const path = raw[2] ?? '/';
  const prefix = path === '/' ? '' : path.replace(/\/$/, '');
  if (prefix && prefix.slice(1).split('/').some(segment => !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === '.' || segment === '..')) {
    throw profileError('endpoint has an unsafe base path.');
  }
  let url: URL;
  try { url = new URL(endpoint); } catch { throw profileError('endpoint must be an HTTP or HTTPS base URL.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== (prefix ? prefix + (path.endsWith('/') ? '/' : '') : '/')) {
    throw profileError('endpoint has an unsafe base path or credentials.');
  }
  return { endpoint: url.origin + prefix, expectedInstanceId, credentialPath };
}

function readProfileObject(configPath: string): Record<string, unknown> {
  let text: string;
  try { text = readFileSync(configPath, 'utf8'); } catch { throw new Error(`Cannot read host profile ${JSON.stringify(configPath)}.`); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw profileError(`config ${JSON.stringify(configPath)} is not valid JSON.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw profileError(`config ${JSON.stringify(configPath)} must be an object.`);
  return value as Record<string, unknown>;
}

function assertPrivateRegularFile(configPath: string): void {
  let stat;
  try { stat = lstatSync(configPath); } catch { throw new Error(`Cannot read host profile ${JSON.stringify(configPath)}.`); }
  if (!stat.isFile()) throw profileError(`config ${JSON.stringify(configPath)} must be a regular file.`);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || stat.uid !== currentUid) throw profileError(`config ${JSON.stringify(configPath)} must be owned by the current user.`);
  if ((stat.mode & 0o077) !== 0) throw profileError(`config ${JSON.stringify(configPath)} must have private permissions.`);
}

export function readHostProfile(configPath: string): HostProfile | null {
  const record = readProfileObject(configPath);
  const found = PROFILE_KEYS.filter((key) => Object.hasOwn(record, key));
  if (found.length === 0) return null;
  assertPrivateRegularFile(configPath);
  return validateHostProfile(record);
}

function nonempty(env: NodeJS.ProcessEnv, key: string): boolean {
  return (env[key] ?? '').trim() !== '';
}

/** Select only host-client profiles; daemon configuration resolution is unchanged. */
export function hostProfileSelectionFromEnv(env: NodeJS.ProcessEnv = process.env): { profile: HostProfile; configPath: string } | null {
  const explicit = (env.OURS_CONFIG ?? '').trim();
  const managedPath = resolve(env.HOME || homedir(), '.ours-client', 'profile.json');
  let configPath = explicit;
  if (!configPath) {
    try {
      lstatSync(managedPath);
      configPath = managedPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read host profile ${JSON.stringify(managedPath)}.`);
      }
      configPath = resolve(homedir(), '.ours', 'config.json');
      if (!existsSync(configPath)) return null;
    }
  }
  const profile = readHostProfile(configPath);
  if (profile === null) {
    if (resolve(configPath) === managedPath) throw profileError('managed client config must contain a complete host profile tuple.');
    return null;
  }
  const conflicting = CONFLICTING_ENV.filter((key) => nonempty(env, key));
  if (conflicting.length) throw profileError(`${conflicting.join(', ')} conflicts with host-profile mode.`);
  return { profile, configPath };
}

export function hostProfileFromEnv(env: NodeJS.ProcessEnv = process.env): HostProfile | null {
  return hostProfileSelectionFromEnv(env)?.profile ?? null;
}
