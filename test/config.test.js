import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError, loadConfig, normalizeHost, parseOwnerList } from '../src/config.js';

test('defaults mirror the deployment contract', () => {
  const config = loadConfig({ NODE_TOKEN: 'tok' });
  assert.equal(config.bridgeHost, '127.0.0.1');
  assert.equal(config.bridgePort, 8787);
  assert.equal(config.napcatWsUrl, 'ws://127.0.0.1:3001');
  assert.equal(config.napcatAccessToken, '');
  assert.equal(config.backlogTtlMs, 1800000);
  assert.equal(config.dbPath, '/var/lib/dsh-qq-bridge/queue.db');
  assert.equal(config.blobDir, '/var/lib/dsh-qq-bridge/blobs');
  assert.deepEqual(config.ownerQq, []);
  assert.equal(config.nodeToken, 'tok');
  assert.equal(config.groupMode, 'mention');
});

test('BRIDGE_HOST wildcards are refused at startup', () => {
  for (const host of ['0.0.0.0', '::', '[::]', '*', '0:0:0:0:0:0:0:0', ' 0.0.0.0 ']) {
    assert.throws(
      () => loadConfig({ NODE_TOKEN: 'tok', BRIDGE_HOST: host }),
      (error) => error instanceof ConfigError && /BRIDGE_HOST/.test(error.message),
      `expected ${host} to be rejected`,
    );
  }
  assert.equal(loadConfig({ NODE_TOKEN: 'tok', BRIDGE_HOST: '127.0.0.1' }).bridgeHost, '127.0.0.1');
});

test('NODE_TOKEN is mandatory and never echoed by the error', () => {
  assert.throws(() => loadConfig({}), (error) => error instanceof ConfigError && /NODE_TOKEN/.test(error.message));
  assert.throws(
    () => loadConfig({ NODE_TOKEN: '   ' }),
    (error) => error instanceof ConfigError && /NODE_TOKEN/.test(error.message),
  );
});

test('bad numbers and URLs are refused', () => {
  assert.throws(() => loadConfig({ NODE_TOKEN: 'tok', BRIDGE_PORT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ NODE_TOKEN: 'tok', BRIDGE_PORT: '-1' }), ConfigError);
  assert.throws(() => loadConfig({ NODE_TOKEN: 'tok', BACKLOG_TTL_MS: '0' }), ConfigError);
  assert.throws(() => loadConfig({ NODE_TOKEN: 'tok', NAPCAT_WS_URL: 'http://127.0.0.1:3001' }), ConfigError);
});

test('env overrides are honoured', () => {
  const config = loadConfig({
    NODE_TOKEN: 'tok',
    OWNER_QQ: '10001, 10002,abc,',
    BRIDGE_PORT: '0',
    DB_PATH: './tmp/queue.db',
    BLOB_DIR: './tmp/blobs',
    BACKLOG_TTL_MS: '60000',
    NAPCAT_ACCESS_TOKEN: 'napcat-secret',
  });
  assert.equal(config.bridgePort, 0);
  assert.deepEqual(config.ownerQq, ['10001', '10002']);
  assert.equal(config.backlogTtlMs, 60000);
  assert.equal(config.napcatAccessToken, 'napcat-secret');
  assert.equal(config.dbPath, './tmp/queue.db');
});

test('GROUP_MODE accepts mention|all and refuses anything else', () => {
  assert.equal(loadConfig({ NODE_TOKEN: 'tok', GROUP_MODE: 'mention' }).groupMode, 'mention');
  assert.equal(loadConfig({ NODE_TOKEN: 'tok', GROUP_MODE: ' all ' }).groupMode, 'all');
  for (const bad of ['everyone', 'ALL', 'mention,all', '0', 'true']) {
    assert.throws(
      () => loadConfig({ NODE_TOKEN: 'tok', GROUP_MODE: bad }),
      (error) => error instanceof ConfigError && /GROUP_MODE/.test(error.message),
      `expected ${bad} to be rejected`,
    );
  }
});

test('helpers normalise input predictably', () => {
  assert.equal(normalizeHost('[::1]'), '::1');
  assert.equal(normalizeHost('  127.0.0.1 '), '127.0.0.1');
  assert.deepEqual(parseOwnerList(undefined), []);
  assert.deepEqual(parseOwnerList(' 10001 '), ['10001']);
});
