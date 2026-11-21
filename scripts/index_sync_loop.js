#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {spawn: spawnProcess} = require('node:child_process');

function interval(value, fallback, minimum) {
  const parsed = Number(value == null || value === '' ? fallback : value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > 86400)
    throw new Error(`Index sync interval must be an integer between ${minimum} and 86400 seconds`);
  return parsed;
}

function createIndexSyncLoop(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const spawn = options.spawn || spawnProcess;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const logger = options.logger || console;
  const onStopped = options.onStopped || (() => {});
  const normalSeconds = interval(options.normalSeconds, 45, 10);
  const errorSeconds = interval(options.errorSeconds, 90, 30);
  let child = null;
  let timer = null;
  let stopping = false;

  function schedule(seconds) {
    if (!stopping) timer = setTimer(run, seconds * 1000);
  }

  function run() {
    timer = null;
    if (stopping || child) return;
    logger.log(`[${new Date().toISOString()}] block index sync begin`);
    try {
      child = spawn(process.execPath, [path.join(root, 'scripts', 'sync_nito.js')], {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true
      });
    } catch (error) {
      logger.error(`Block index sync failed to start: ${error.message}`);
      child = null;
      schedule(errorSeconds);
      return;
    }

    let finished = false;
    const finish = (code, signal, error) => {
      if (finished) return;
      finished = true;
      child = null;
      if (error) logger.error(`Block index sync failed to start: ${error.message}`);
      else logger.log(`[${new Date().toISOString()}] block index sync end code=${code} signal=${signal || 'none'}`);
      if (stopping) onStopped();
      else schedule(code === 0 && !error ? normalSeconds : errorSeconds);
    };
    child.once('error', error => finish(null, null, error));
    child.once('exit', (code, signal) => finish(code, signal));
  }

  function stop(signal = 'SIGTERM') {
    if (stopping) return;
    stopping = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (child) {
      try { child.kill(signal); }
      catch (error) {
        logger.error(`Unable to stop block index sync child: ${error.message}`);
        child = null;
        onStopped();
      }
    } else onStopped();
  }

  return {start: run, stop, isRunning: () => child != null};
}

function main() {
  try {
    const loop = createIndexSyncLoop({
      normalSeconds: interval(process.env.NITO_INDEX_SYNC_INTERVAL, 45, 10),
      errorSeconds: interval(process.env.NITO_INDEX_SYNC_ERROR_INTERVAL, 90, 30),
      onStopped: () => process.exit(0)
    });
    process.once('SIGINT', () => loop.stop('SIGINT'));
    process.once('SIGTERM', () => loop.stop('SIGTERM'));
    loop.start();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = {interval, createIndexSyncLoop};
