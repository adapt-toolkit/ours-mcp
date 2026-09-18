// Internal entrypoint selected only by container host profiles.
// Ordinary host installations continue to use cli.ts without Docker.
import { readFileSync, createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const [expected, command = 'proxy', ...args] = process.argv.slice(2);
if (!expected || expected !== process.env.OURS_DAEMON_ID) throw new Error('MCP target does not match the selected daemon');
const mcpDir = join(process.env.OURS_STATE_DIR || '/var/lib/ours', '.mcp');
const profilePath = join(mcpDir, 'profile.json');
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
if (profile.expectedInstanceId !== expected) throw new Error('MCP profile does not match the selected daemon');
for (const key of ['OURS_API_TOKEN', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_DAEMON_ID', 'OURS_CLIENT_PID', 'OURS_AUTOSTART']) delete process.env[key];
process.env.OURS_CONFIG = profilePath;
process.env.OURS_MCP_CONFIG = join(mcpDir, 'config.json');
process.env.OURS_FILES_ALWAYS_PROMPT = '1';
const cliUrl = new URL('./cli.js', import.meta.url);
const cli = fileURLToPath(cliUrl);

if (['file-stage', 'file-target', 'file-read', 'file-remove'].includes(command)) {
  const [id, name] = args;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id ?? '')) throw new Error('Invalid file transfer ID');
  if (args.length !== (command === 'file-stage' ? 2 : 1)) throw new Error('Invalid file transfer arguments');
  const root = join(mcpDir, 'transfers');
  const dir = join(root, id);
  if (command === 'file-remove') rmSync(dir, { recursive: true, force: true });
  else if (command === 'file-read') await pipeline(createReadStream(join(dir, 'file')), process.stdout);
  else {
    if (command === 'file-stage' && (!name || basename(name) !== name || ['.', '..'].includes(name))) throw new Error('Invalid transfer filename');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, command === 'file-stage' ? name : 'file');
    try {
      if (command === 'file-stage') await pipeline(process.stdin, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      process.stdout.write(JSON.stringify({ path }) + '\n');
    } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  }
} else if (['proxy', 'session-end', 'version'].includes(command)) {
  process.argv = [process.execPath, cli, command, ...args];
  await import(cliUrl.href);
} else if (['application-identities', 'hook-state', 'watch'].includes(command)) {
  const { ApplicationIdentityStore } = await import('./application-identities.js');
  const store = new ApplicationIdentityStore({ instanceId: expected });
  const visible = await store.list();
  if (command === 'application-identities') {
    process.stdout.write(JSON.stringify(visible) + '\n');
  } else {
    const { attachOursClient } = await import('@ours.network/sdk');
    const client = await attachOursClient({ ...profile, sessionMode: 'external', leaseToken: randomUUID(), env: {} });
    try {
      if (command === 'hook-state') {
        const rows = await client.listIdentities();
        const unread = await client.unread();
        process.stdout.write(JSON.stringify({
          identities: rows.map(row => row.name),
          bindings: rows.filter(row => 'session' in row && (row.session === 'mine' || row.session === 'other-live')).map(row => row.name),
          unread: { identities: unread.identities.filter(row => typeof row.name === 'string' && visible.includes(row.name)) },
        }) + '\n');
      } else {
        if (args.length > 1 || args[0]?.startsWith('-')) throw new Error('Usage: watch [identity]');
        const names = args.length ? [args[0]] : visible;
        const abort = new AbortController();
        process.stdin.once('end', () => abort.abort());
        process.stdin.resume();
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
        await Promise.all(names.map(async identity => {
          for await (const event of client.watchNotifications(identity, { kinds: ['inbound'], signal: abort.signal })) {
            process.stdout.write(JSON.stringify({ identity, ...event }) + '\n');
          }
        }));
      }
    } finally { await client.close(); }
  }
} else throw new Error('Unsupported container MCP operation');
