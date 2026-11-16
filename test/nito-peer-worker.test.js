'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const path = require('node:path');
const {interval, createPeerSyncLoop} = require('../scripts/peer_sync_loop');

test('peer worker interval validation rejects aggressive or malformed loops', () => {
  assert.equal(interval(undefined, 300, 60), 300);
  assert.equal(interval('600', 300, 60), 600);
  for (const value of ['0', '59', '1.5', 'invalid'])
    assert.throws(() => interval(value, 300, 60), /integer/);
});

test('peer worker runs one child at a time and uses success and error cadences', () => {
  const children = [];
  const timers = [];
  const root = path.resolve('peer-worker-test-root');
  const spawn = (...args) => {
    const child = new EventEmitter();
    child.args = args;
    child.kill = signal => { child.killedWith = signal; };
    children.push(child);
    return child;
  };
  const loop = createPeerSyncLoop({
    root, spawn, normalSeconds: 300, errorSeconds: 90,
    setTimer: (callback, delay) => { timers.push({callback, delay}); return timers.length; },
    clearTimer() {}, logger: {log() {}, error() {}}
  });
  loop.start();
  loop.start();
  assert.equal(children.length, 1);
  assert.equal(loop.isRunning(), true);
  assert.deepEqual(children[0].args[1].slice(-2), [path.join(root, 'scripts', 'sync.js'), 'peers']);
  children[0].emit('exit', 0, null);
  assert.equal(loop.isRunning(), false);
  assert.equal(timers[0].delay, 300000);
  timers[0].callback();
  assert.equal(children.length, 2);
  children[1].emit('exit', 1, null);
  assert.equal(timers[1].delay, 90000);
});

test('peer worker forwards shutdown and does not schedule another pass', () => {
  const child = new EventEmitter();
  let stopped = 0;
  let scheduled = 0;
  child.kill = signal => { child.killedWith = signal; };
  const loop = createPeerSyncLoop({
    spawn: () => child, normalSeconds: 300, errorSeconds: 90,
    setTimer: () => { scheduled++; }, clearTimer() {},
    onStopped: () => { stopped++; }, logger: {log() {}, error() {}}
  });
  loop.start();
  loop.stop('SIGTERM');
  assert.equal(child.killedWith, 'SIGTERM');
  child.emit('exit', null, 'SIGTERM');
  assert.equal(stopped, 1);
  assert.equal(scheduled, 0);
});

test('peer worker retries after a synchronous spawn failure', () => {
  const timers = [];
  const errors = [];
  const loop = createPeerSyncLoop({
    spawn: () => { throw new Error('spawn unavailable'); }, normalSeconds: 300, errorSeconds: 90,
    setTimer: (callback, delay) => { timers.push({callback, delay}); return timers.length; },
    clearTimer() {}, logger: {log() {}, error(message) { errors.push(message); }}
  });
  assert.doesNotThrow(() => loop.start());
  assert.equal(loop.isRunning(), false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 90000);
  assert.match(errors[0], /spawn unavailable/);
});
