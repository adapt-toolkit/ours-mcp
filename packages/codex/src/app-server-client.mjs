import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class WebSocketJsonTransport extends EventEmitter {
  constructor(url, options = {}) {
    super();
    this.socket = new WebSocket(url, options);
    this.socket.on('open', () => this.emit('open'));
    this.socket.on('message', (data) => {
      try { this.emit('message', JSON.parse(String(data))); }
      catch (error) { this.emit('error', new Error(`invalid app-server JSON: ${error.message}`)); }
    });
    this.socket.on('error', (error) => this.emit('error', error));
    this.socket.on('close', () => this.emit('close'));
  }
  async ready(timeoutMs = 5000) {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('app-server websocket open timed out')), timeoutMs);
      this.once('open', () => { clearTimeout(timer); resolve(); });
      this.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }
  send(value) { this.socket.send(JSON.stringify(value)); }
  close() { this.socket.close(); }
}

export class AppServerClient {
  #transport;
  #pending = new Map();
  #nextId = 1;
  #timeoutMs;
  #notificationHandlers = new Set();
  #serverRequestHandler = null;
  #closed = false;

  constructor(transport, { timeoutMs = 30_000 } = {}) {
    this.#transport = transport;
    this.#timeoutMs = timeoutMs;
    transport.on('message', (message) => this.#receive(message));
    transport.on('close', () => this.#shutdown(new Error('app-server transport closed')));
    transport.on('error', (error) => this.#shutdown(error));
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'ours_codex', title: 'ours.network Codex monitor', version: '0.9.1' },
      capabilities: { experimentalApi: true },
    });
    this.#transport.send({ method: 'initialized', params: {} });
    return result;
  }

  request(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error('app-server transport closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`app-server ${method} timed out`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#transport.send({ method, id, params });
    });
  }

  listThreads(cwd) { return this.request('thread/list', cwd ? { cwd } : {}); }
  readThread(threadId) { return this.request('thread/read', { threadId, includeTurns: true }); }
  startTurn(threadId, text) { return this.request('turn/start', { threadId, input: [{ type: 'text', text }] }); }
  onNotification(handler) { this.#notificationHandlers.add(handler); return () => this.#notificationHandlers.delete(handler); }
  onServerRequest(handler) { this.#serverRequestHandler = handler; }

  async #receive(message) {
    if (message && Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message?.method && Object.hasOwn(message, 'id')) {
      try {
        if (!this.#serverRequestHandler) throw new Error(`unsupported app-server request ${message.method}`);
        const result = await this.#serverRequestHandler(message);
        this.#transport.send({ id: message.id, result });
      } catch (error) {
        this.#transport.send({ id: message.id, error: { code: -32603, message: error.message } });
      }
      return;
    }
    if (message?.method) for (const handler of this.#notificationHandlers) handler(message);
  }

  #shutdown(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }
  close() { this.#transport.close(); this.#shutdown(new Error('app-server transport closed')); }
}

export async function connectAppServer(url, options = {}) {
  const transport = new WebSocketJsonTransport(url, options.websocket);
  await transport.ready(options.openTimeoutMs);
  const client = new AppServerClient(transport, options);
  await client.initialize();
  return client;
}
