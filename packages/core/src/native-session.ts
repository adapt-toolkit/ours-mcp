import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { attachOursClient } from '@ours.network/sdk';
import type { OursClient } from '@ours.network/sdk';

import { applicationIdentityConfigPath } from './application-identities.js';
import { validateHostProfile } from './host-profile.js';
import type { HostProfile } from './host-profile.js';

const RECORD_VERSION = 1 as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type NativeSessionRecord = Readonly<{
  version: typeof RECORD_VERSION;
  ownerInstanceId: string;
  state: 'active' | 'pending' | 'ended';
}>;

type CachedClient = Readonly<{
  ownerInstanceId: string;
  promise: Promise<OursClient>;
}>;

const clients = new Map<string, CachedClient>();
const operations = new Map<string, Promise<void>>();

function selector(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.trim() !== value || value.includes('\0')) {
    throw new Error('Native session metadata is missing or invalid for this host-profile tool call.');
  }
  return value;
}

export function nativeSessionRecordPath(hostRecordRoot: string, instanceId: string, nativeSessionId: string): string {
  if (!hostRecordRoot || !hostRecordRoot.startsWith('/') || resolve(hostRecordRoot) !== hostRecordRoot) {
    throw new Error('Native session host record root must be a normalized absolute path.');
  }
  if (!UUID.test(instanceId)) throw new Error('Native session daemon instance must be a lowercase UUID.');
  const hash = createHash('sha256').update(selector(nativeSessionId), 'utf8').digest('hex');
  return join(hostRecordRoot, 'sessions', instanceId, `${hash}.json`);
}

function parseRecord(text: string, path: string): NativeSessionRecord {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    throw new Error(`Invalid native session record at ${path}: ${String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid native session record at ${path}: expected an object.`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'ownerInstanceId,state,version' || record.version !== RECORD_VERSION ||
      typeof record.ownerInstanceId !== 'string' || !UUID.test(record.ownerInstanceId) ||
      !['active', 'pending', 'ended'].includes(String(record.state))) {
    throw new Error(`Invalid native session record at ${path}.`);
  }
  return record as NativeSessionRecord;
}

async function readRecord(path: string): Promise<NativeSessionRecord | null> {
  try {
    return parseRecord(await readFile(path, 'utf8'), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeRecord(path: string, record: NativeSessionRecord): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    try { await unlink(temporary); } catch { /* absent */ }
    throw error;
  }
}

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = operations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = predecessor.catch(() => {}).then(() => gate);
  operations.set(key, tail);
  await predecessor.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (operations.get(key) === tail) operations.delete(key);
  }
}

function attach(profile: HostProfile, ownerInstanceId: string): Promise<OursClient> {
  return attachOursClient({
    endpoint: profile.endpoint,
    expectedInstanceId: profile.expectedInstanceId,
    credentialPath: profile.credentialPath,
    sessionMode: 'external',
    leaseToken: ownerInstanceId,
    env: {},
  });
}

function cachedClient(path: string, profile: HostProfile, ownerInstanceId: string): Promise<OursClient> {
  const cached = clients.get(path);
  if (cached?.ownerInstanceId === ownerInstanceId) return cached.promise;
  if (cached) {
    clients.delete(path);
    void cached.promise.then((client) => client.close()).catch(() => {});
  }
  const promise = attach(profile, ownerInstanceId);
  const next = { ownerInstanceId, promise };
  clients.set(path, next);
  void promise.catch(() => { if (clients.get(path) === next) clients.delete(path); });
  return promise;
}

async function releaseOwner(path: string, profile: HostProfile, ownerInstanceId: string): Promise<void> {
  const cached = clients.get(path);
  const client = cached?.ownerInstanceId === ownerInstanceId
    ? await cached.promise
    : await attach(profile, ownerInstanceId);
  try {
    await client.releaseLease();
  } finally {
    if (cached?.ownerInstanceId !== ownerInstanceId) await client.close();
  }
}

async function finishPending(path: string, profile: HostProfile, ownerInstanceId: string): Promise<void> {
  await releaseOwner(path, profile, ownerInstanceId);
  const current = await readRecord(path);
  if (current?.state === 'pending' && current.ownerInstanceId === ownerInstanceId) {
    await writeRecord(path, { version: RECORD_VERSION, ownerInstanceId, state: 'ended' });
  }
  const cached = clients.get(path);
  if (cached?.ownerInstanceId === ownerInstanceId) {
    clients.delete(path);
    void cached.promise.then((client) => client.close()).catch(() => {});
  }
}

/** Attach or recover the owner for one native Codex/Claude logical session. */
export async function nativeClientFor(
  profileValue: HostProfile,
  nativeSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OursClient> {
  return nativeClientForAtRoot(profileValue, nativeSessionId, dirname(applicationIdentityConfigPath(env)));
}

export async function nativeClientForAtRoot(
  profileValue: HostProfile,
  nativeSessionId: string,
  hostRecordRoot: string,
): Promise<OursClient> {
  const profile = validateHostProfile(profileValue);
  const path = nativeSessionRecordPath(hostRecordRoot, profile.expectedInstanceId, nativeSessionId);
  return serialized(path, async () => {
    let record = await readRecord(path);
    if (record?.state === 'pending') {
      await finishPending(path, profile, record.ownerInstanceId);
      record = await readRecord(path);
    }
    if (record?.state === 'active') return cachedClient(path, profile, record.ownerInstanceId);

    const ownerInstanceId = randomUUID();
    await writeRecord(path, { version: RECORD_VERSION, ownerInstanceId, state: 'active' });
    return cachedClient(path, profile, ownerInstanceId);
  });
}

/** Persist terminal intent and release exactly the owner captured by that intent. */
export async function endNativeSession(
  profileValue: HostProfile,
  nativeSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return endNativeSessionAtRoot(profileValue, nativeSessionId, dirname(applicationIdentityConfigPath(env)));
}

export async function endNativeSessionAtRoot(
  profileValue: HostProfile,
  nativeSessionId: string,
  hostRecordRoot: string,
): Promise<void> {
  const profile = validateHostProfile(profileValue);
  const path = nativeSessionRecordPath(hostRecordRoot, profile.expectedInstanceId, nativeSessionId);
  await serialized(path, async () => {
    let record = await readRecord(path);
    if (record === null || record.state === 'ended') return;
    if (record.state === 'active') {
      record = { version: RECORD_VERSION, ownerInstanceId: record.ownerInstanceId, state: 'pending' };
      await writeRecord(path, record);
    }
    await finishPending(path, profile, record.ownerInstanceId);
  });
}
