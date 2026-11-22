'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {networkHashInUnit} = require('../lib/nito-index');

test('network history keeps exact H/s and converts only the legacy chart field', () => {
  assert.equal(networkHashInUnit(522.232210670485, 'H'), 522.232210670485);
  assert.ok(Math.abs(networkHashInUnit(522.232210670485, 'P') - 5.22232210670485e-13) < 1e-27);
  assert.equal(networkHashInUnit(1e15, 'P'), 1);
});

test('network history rejects unavailable and unknown-unit values', () => {
  assert.equal(networkHashInUnit(undefined, 'H'), null);
  assert.equal(networkHashInUnit(-1, 'H'), null);
  assert.equal(networkHashInUnit(1, 'invalid'), null);
});
