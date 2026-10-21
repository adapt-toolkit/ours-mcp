import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

function helperInvocation(container, command, args) {
  const entrypoint = container.args.indexOf('/opt/ours/node_modules/@ours.network/mcp/dist/container.js');
  return { ...container, args: [...container.args.slice(0, entrypoint + 2), command, ...args] };
}

function helperJson(container, command, args) {
  const call = helperInvocation(container, command, args);
  const child = spawnSync(call.command, call.args, { env: call.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(child.stderr.trim() || `${command} exited ${child.status}`);
  return JSON.parse(child.stdout);
}

async function runHelper(container, command, args, input, output) {
  const call = helperInvocation(container, command, args);
  const child = spawn(call.command, call.args, { env: call.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolveExit() : reject(new Error(stderr.trim() || `${command} exited ${signal ?? code}`)));
  });
  const streams = [];
  if (input) streams.push(pipeline(input, child.stdin)); else child.stdin.end();
  if (output) streams.push(pipeline(child.stdout, output)); else child.stdout.resume();
  const results = await Promise.allSettled([...streams, exited]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

async function stageFile(container, id, hostPath) {
  const abs = resolve(hostPath);
  const call = helperInvocation(container, 'file-stage', [id, basename(abs)]);
  const child = spawn(call.command, call.args, { env: call.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (v) => { stdout += v; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (v) => { stderr += v; });
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolveExit() : reject(new Error(stderr.trim() || `file-stage exited ${signal ?? code}`)));
  });
  const results = await Promise.allSettled([pipeline(createReadStream(abs), child.stdin), exited]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return { path: JSON.parse(stdout).path, abs };
}

function toolError(id, error) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `host file transfer failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true } };
}

async function removeTransfer(container, id) {
  try { await runHelper(container, 'file-remove', [id]); } catch { /* preserve the primary result */ }
}

async function eachLine(stream, visit) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, newline + 1);
      pending = pending.subarray(newline + 1);
      await visit(line);
    }
  }
  if (pending.length) await visit(pending);
}

export function runContainerProxy(container) {
  const child = spawn(container.command, container.args, { stdio: ['pipe', 'pipe', 'inherit'], env: container.env });
  const pending = new Map();
  let stopping = false;
  const stopInput = () => { stopping = true; process.stdin.destroy(); };
  child.stdin.on('error', stopInput);
  let outputWrites = Promise.resolve();
  const writeOutput = (bytes) => { outputWrites = outputWrites.then(() => new Promise((done) => process.stdout.write(bytes, done))); return outputWrites; };

  const inputDone = eachLine(process.stdin, async (raw) => {
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch { child.stdin.write(raw); return; }
    // Forward cancellation unchanged. The upstream handler owns cancellation;
    // keep transfer tracking until its actual response so a completed save is
    // copied to the host and its staging directory is removed.
    if (message?.method === 'notifications/cancelled') { child.stdin.write(raw); return; }
    if (message?.method !== 'tools/call' || !message.params?.arguments) { child.stdin.write(raw); return; }
    const name = message.params.name;
    if (name !== 'send_file' && name !== 'save_file') { child.stdin.write(raw); return; }
    const args = message.params.arguments;
    if (name === 'send_file' && !args.path) { child.stdin.write(raw); return; }
    const id = randomUUID();
    try {
      if (name === 'send_file') {
        const staged = await stageFile(container, id, args.path);
        message.params.arguments = { ...args, path: staged.path, filename: args.filename ?? basename(staged.abs) };
        pending.set(message.id, { id, kind: name });
      } else {
        const hostPath = resolve(args.dest_path);
        const target = helperJson(container, 'file-target', [id]);
        message.params.arguments = { ...args, dest_path: target.path };
        pending.set(message.id, { id, kind: name, hostPath, containerPath: target.path });
      }
      if (!stopping) child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      await removeTransfer(container, id);
      await writeOutput(`${JSON.stringify(toolError(message.id, error))}\n`);
    }
  }).catch((error) => {
    if (!stopping) { process.stderr.write(`ours: container MCP input failed: ${error.message}\n`); process.exitCode = 1; child.kill(); }
  }).finally(() => { if (!child.stdin.destroyed) child.stdin.end(); });

  const outputDone = eachLine(child.stdout, async (raw) => {
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch { await writeOutput(raw); return; }
    const transfer = pending.get(message?.id);
    if (!transfer) { await writeOutput(raw); return; }
    pending.delete(message.id);
    try {
      if (transfer.kind === 'save_file' && !message.error && message.result?.isError !== true) {
        mkdirSync(dirname(transfer.hostPath), { recursive: true });
        await runHelper(container, 'file-read', [transfer.id], null, createWriteStream(transfer.hostPath));
        for (const item of message.result?.content ?? []) {
          if (item?.type === 'text' && typeof item.text === 'string') item.text = item.text.split(transfer.containerPath).join(transfer.hostPath);
        }
      }
      await writeOutput(`${JSON.stringify(message)}\n`);
    } catch (error) {
      await writeOutput(`${JSON.stringify(toolError(message.id, error))}\n`);
    } finally { await removeTransfer(container, transfer.id); }
  });

  child.on('error', (error) => { stopInput(); process.stderr.write(`ours: cannot launch container MCP: ${error.message}\n`); process.exitCode = 1; });
  child.on('close', async (code, signal) => {
    stopInput();
    await Promise.allSettled([inputDone, outputDone, outputWrites]);
    await Promise.allSettled([...pending.values()].map((v) => removeTransfer(container, v.id)));
    if (signal) process.kill(process.pid, signal); else process.exitCode = process.exitCode || (code === null || code < 0 ? 1 : code);
  });
  return child;
}
