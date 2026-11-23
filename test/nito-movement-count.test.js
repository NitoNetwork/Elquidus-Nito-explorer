'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {movementMinimum, countAt, afterBlock} = require('../lib/nito-movement-count');

test('configured movements include the exact threshold and follow the checkpoint on connect and disconnect', () => {
  const minimum = movementMinimum('0.1');
  assert.equal(minimum, 10000000n);
  const before = {hash: 'previous', movement_count: {hash: 'previous', minimum: minimum.toString(), count: 0}};
  const transactions = ['0', '9999999', '10000000', '10000001'].map(total => ({total}));
  const advanced = {hash: 'next', ...afterBlock(before, 'next', transactions, 1)};
  assert.equal(countAt(advanced, minimum), 2);
  assert.deepEqual({hash: 'previous', ...afterBlock(advanced, 'previous', transactions, -1)}, before);
  assert.equal(countAt(advanced, movementMinimum('0.2')), null);
  assert.equal(countAt({...advanced, hash: 'reorg'}, minimum), null);
});

test('invalid movement configuration or inconsistent persisted counts require the indexed fallback', () => {
  for (const invalid of [undefined, 'broken', '0', '-1']) assert.equal(movementMinimum(invalid), null);
  const state = {hash: 'tip', movement_count: {hash: 'tip', minimum: '1', count: 0}};
  assert.deepEqual(afterBlock(state, 'previous', [{total: '1'}], -1), {});
  assert.equal(countAt({...state, movement_count: {...state.movement_count, count: -1}}, 1n), null);
});
