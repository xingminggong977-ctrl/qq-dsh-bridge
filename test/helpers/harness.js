import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { waitFor } from './wait.js';
import { FakeNapCat } from './ws-stub.js';

export const NODE_TOKEN = 'test-node-token-0427';
export const NAPCAT_TOKEN = 'napcat-secret';
export const OWNER_QQ = '10001';
export const SELF_ID = '30000';

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-test-'));
}

/** Controllable clock so lease/deadline tests need no real waiting. */
export function createClock(start = 1760000000000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    set(value) {
      current = value;
      return current;
    },
  };
}

export function buildEnv(dir, overrides = {}) {
  return {
    NODE_TOKEN,
    OWNER_QQ,
    BRIDGE_HOST: '127.0.0.1',
    BRIDGE_PORT: '0',
    DB_PATH: path.join(dir, 'queue.db'),
    BLOB_DIR: path.join(dir, 'blobs'),
    NAPCAT_WS_URL: 'ws://127.0.0.1:9',
    BACKLOG_TTL_MS: '1800000',
    ...overrides,
  };
}

/**
 * Start an app on an ephemeral port with a temp DB/BLOB dir and a probe log sink.
 * `nodeFetch` is the fake local DSH node: an authenticated HTTP client.
 */
export async function startHarness({ env: envOverrides = {}, timing: timingOverrides = {}, clock, connectOneBot = false, synthesizer } = {}) {
  // Tests never wait on the production backoff ladder unless they ask for it.
  const timing = { sendBackoffMs: [1, 1, 1], segmentDelayMs: 0, pollSliceMs: 25, ...timingOverrides };
  const dir = tempDir();
  const env = buildEnv(dir, envOverrides);
  const config = loadConfig(env);
  const clockObject = clock ?? createClock();
  const lines = [];
  const log = createLogger({
    secrets: [config.nodeToken, config.napcatAccessToken].filter(Boolean),
    write: (line) => lines.push(line),
    now: clockObject.now,
  });
  const app = createApp({ config, log, now: clockObject.now, timing, connectOneBot, synthesizer });
  await app.start();
  const { port } = app.address();
  const base = `http://127.0.0.1:${port}`;

  async function nodeFetch(pathname, init = {}) {
    const { auth = true, body, raw, headers = {}, ...rest } = init;
    const finalHeaders = { ...headers };
    if (auth === true) finalHeaders.authorization = `Bearer ${config.nodeToken}`;
    else if (typeof auth === 'string') finalHeaders.authorization = `Bearer ${auth}`;
    let payload;
    if (raw !== undefined) {
      payload = raw;
      finalHeaders['content-type'] ??= 'application/json';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      finalHeaders['content-type'] = 'application/json';
    }
    const response = await fetch(base + pathname, { ...rest, headers: finalHeaders, body: payload });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, headers: response.headers, body: parsed, text };
  }

  return {
    app,
    config,
    env,
    dir,
    log,
    lines,
    clock: clockObject,
    base,
    nodeFetch,
    queue: app.queue,
    dispatch: app.dispatch,
    blobs: app.blobs,
    notifier: app.notifier,
    ratelimiter: app.ratelimiter,
    onebot: app.onebot,
    async close() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A queue-ready task, i.e. what dispatch inserts after a NapCat event. */
export function groupTask(overrides = {}) {
  return {
    kind: 'group',
    groupId: '123456',
    userId: OWNER_QQ,
    nickname: '小明',
    text: '你好',
    images: [],
    isOwner: true,
    replyTarget: { kind: 'group', groupId: '123456' },
    ...overrides,
  };
}

/**
 * Harness plus a fake NapCat websocket server, wired the way production is:
 * the bridge dials out to NapCat and authenticates with NAPCAT_ACCESS_TOKEN.
 */
export async function startWithNapCat(t, options = {}) {
  const stub = await new FakeNapCat({ accessToken: NAPCAT_TOKEN }).start();
  const harness = await startHarness({
    connectOneBot: true,
    ...options,
    env: { NAPCAT_WS_URL: stub.url, NAPCAT_ACCESS_TOKEN: NAPCAT_TOKEN, ...(options.env ?? {}) },
  });
  t.after(async () => {
    await harness.close();
    await stub.stop();
  });
  await waitFor(() => stub.openCount === 1 && harness.onebot.connected === true, {
    label: 'bridge websocket connected',
  });
  return { stub, harness };
}

/** 1x1 PNG, served over loopback so the bridge really downloads image bytes. */
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

export async function startImageServer(bytes = Buffer.from(PNG_BASE64, 'base64')) {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length) });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/photo.png`,
    bytes,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
