import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.js';
import { RATE_LIMIT_PER_MINUTE, RATE_NOTICE_COOLDOWN_MS, RateLimiter } from '../src/ratelimit.js';

function makeLimiter() {
  let current = 1760000000000;
  const db = openDb(':memory:');
  const limiter = new RateLimiter({ db, now: () => current });
  return { limiter, db, advance: (ms) => (current += ms) };
}

test('six messages per minute are allowed, the seventh is not', () => {
  assert.equal(RATE_LIMIT_PER_MINUTE, 6);
  const { limiter } = makeLimiter();
  const results = [];
  for (let index = 0; index < 7; index += 1) results.push(limiter.register('10001'));
  assert.deepEqual(
    results.map((result) => result.allowed),
    [true, true, true, true, true, true, false],
  );
  assert.equal(typeof results[0].count, 'number');
});

test('the rate limit notice is sent at most once per five minutes', () => {
  assert.equal(RATE_NOTICE_COOLDOWN_MS, 300000);
  let current = 1760000000000;
  const db = openDb(':memory:');
  // A short cooldown exercises the same code path without waiting five minutes.
  const limiter = new RateLimiter({ db, now: () => current, noticeCooldownMs: 5000 });
  for (let index = 0; index < 6; index += 1) limiter.register('10001');
  assert.equal(limiter.register('10001').noticeAllowed, true);
  assert.equal(limiter.register('10001').noticeAllowed, false);

  current += 4999;
  assert.equal(limiter.register('10001').noticeAllowed, false);
  current += 1;
  assert.equal(limiter.register('10001').noticeAllowed, true);
});

test('different users have independent buckets', () => {
  const { limiter } = makeLimiter();
  for (let index = 0; index < 6; index += 1) limiter.register('10001');
  assert.equal(limiter.register('10001').allowed, false);
  assert.equal(limiter.register('20002').allowed, true);
});

test('the window slides: old events expire', () => {
  const { limiter, advance } = makeLimiter();
  for (let index = 0; index < 6; index += 1) limiter.register('10001');
  assert.equal(limiter.register('10001').allowed, false);
  advance(60001);
  assert.equal(limiter.register('10001').allowed, true);
});
