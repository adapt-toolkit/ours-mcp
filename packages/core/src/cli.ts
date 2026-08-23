#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { attachOursClient, resolveDaemonConfig } from '@ours.network/sdk';
import type { NotificationEvent } from '@ours.network/sdk';

import { ApplicationIdentityStore, filterApplicationIdentities } from './application-identities.js';
import type { ConnectorOptions } from './connector.js';

declare const __OURS_VERSION__: string;
const VERSION = typeof __OURS_VERSION__ !== 'undefined' ? __OURS_VERSION__ : '0.0.0-dev';

const out = (value: string): void => { process.stdout.write(`${value}\n`); };
const err = (value: string): void => { process.stderr.write(`${value}\n`); };

const validPid = (value: number): boolean => Number.isInteger(value) && value > 1;
const configuredPid = Number(process.env.OURS_CLIENT_PID);
const CLIENT_PID = validPid(configuredPid)
  ? configuredPid
  : validPid(process.ppid) ? process.ppid : process.pid;
const LEASE_TOKEN = (process.env.CLAUDE_CODE_SESSION_ID ?? '').trim() || `ours-mcp:${CLIENT_PID}`;
const BIND_IDENTITY = (process.env.OURS_BIND_IDENTITY ?? '').trim() || undefined;

const DAEMON_COMMANDS = new Set([
  'start',
  'stop',
  'restart',
  'serve',
  'run',
  'status',
  'install-service',
  'uninstall-service',
]);

function rejectApplicationFlag(args: string[]): void {
  if (args.some((arg) => arg === '--application' || arg.startsWith('--application='))) {
    throw new Error(
      '`--application` is no longer supported. ours-mcp connects to one coherently selected shared daemon; ' +
      'use OURS_CONFIG or a matching OURS_PORT + OURS_STATE_DIR selection.',
    );
  }
}

async function runOurs(args: string[]): Promise<void> {
  const explicit = (process.env.OURS_CLI ?? '').trim();
  const executable = explicit || 'ours';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', env: process.env });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new Error(
          `Cannot find the ${JSON.stringify(executable)} CLI. Install @ours.network/cli@1.0.1, ` +
          'put `ours` on PATH, or set OURS_CLI to its executable path.',
        ));
        return;
      }
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

async function runProxy(): Promise<void> {
  const moduleUrl = new URL('./connector.js', import.meta.url);
  const { runConnector } = await import(moduleUrl.href) as {
    runConnector(options: ConnectorOptions): Promise<void>;
  };
  await runConnector({
    leaseToken: LEASE_TOKEN,
    clientPid: CLIENT_PID,
    version: VERSION,
    bindIdentity: BIND_IDENTITY,
  });
}

function jsonNotification(identity: string, event: NotificationEvent): string {
  return JSON.stringify({ identity, ...event });
}

async function watchIdentity(
  client: Awaited<ReturnType<typeof attachOursClient>>,
  identity: string,
  signal: AbortSignal,
): Promise<void> {
  for await (const event of client.watchNotifications(identity, { kinds: ['inbound'], signal })) {
    out(jsonNotification(identity, event));
  }
}

async function runWatch(args: string[]): Promise<void> {
  if (args.length > 1 || args[0]?.startsWith('-')) {
    throw new Error('Usage: ours-mcp watch [identity]');
  }
  const selection = resolveDaemonConfig();
  const identities = new ApplicationIdentityStore(selection.expectStateDir);
  await identities.list();
  const client = await attachOursClient({ leaseToken: LEASE_TOKEN, clientPid: CLIENT_PID });
  const requested = args[0]?.trim();
  let names: string[];
  if (requested) {
    names = [requested];
  } else {
    names = (await filterApplicationIdentities(identities, await client.identities())).map((row) => row.name);
  }

  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  err(`ours-mcp watch: ${names.length === 0 ? 'no application identities' : `watching ${names.join(', ')}`}`);
  await Promise.all(names.map((name) => watchIdentity(client, name, abort.signal)));
}

function usage(): void {
  out(`ours-mcp ${VERSION} — MCP adapter for the shared ours daemon`);
  out('');
  out('Usage: ours-mcp <command> [options]');
  out('  proxy                 run the stdio MCP server (never starts a daemon)');
  out('  watch [identity]      stream inbound JSON Lines; without a name, only ours-mcp identities');
  out('  start|stop|restart|serve|status');
  out('  install-service|uninstall-service');
  out('                        compatibility aliases for `ours daemon <command>`');
  out('  version               print the ours-mcp package version');
  out('');
  out('Daemon configuration and identity CLI operations moved to @ours.network/cli@1.0.1:');
  out('  ours config setup');
  out('  ours identity --help');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  rejectApplicationFlag(args);
  const command = args.shift() ?? 'help';

  if (DAEMON_COMMANDS.has(command)) {
    await runOurs(['daemon', command === 'run' ? 'serve' : command, ...args]);
    return;
  }

  switch (command) {
    case 'proxy':
      if (args.length) throw new Error('Usage: ours-mcp proxy');
      await runProxy();
      return;
    case 'watch':
      await runWatch(args);
      return;
    case 'setup':
      throw new Error('ours-mcp no longer owns daemon configuration. Run `ours config setup` instead.');
    case 'create-root':
    case 'define-local-identity-file':
    case 'voice-setup':
    case 'voice-status':
    case 'stt-setup':
    case 'stt-status':
      throw new Error(`ours-mcp ${command} moved to the \`ours\` CLI. Run \`ours --help\` for the typed replacement.`);
    case 'version':
    case '--version':
    case '-v':
      out(VERSION);
      return;
    case 'help':
    case '--help':
    case '-h':
      usage();
      return;
    default:
      throw new Error(`Unknown command ${JSON.stringify(command)}. Run \`ours-mcp --help\`.`);
  }
}

function isInvokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const invokedDirectly = isInvokedDirectly();
if (invokedDirectly) {
  main().catch((error) => {
    err(`ours-mcp error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
