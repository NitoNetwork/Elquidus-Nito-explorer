'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parsePage, encodeCursor} = require('../lib/nito-latest-page');

test('transaction pages preserve valid positional requests and reject invalid sizes and offsets', () => {
  const parse = params => parsePage({min: '0', ...params}, {}, 100);
  assert.deepEqual(parse({}), {min: 0n, start: 0, length: 100, internal: false, cursorMode: false});
  assert.deepEqual(parse({min: '123.00000001', start: '20', length: '5', format: 'internal'}),
    {min: 12300000001n, start: 20, length: 5, internal: true, cursorMode: false});
  for (const value of ['0', '-1', '1.1', '1e1', '101', []]) assert.throws(() => parse({length: value}));
  for (const value of ['-1', '1.2', '2147483648']) assert.throws(() => parse({start: value}));
  for (const value of ['-1', 'NaN', '0.000000001']) assert.throws(() => parse({min: value}));
  assert.throws(() => parsePage({min: '0'}, {}, 0));
});

test('cursor pagination accepts a canonical position only in explicit public mode', () => {
  const row = {blockindex: 1110000, block_tx_index: 2};
  const cursor = encodeCursor(row);
  const parse = (query, params) => parsePage({min: '0', ...params}, query, 100);
  assert.equal(parse({cursor: ''}).after, null);
  assert.deepEqual(parse({cursor, limit: '10'}).after, row);
  for (const value of [cursor + '=', 'bad', [cursor], {key: cursor}, encodeCursor({...row, block_tx_index: -1})])
    assert.throws(() => parse({cursor: value}));
  assert.throws(() => parse({cursor, limit: '0'}));
  assert.throws(() => parse({cursor}, {start: '0'}));
  assert.throws(() => parse({cursor}, {format: 'internal'}));
});
