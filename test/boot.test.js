import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'bin', 'bridge.js');

function runBridge(env, { until = /http listening/, timeoutMs = 8000 } = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding('utf8').on('data', (chunk) => stdout.push(chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.push(chunk));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not boot within ${timeoutMs}ms`)), timeoutMs);
    const check = () => {
      if (until.test(stdout.join(''))) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`bridge exited early: ${stdout.join('')}${stderr.join('')}`));
    });
  });
  // The failure path only awaits `exited`, so keep the boot promise handled.
  ready.catch(() => {});
  return { child, exited, ready, stdout, stderr };
}

test('the entry point refuses to bind 0.0.0.0 and says why', async () => {
  const run = runBridge(
    { NODE_TOKEN: 'token-should-not-leak', BRIDGE_HOST: '0.0.0.0', BRIDGE_PORT: '0' },
    { until: /never-matches/ },
  );
  const code = await run.exited;
  const output = `${run.stdout.join('')}${run.stderr.join('')}`;
  assert.equal(code, 1);
  assert.match(output, /BRIDGE_HOST/);
  assert.ok(!output.includes('token-should-not-leak'), output);
});

test('the entry point boots and shuts down cleanly on SIGTERM', async () => {
  const run = runBridge({ NODE_TOKEN: 'boot-token', BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: '0' });
  try {
    await run.ready;
    const listening = JSON.parse(run.stdout.join('').trim().split('\n')[0]);
    assert.equal(listening.msg, 'http listening');
    assert.equal(listening.host, '127.0.0.1');
    assert.ok(!run.stdout.join('').includes('boot-token'));

    run.child.kill('SIGTERM');
    const code = await run.exited;
    assert.ok(code === 0 || code === null, `expected a clean exit, got ${code}`);
  } finally {
    // 断言失败时若不收尾，子进程会一直活着，整个测试进程挂在这里不退出。
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
  }
});
