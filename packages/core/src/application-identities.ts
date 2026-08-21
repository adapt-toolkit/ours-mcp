import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const APPLICATION_IDENTITIES_VERSION = 1 as const;
export const APPLICATION_IDENTITIES_ENV = 'OURS_MCP_CONFIG';

type DaemonIdentityList = { identities: string[] };
type ApplicationIdentityConfig = {
  version: typeof APPLICATION_IDENTITIES_VERSION;
  daemons: Record<string, DaemonIdentityList>;
};

const emptyConfig = (): ApplicationIdentityConfig => ({ version: 1, daemons: {} });

export function applicationIdentityConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env[APPLICATION_IDENTITIES_ENV] ?? '').trim();
  return resolve(explicit || resolve(homedir(), '.ours-mcp', 'config.json'));
}

function parseConfig(text: string, path: string): ApplicationIdentityConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ours-mcp application identity config at ${path}: ${String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ours-mcp application identity config at ${path}: expected an object.`);
  }
  const record = value as Record<string, unknown>;
  if (record.version !== APPLICATION_IDENTITIES_VERSION) {
    throw new Error(
      `Unsupported ours-mcp application identity config version at ${path}: ` +
      `expected ${APPLICATION_IDENTITIES_VERSION}, found ${String(record.version)}.`,
    );
  }
  if (!record.daemons || typeof record.daemons !== 'object' || Array.isArray(record.daemons)) {
    throw new Error(`Invalid ours-mcp application identity config at ${path}: "daemons" must be an object.`);
  }

  const daemons: Record<string, DaemonIdentityList> = {};
  for (const [stateDir, raw] of Object.entries(record.daemons as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Invalid ours-mcp application identity config at ${path}: daemon ${JSON.stringify(stateDir)} must be an object.`);
    }
    const row = raw as Record<string, unknown>;
    if (!Array.isArray(row.identities) || row.identities.some((name) => typeof name !== 'string' || name.length === 0)) {
      throw new Error(`Invalid ours-mcp application identity config at ${path}: daemon ${JSON.stringify(stateDir)} has an invalid identity list.`);
    }
    daemons[resolve(stateDir)] = { identities: [...new Set(row.identities as string[])].sort() };
  }
  return { version: 1, daemons };
}

async function readConfig(path: string): Promise<ApplicationIdentityConfig> {
  try {
    return parseConfig(await readFile(path, 'utf8'), path);
  } catch (error) {
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

/**
 * ours-mcp's application-local identity bookkeeping for one coherently selected
 * daemon. This is a visibility filter, never an authorization boundary.
 */
export class ApplicationIdentityStore {
  readonly stateDir: string;
  readonly path: string;

  constructor(stateDir: string, options: { path?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.stateDir = resolve(stateDir);
    this.path = resolve(options.path ?? applicationIdentityConfigPath(options.env));
  }

  async list(): Promise<string[]> {
    const config = await readConfig(this.path);
    return [...(config.daemons[this.stateDir]?.identities ?? [])];
  }

  async has(name: string): Promise<boolean> {
    return (await this.list()).includes(name);
  }

  async add(name: string): Promise<void> {
    if (!name) throw new Error('Cannot add an empty identity name to ours-mcp.');
    const config = await readConfig(this.path);
    const identities = config.daemons[this.stateDir]?.identities ?? [];
    if (identities.includes(name)) return;
    config.daemons[this.stateDir] = { identities: [...identities, name].sort() };
    await writeConfigAtomic(this.path, config);
  }

  async remove(name: string): Promise<void> {
    const config = await readConfig(this.path);
    const current = config.daemons[this.stateDir];
    if (!current?.identities.includes(name)) return;
    const identities = current.identities.filter((candidate) => candidate !== name);
    if (identities.length === 0) delete config.daemons[this.stateDir];
    else config.daemons[this.stateDir] = { identities };
    await writeConfigAtomic(this.path, config);
  }
}

export async function filterApplicationIdentities<T extends { name: string }>(
  store: ApplicationIdentityStore,
  daemonRows: readonly T[],
): Promise<T[]> {
  const visible = new Set(await store.list());
  return daemonRows.filter((row) => visible.has(row.name));
}
