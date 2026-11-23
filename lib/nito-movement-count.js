'use strict';

const money = require('./nito-amount');

function movementMinimum(coins) {
  try {
    const minimum = money.nitoshi(String(coins));
    return minimum > 0n ? minimum : null;
  } catch (_) {
    return null;
  }
}

function countAt(state, minimum) {
  if (minimum == null) return null;
  const saved = state?.movement_count;
  return saved && saved.hash === state.hash && saved.minimum === minimum.toString() &&
    Number.isSafeInteger(saved.count) && saved.count >= 0 ? saved.count : null;
}

function afterBlock(state, hash, transactions, direction) {
  const saved = state.movement_count;
  if (typeof saved?.minimum !== 'string' || !/^\d{1,18}$/.test(saved.minimum)) return {};
  const minimum = money.integer(saved.minimum);
  const before = countAt(state, minimum);
  if (before == null) return {};
  const matches = transactions.reduce((count, tx) => count + Number(money.integer(tx.total.toString()) >= minimum), 0);
  const count = before + direction * matches;
  // Leave the previous hash in place on inconsistency. Readers fall back and
  // the next sync rebuilds the counter instead of using an invalid value.
  if (!Number.isSafeInteger(count) || count < 0) return {};
  return {movement_count: {hash, minimum: saved.minimum, count}};
}

module.exports = {movementMinimum, countAt, afterBlock};
