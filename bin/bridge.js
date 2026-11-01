#!/usr/bin/env node
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';

function fatal(message) {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', msg: message })}\n`);
  process.exit(1);
}

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  fatal(error.message);
}

const log = createLogger({ secrets: [config.nodeToken, config.napcatAccessToken] });
const app = createApp({ config, log });

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  try {
    await app.close();
  } catch (error) {
    log.error('shutdown failed', { reason: error.message });
  }
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (error) => {
  log.error('uncaught exception', { reason: error.message });
  shutdown('uncaughtException');
});

try {
  await app.start();
} catch (error) {
  fatal(`failed to start: ${error.message}`);
}
