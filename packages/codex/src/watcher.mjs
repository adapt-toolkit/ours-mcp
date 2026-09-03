export const WAKE_PROMPT = 'New ours mail is available for the identity already bound to this session. Use the ours skill and get_messages now, then handle the unread mail. Do not change identities or reveal message bodies outside the normal get_messages result.';

export class MonitorWatcher {
  constructor({ baseUrl, token = null, fetch: fetchImpl = globalThis.fetch, appServer, stateStore = { save: async () => {} }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.baseUrl = baseUrl;
    this.headers = token ? { 'x-ours-api-token': token } : {};
    this.fetch = fetchImpl;
    this.appServer = appServer;
    this.stateStore = stateStore;
    this.sleep = sleep;
    this.authFailed = false;
    this.running = false;
    this.turnActive = false;
    this.pending = false;
    this.queued = false;
    this.controller = null;
    appServer?.onNotification?.((message) => {
      if (message.method === 'turn/started') this.turnActive = true;
      if (message.method === 'turn/completed') this.turnActive = false;
    });
  }

  async #json(path, signal) {
    const response = await this.fetch(`${this.baseUrl}${path}`, { headers: this.headers, signal });
    if (response.status === 401 || response.status === 403) {
      this.authFailed = true;
      throw new Error('ours daemon authentication failed; monitor disarmed');
    }
    if (!response.ok) throw new Error(`ours daemon returned HTTP ${response.status}`);
    return response.json();
  }

  async #wake(threadId) {
    if (this.pending) { this.queued = true; return; }
    this.pending = true;
    try {
      let targetThreadId = threadId;
      do {
        this.queued = false;
        // turn/start steers a normal active turn. Waiting for that turn to finish
        // can wedge mail forever when a steered turn is not independently visible
        // through thread/read, so acceptance of the request completes the wake.
        await this.appServer.startTurn(targetThreadId, WAKE_PROMPT);
        targetThreadId = this.current?.threadId || targetThreadId;
      } while (this.queued);
    }
    finally { this.pending = false; }
  }

  async pollOnce({ identity, threadId, cursor }, signal) {
    const since = cursor == null ? 'tip' : encodeURIComponent(cursor);
    const data = await this.#json(`/identities/${encodeURIComponent(identity)}/notifications?since=${since}`, signal);
    const next = { identity, threadId, cursor: String(data.cursor ?? cursor ?? '') };
    await this.stateStore.save(next);
    if (cursor == null) {
      const unread = await this.#json('/unread', signal);
      const entry = unread.identities?.find((item) => item.name === identity);
      if (entry && (Number(entry.count) > 0 || Number(entry.files) > 0)) await this.#wake(threadId);
    } else if (Array.isArray(data.events) && data.events.length > 0) {
      await this.#wake(threadId);
    }
    return next;
  }

  start({ identity, threadId, cursor = null }) {
    this.stop();
    this.current = { identity, threadId, cursor };
    this.running = true;
    this.authFailed = false;
    this.controller = new AbortController();
    this.loopPromise = this.#loop(this.controller.signal);
    return this.loopPromise;
  }

  async #loop(signal) {
    let delay = 250;
    while (this.running && !signal.aborted) {
      try {
        this.current = await this.pollOnce(this.current, signal);
        delay = 250;
      } catch (error) {
        if (signal.aborted || !this.running) break;
        if (this.authFailed) { this.running = false; throw error; }
        await this.sleep(delay);
        delay = Math.min(delay * 2, 10_000);
      }
    }
  }

  stop() {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
    this.pending = false;
    this.queued = false;
  }
}
