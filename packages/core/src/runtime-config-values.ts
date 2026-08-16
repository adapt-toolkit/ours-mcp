import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_RUNTIME_PORT = 3050;

export function defaultRuntimeStateDir(home = homedir()): string {
  return resolve(join(home, '.ours'));
}

export function finiteConfigNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function stringConfigValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// Association validation must resolve the same file values and historical
// defaults as loadConfig. Keep that contract here rather than coercing the
// association's copy of config.json independently.
export function resolveRuntimeEndpointFileValues(
  config: Record<string, unknown>,
  home = homedir(),
): { port: number; stateDir: string } {
  return {
    port: finiteConfigNumber(config.port) ?? DEFAULT_RUNTIME_PORT,
    stateDir: resolve(stringConfigValue(config.stateDir) ?? defaultRuntimeStateDir(home)),
  };
}
