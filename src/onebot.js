import crypto from 'node:crypto';

const DEFAULT_CALL_TIMEOUT_MS = 30000;
const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 10000;

/**
 * OneBot 11 WebSocket *client*: NapCat runs the server, the bridge dials it.
 * Node's global WebSocket is a client, so no third-party package is needed.
 */
export class OneBotClient {
  constructor({
    url,
    accessToken = '',
    log,
    onEvent = () => {},
    now = () => Date.now(),
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
  }) {
    this.url = url;
    this.accessToken = accessToken;
    this.log = log;
    this.onEvent = onEvent;
    this.now = now;
    // Any frame proves the pipe is alive: NapCat pushes a heartbeat every 30 s
    // (heartInterval in onebot11_<self>.json), so silence is measurable.
    this.lastFrameAt = now();
    this.callTimeoutMs = callTimeoutMs;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;

    this.ws = null;
    this.connected = false;
    this.stopped = true;
    this.attempts = 0;
    this.selfId = null;
    this.pending = new Map();
    this.reconnectTimer = null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* closing twice is harmless */
      }
      this.ws = null;
    }
    this.connected = false;
    this.rejectPending(new Error('onebot client stopped'));
  }

  connect() {
    if (this.stopped || this.ws || this.reconnectTimer) return;
    const init = this.accessToken ? { headers: { Authorization: `Bearer ${this.accessToken}` } } : undefined;
    let socket;
    try {
      socket = new WebSocket(this.url, init);
    } catch (error) {
      this.log.error('napcat websocket could not be created', { reason: error.message });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.addEventListener('open', () => {
      this.connected = true;
      this.attempts = 0;
      this.lastFrameAt = this.now();
      this.log.info('napcat websocket connected', { url: sanitizeUrl(this.url) });
    });

    socket.addEventListener('message', (event) => {
      try {
        this.handleFrame(event.data);
      } catch (error) {
        this.log.warn('napcat frame ignored', { reason: error.message });
      }
    });

    socket.addEventListener('error', () => {
      // 'close' always follows; reconnect is scheduled there.
      this.log.warn('napcat websocket error', { url: sanitizeUrl(this.url) });
    });

    socket.addEventListener('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      this.rejectPending(new Error('napcat websocket closed'));
      if (wasConnected) this.log.warn('napcat websocket closed');
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.attempts += 1;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(this.attempts - 1, 10));
    this.log.warn('napcat reconnect scheduled', { attempt: this.attempts, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  handleFrame(data) {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (text === '') return;
    const parsed = JSON.parse(text);
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    this.lastFrameAt = this.now();
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object') continue;
      if (frame.echo !== undefined && this.pending.has(frame.echo)) {
        const entry = this.pending.get(frame.echo);
        this.pending.delete(frame.echo);
        clearTimeout(entry.timer);
        entry.resolve(frame);
        continue;
      }
      if (typeof frame.post_type === 'string') {
        if (frame.self_id !== undefined && frame.self_id !== null) this.selfId = String(frame.self_id);
        this.onEvent(frame);
      }
    }
  }

  /** echo-correlated OneBot action call; resolves with the raw response frame. */
  call(action, params = {}) {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error('napcat websocket is not connected'));
    }
    const echo = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`napcat action ${action} timed out`));
      }, this.callTimeoutMs);
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      }
    });
  }

  rejectPending(error) {
    for (const [echo, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(echo);
      entry.reject(error);
    }
  }
}

/** Strip query strings so a token passed as ?access_token= never reaches the log. */
export function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

export function createOneBotClient(options) {
  return new OneBotClient(options);
}
