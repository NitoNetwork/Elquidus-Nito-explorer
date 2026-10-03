'use strict';

// RPC JSON must be parsed before JavaScript can round monetary literals.
const MONEY_KEYS = new Set(['value', 'value_balance', 'fee', 'chainValue',
  'chainValueNitoshi', 'total_amount', 'total_unspendable_amount']);
const COIN = 100000000n;
const MAX_MONEY = 128456589000000000n;

function parseJSON(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && (MONEY_KEYS.has(key) || !Number.isSafeInteger(value))) {
      if (!context || !context.source) throw new Error('Node.js 22 or later is required for lossless RPC JSON');
      return context.source;
    }
    return value;
  });
}

function integer(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe integer');
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new Error('Invalid integer amount');
  return BigInt(text);
}

function nitoshi(value) {
  // Numeric inputs are accepted only when integral: fractions must retain their RPC lexeme.
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Lossy coin amount');
  const match = /^(-?)(\d+)(?:\.(\d{1,8}))?$/.exec(String(value));
  if (!match) throw new Error('Invalid coin amount');
  const amount = (BigInt(match[2]) * COIN + BigInt((match[3] || '').padEnd(8, '0'))) * (match[1] ? -1n : 1n);
  if (amount < -MAX_MONEY || amount > MAX_MONEY) throw new Error('Amount outside Nito money range');
  return amount;
}

function coins(value) {
  const amount = integer(value);
  const abs = amount < 0n ? -amount : amount;
  return (amount < 0n ? '-' : '') + (abs / COIN) + '.' + (abs % COIN).toString().padStart(8, '0');
}

function percent(value, total) {
  const denominator = integer(total);
  if (denominator <= 0n) return null;
  const hundredths = (integer(value) * 10000n + denominator / 2n) / denominator;
  return (hundredths / 100n) + '.' + (hundredths % 100n).toString().padStart(2, '0');
}

module.exports = {parseJSON, integer, nitoshi, coins, percent, COIN, MAX_MONEY};
