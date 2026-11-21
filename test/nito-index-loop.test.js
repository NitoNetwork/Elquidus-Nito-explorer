'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {interval, createIndexSyncLoop} = require('../scripts/index_sync_loop');

test('index loop serializes block sync runs and applies success/error delays', () => {
  const children = [];
  const timers = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.kill = signal => { child.signal = signal; child.emit('exit', null, signal); };
    children.push(child);
    return child;
  };
  const loop = createIndexSyncLoop({spawn, normalSeconds: 10, errorSeconds: 30,
    setTimer: (callback, delay) => { const timer = {callback, delay}; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; }, logger: {log() {}, error() {}}});
  loop.start();
  loop.start();
  assert.equal(children.length, 1);
  children[0].emit('exit', 0, null);
  assert.equal(timers[0].delay, 10000);
  timers[0].callback();
  assert.equal(children.length, 2);
  children[1].emit('exit', 1, null);
  assert.equal(timers[1].delay, 30000);
});

test('index loop stops its owned child and validates interval bounds', () => {
  let stopped = 0;
  let child;
  const loop = createIndexSyncLoop({spawn: () => {
    child = new EventEmitter();
    child.kill = signal => { child.signal = signal; child.emit('exit', null, signal); };
    return child;
  }, logger: {log() {}, error() {}}, onStopped: () => stopped++});
  loop.start();
  loop.stop('SIGTERM');
  assert.equal(child.signal, 'SIGTERM');
  assert.equal(stopped, 1);
  assert.throws(() => interval('9', 45, 10), /between 10 and 86400/);
  assert.equal(interval('', 45, 10), 45);
});
