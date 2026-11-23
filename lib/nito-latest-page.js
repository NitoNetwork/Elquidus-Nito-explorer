'use strict';

const money = require('./nito-amount');
const MAX_OFFSET = 2147483647;
const MAX_TIME_MS = 2500;
const ORDER = Object.freeze({blockindex: -1, block_tx_index: -1, txid: 1});
const COUNT_INDEX = 'nito_v4_schema_total';

function pageInteger(value, min, max) {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) throw new Error('Invalid pagination');
  const number = Number(value);
  if (number < min || number > max) throw new Error('Invalid pagination');
  return number;
}

function encodeCursor(row) {
  return Buffer.from(row.blockindex + ':' + row.block_tx_index).toString('base64url');
}

function decodeCursor(value) {
  if (typeof value !== 'string' || !/^[\w-]{1,28}$/.test(value)) throw new Error('Invalid cursor');
  const text = Buffer.from(value, 'base64url').toString('utf8');
  const [height, position, extra] = text.split(':');
  if (extra !== undefined) throw new Error('Invalid cursor');
  const row = {blockindex: pageInteger(height, 0, MAX_OFFSET), block_tx_index: pageInteger(position, 0, MAX_OFFSET)};
  if (encodeCursor(row) !== value) throw new Error('Invalid cursor');
  return row;
}

function parsePage(params, query, maxItems) {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems >= MAX_OFFSET)
    throw new Error('Invalid page size configuration');
  const {min: rawMin, start, length, format} = params;
  if (typeof rawMin !== 'string' || rawMin.length > 32) throw new Error('Invalid amount filter');
  const min = money.nitoshi(rawMin);
  if (min < 0n) throw new Error('Invalid amount filter');
  if (format !== undefined && format !== 'internal') throw new Error('Invalid response format');
  const internal = format === 'internal';
  const cursorMode = query.cursor !== undefined;

  if (cursorMode) {
    if (internal || start !== undefined || length !== undefined) throw new Error('Cursor requires the public list path');
    return {min, length: query.limit === undefined ? maxItems : pageInteger(query.limit, 1, maxItems),
      internal, cursorMode, after: query.cursor === '' ? null : decodeCursor(query.cursor)};
  }
  return {min, start: start === undefined ? 0 : pageInteger(start, 0, MAX_OFFSET),
    length: length === undefined ? maxItems : pageInteger(length, 1, maxItems), internal, cursorMode};
}

module.exports = {parsePage, encodeCursor, MAX_TIME_MS, ORDER, COUNT_INDEX};
