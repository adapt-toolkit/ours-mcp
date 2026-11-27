import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { OursClient } from '@ours.network/sdk';
import type { HostProfile } from './host-profile.js';
import { applicationIdentityConfigPath, ApplicationIdentityStore } from './application-identities.js';
import { nativeClientFor, nativeSessionRecordPath } from './native-session.js';

export type NativeHarness = 'claude-code' | 'codex';
const initialized = new WeakSet<OursClient>();
const ready = new Map<string, {client: OursClient; selector: string}>();
const required = ['automatic-session-identities-v1','identity-display-name-v1','identity-promotion-v1'];

export async function automaticSessionPolicy(env: NodeJS.ProcessEnv = process.env) {
  if (env.OURS_AUTO_SESSION_IDENTITIES === '0') return { enabled: false, exposeLocal: false, localAutoAccept: false };
  const path = resolve(env.OURS_SESSION_POLICY || join(env.HOME || homedir(), '.ours-mcp', 'session-policy.json'));
  try {
    const text = await readFile(path, 'utf8');
    let value;try{value=JSON.parse(text);}catch{throw new Error('Invalid standalone session policy');}
    if (value.version !== 1 || ['enabled','exposeLocal','localAutoAccept'].some(k => typeof value[k] !== 'boolean')) throw new Error('Invalid standalone session policy');
    if (value.localLabel !== undefined && (typeof value.localLabel !== 'string' || !value.localLabel.trim() || value.localLabel.length > 80 || /[\p{C}\p{Zl}\p{Zp}]/u.test(value.localLabel))) throw new Error('Invalid private local label');
    return value as { enabled: boolean; exposeLocal: boolean; localAutoAccept: boolean; localLabel?: string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { enabled: true, exposeLocal: true, localAutoAccept: false };
  }
}

/** Preserve an active legacy owner, while new records namespace otherwise equal native IDs. */
export async function nativeSessionKey(profile: HostProfile, harness: NativeHarness, id: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!['claude-code','codex'].includes(harness) || typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 2048 || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Native session metadata is missing or invalid for this host-profile tool call.');
  const root = dirname(applicationIdentityConfigPath(env));
  const read = async (selector: string) => {
    try { return JSON.parse(await readFile(nativeSessionRecordPath(root, profile.expectedInstanceId, selector), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const legacy = await read(id), key = harness + ':' + id, namespaced = await read(key);
  if (legacy && ['active','pending'].includes(legacy.state)) {
    if (namespaced && ['active','pending'].includes(namespaced.state)) throw new Error('Conflicting legacy and namespaced session owners; no identity was selected');
    return id;
  }
  return key;
}

export async function prepareAutomaticSession(profile: HostProfile | null, harness: NativeHarness, id: string, env: NodeJS.ProcessEnv = process.env, options: { source?: string; subagent?: boolean; managed?: boolean; projectLabel?: string; notice?: boolean; toolCall?: boolean } = {}): Promise<null | { client: OursClient; selector: string; identity: Awaited<ReturnType<OursClient['ensureSessionIdentity']>> | null; showNotice?: boolean }> {
  // Fleet/explicit bindings remain under their existing supervisor/connector path.
  if (!profile || options.managed || env.FLEET_OURS_MANAGED === '1' || options.subagent || env.OURS_BIND_IDENTITY?.trim()) return null;
  const cacheKey = JSON.stringify([profile.endpoint,profile.expectedInstanceId,harness,id]);
  const cached = ready.get(cacheKey);
  if (cached && options.toolCall) return null; // The manual connector still resolves the current durable owner.
  const policy = await automaticSessionPolicy(env);
  if (!policy.enabled) return null;
  const selector = await nativeSessionKey(profile, harness, id, env);
  // Selection is public/non-secret. Do not send credentials to an unqualified endpoint.
  const selectionUrl = new URL(profile.endpoint.replace(/\/$/, '') + '/selection');
  const response = await fetch(selectionUrl, { signal: AbortSignal.timeout(1500), redirect: 'error' });
  const selection = await response.json() as { instanceId?: string; capabilities?: string[] };
  if (!response.ok || selection.instanceId !== profile.expectedInstanceId || !required.every(c => selection.capabilities?.includes(c))) throw Object.assign(new Error('Automatic session identities require an updated Ours daemon with automatic-session-identities-v1; update Ours and restart this session. No identity was created.'), { code: 'OURS_AUTO_UNSUPPORTED' });
  const path = nativeSessionRecordPath(dirname(applicationIdentityConfigPath(env)), profile.expectedInstanceId, selector);
  try {
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (['ended','pending'].includes(existing.state) && options.source !== 'resume') throw new Error('This native owner has ended. Resume the native session explicitly before creating another identity.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (harness === 'codex' && options.toolCall) {
    // Codex may issue MCP calls for child threads. Only SessionStart can attest
    // a main thread; a bare threadId is not permission to allocate an identity.
    try { await readFile(path + '.main', 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  const client = await nativeClientFor(profile, selector, env);
  if (initialized.has(client) && !options.notice && !options.projectLabel) return { client, selector, identity: null };
  const identity = await client.ensureSessionIdentity({ harness, sessionHandle: 's-' + createHash('sha256').update(harness + '\0' + id).digest('hex'), exposeLocal: policy.exposeLocal, localAutoAccept: policy.localAutoAccept, ...(options.projectLabel ? { projectLabel: options.projectLabel } : {}), ...('localLabel' in policy && policy.localLabel ? { localLabel: policy.localLabel } : {}) });
  const store = new ApplicationIdentityStore({ instanceId: profile.expectedInstanceId }, { path: applicationIdentityConfigPath(env) });
  await store.add(identity.name);
  initialized.add(client);
  ready.set(cacheKey, {client, selector});
  if (options.notice && harness === 'codex') await writeFile(path + '.main', '1\n', {mode:0o600});
  let showNotice = false;
  if (options.notice && identity.temporary && !identity.preserved) {
    // A tool connection may create the identity before SessionStart. Only a hook
    // claims the visible notice, once per CID, atomically across hook processes.
    const marker = path + '.notice-' + createHash('sha256').update(identity.cid).digest('hex');
    try { await writeFile(marker, '1\n', { flag: 'wx', mode: 0o600 }); showNotice = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  return { client, selector, identity, showNotice };
}
