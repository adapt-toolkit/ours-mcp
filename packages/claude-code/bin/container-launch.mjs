import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// An explicit container selection is authoritative: failures never fall back
// to a host MCP or host application-identity configuration.
export function containerInvocation(command, args = [], env = process.env) {
  const explicitPath = (env.OURS_CONFIG ?? '').trim();
  const path = explicitPath || join(homedir(), '.ours', 'config.json');
  let profile;
  try { profile = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (!explicitPath && error.code === 'ENOENT') return null;
    throw new Error(`cannot read OURS_CONFIG profile ${path}: ${error.message}`);
  }
  if (!profile || !Object.hasOwn(profile, 'composeFile')) return null;
  if (typeof profile.composeFile !== 'string' || !isAbsolute(profile.composeFile)) throw new Error('composeFile must be an absolute path');
  if (typeof profile.expectedInstanceId !== 'string' || !profile.expectedInstanceId.trim()) throw new Error('container profile requires expectedInstanceId');
  if (profile.composeProject !== undefined && (typeof profile.composeProject !== 'string' || !profile.composeProject.trim())) throw new Error('composeProject must be a nonempty string');
  const dockerArgs = ['compose', '-f', profile.composeFile];
  if (profile.composeProject !== undefined) dockerArgs.push('-p', profile.composeProject);
  dockerArgs.push('exec', '-T');
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'OURS_BIND_IDENTITY']) {
    if (env[name] !== undefined) dockerArgs.push('-e', `${name}=${env[name]}`);
  }
  dockerArgs.push('daemon', 'node', '/opt/ours/node_modules/@ours.network/mcp/dist/container.js', profile.expectedInstanceId, command, ...args);
  return { command: 'docker', args: dockerArgs, env: { ...env, OURS_DAEMON_ID: profile.expectedInstanceId } };
}

export function readContainerJson(command, env = process.env) {
  const invocation = containerInvocation(command, [], env);
  if (!invocation) return null;
  const child = spawnSync(invocation.command, invocation.args, { env: invocation.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`ours container ${command} failed: ${child.stderr.trim() || child.status}`);
  const value = JSON.parse(child.stdout);
  if (value === null) throw new Error(`ours container ${command} returned null`);
  return value;
}
