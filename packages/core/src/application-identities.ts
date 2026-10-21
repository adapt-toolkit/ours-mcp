import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const APPLICATION_IDENTITIES_VERSION = 1 as const;
export const APPLICATION_IDENTITIES_ENV = 'OURS_MCP_CONFIG';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type IdentityList = { identities: string[] };
type ApplicationIdentityConfig = {
  version: typeof APPLICATION_IDENTITIES_VERSION;
  daemons: Record<string, IdentityList>;
  instances: Record<string, IdentityList>;
};
type ApplicationIdentityTarget = string | Readonly<{ instanceId: string }>;

const emptyConfig = (): ApplicationIdentityConfig => ({ version: 1, daemons: {}, instances: {} });

export function applicationIdentityConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env[APPLICATION_IDENTITIES_ENV] ?? '').trim();
  return resolve(explicit || resolve(homedir(), '.ours-mcp', 'config.json'));
}

function parseRows(raw: unknown, path: string, namespace: 'daemon' | 'instance', normalizeKey: (key: string) => string): Record<string, IdentityList> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid ours-mcp application identity config at ${path}: "${namespace}s" must be an object.`);
  }
  const rows: Record<string, IdentityList> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid ours-mcp application identity config at ${path}: ${namespace} ${JSON.stringify(key)} must be an object.`);
    }
    const row = value as Record<string, unknown>;
    if (!Array.isArray(row.identities) || row.identities.some((name) => typeof name !== 'string' || name.length === 0)) {
      throw new Error(`Invalid ours-mcp application identity config at ${path}: ${namespace} ${JSON.stringify(key)} has an invalid identity list.`);
    }
    rows[normalizeKey(key)] = { identities: [...new Set(row.identities as string[])].sort() };
  }
  return rows;
}

function parseConfig(text: string, path: string): ApplicationIdentityConfig {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`Invalid ours-mcp application identity config at ${path}: ${String(error)}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ours-mcp application identity config at ${path}: expected an object.`);
  const record = value as Record<string, unknown>;
  if (record.version !== APPLICATION_IDENTITIES_VERSION) {
    throw new Error(`Unsupported ours-mcp application identity config version at ${path}: expected ${APPLICATION_IDENTITIES_VERSION}, found ${String(record.version)}.`);
  }
  const daemons = parseRows(record.daemons, path, 'daemon', resolve);
  const instances = record.instances === undefined ? {} : parseRows(record.instances, path, 'instance', (instanceId) => {
    if (!UUID.test(instanceId)) throw new Error(`Invalid ours-mcp application identity config at ${path}: instance ${JSON.stringify(instanceId)} must be a lowercase UUID.`);
    return instanceId;
  });
  return { version: 1, daemons, instances };
}

async function readConfig(path: string): Promise<ApplicationIdentityConfig> {
  try { return parseConfig(await readFile(path, 'utf8'), path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
    throw error;
  }
}

async function writeConfigAtomic(path: string, config: ApplicationIdentityConfig): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    try { await unlink(temporary); } catch { /* absent */ }
    throw error;
  }
}

/** Application-local identity visibility bookkeeping, never authorization or selection state. */
export class ApplicationIdentityStore {
  readonly stateDir: string | null;
  readonly instanceId: string | null;
  readonly path: string;

  constructor(target: ApplicationIdentityTarget, options: { path?: string; env?: NodeJS.ProcessEnv } = {}) {
    if (typeof target === 'string') {
      this.stateDir = resolve(target);
      this.instanceId = null;
    } else {
      if (!target || !UUID.test(target.instanceId)) throw new Error('Application identity instanceId must be a lowercase UUID.');
      this.stateDir = null;
      this.instanceId = target.instanceId;
    }
    this.path = resolve(options.path ?? applicationIdentityConfigPath(options.env));
  }

  private rows(config: ApplicationIdentityConfig): Record<string, IdentityList> {
    return this.instanceId === null ? config.daemons : config.instances;
  }

  private key(): string {
    return this.instanceId ?? this.stateDir!;
  }

  async list(): Promise<string[]> {
    const config = await readConfig(this.path);
    return [...(this.rows(config)[this.key()]?.identities ?? [])];
  }

  async has(name: string): Promise<boolean> { return (await this.list()).includes(name); }

  async add(name: string): Promise<void> {
    if (!name) throw new Error('Cannot add an empty identity name to ours-mcp.');
    const config = await readConfig(this.path);
    const rows = this.rows(config);
    const key = this.key();
    const identities = rows[key]?.identities ?? [];
    if (identities.includes(name)) return;
    rows[key] = { identities: [...identities, name].sort() };
    await writeConfigAtomic(this.path, config);
  }

  async remove(name: string): Promise<void> {
    const config = await readConfig(this.path);
    const rows = this.rows(config);
    const key = this.key();
    const current = rows[key];
    if (!current?.identities.includes(name)) return;
    const identities = current.identities.filter((candidate) => candidate !== name);
    if (identities.length === 0) delete rows[key]; else rows[key] = { identities };
    await writeConfigAtomic(this.path, config);
  }
}

export async function filterApplicationIdentities<T extends { name: string }>(store: ApplicationIdentityStore, daemonRows: readonly T[]): Promise<T[]> {
  const visible = new Set(await store.list());
  return daemonRows.filter((row) => visible.has(row.name));
}
