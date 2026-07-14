import { createServer, createConnection } from 'node:net';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { decodeControlLine, encodeControlResponse } from './control-protocol.mjs';
import { createMonitorState, registerSession, bindingChanged, arm, disarm } from './monitor-state.mjs';

export class AtomicStateStore {
  constructor(path) { this.path = path; }
  async save(value) {
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

export class ControlServer {
  constructor({ socketPath, capability, initialState = createMonitorState(), onEffects = async () => {}, stateStore = null }) {
    this.socketPath = socketPath;
    this.capability = capability;
    this.state = initialState;
    this.onEffects = onEffects;
    this.stateStore = stateStore;
  }

  async start() {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.socketPath), 0o700);
    await rm(this.socketPath, { force: true });
    this.server = createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 64 * 1024) { socket.end(encodeControlResponse({ ok: false, error: 'control message too large' })); return; }
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
          void this.#handle(line).then((value) => socket.end(encodeControlResponse(value)));
        }
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.socketPath, resolve); });
    await chmod(this.socketPath, 0o600);
  }

  async #handle(line) {
    try {
      const msg = decodeControlLine(line, this.capability);
      let transition = { state: this.state, effects: [] };
      if (msg.command === 'register_session') transition = registerSession(this.state, msg);
      else if (msg.command === 'binding_changed') transition = bindingChanged(this.state, msg.identity);
      else if (msg.command === 'arm') transition = arm(this.state, msg.identity);
      else if (msg.command === 'disarm') transition = disarm(this.state);
      this.state = transition.state;
      await this.stateStore?.save(this.state);
      await this.onEffects(transition.effects, this.state);
      return { ok: true, state: this.state };
    } catch (error) { return { ok: false, error: error.message }; }
  }

  async close() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    await rm(this.socketPath, { force: true });
  }
}

export function sendControlCommand(socketPath, capability, message, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('monitor control timed out')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(encodeControlResponse({ ...message, capability })));
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(buffer);
        if (!response.ok) reject(new Error(response.error || 'monitor control failed'));
        else resolve(response);
      } catch (error) { reject(error); }
    });
  });
}
