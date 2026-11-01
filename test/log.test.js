import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger } from '../src/log.js';

test('log lines are JSON with the documented shape', () => {
  const lines = [];
  const log = createLogger({ secrets: [], write: (line) => lines.push(line), now: () => 1760000000000 });
  log.info('bridge started', { port: 8787 });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, 'info');
  assert.equal(record.msg, 'bridge started');
  assert.equal(record.port, 8787);
  assert.equal(record.ts, new Date(1760000000000).toISOString());
});

test('configured secrets never reach the log', () => {
  const lines = [];
  const log = createLogger({
    secrets: ['node-token-value', 'napcat-token-value'],
    write: (line) => lines.push(line),
    now: () => 1760000000000,
  });
  log.warn('auth failed', { nodeToken: 'node-token-value', napcatAccessToken: 'napcat-token-value' });
  log.error(new Error('boom node-token-value'));
  const text = lines.join('\n');
  assert.ok(!text.includes('node-token-value'), text);
  assert.ok(!text.includes('napcat-token-value'), text);
  assert.ok(text.includes('***'), text);
});

test('bearer tokens and access_token query params are masked even when not configured', () => {
  const lines = [];
  const log = createLogger({ secrets: [], write: (line) => lines.push(line), now: () => 0 });
  log.info('Authorization: Bearer abc123');
  log.info('ws://127.0.0.1:3001?access_token=abc123');
  const text = lines.join('\n');
  assert.ok(!text.includes('abc123'), text);
});
