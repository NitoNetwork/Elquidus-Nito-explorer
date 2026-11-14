'use strict';

const { MAX_AGE_MS } = require('./market-state');

function value(input) {
  // These are approximate exchange valuations, never on-chain amount strings.
  if (input == null || (typeof input !== 'number' && typeof input !== 'string') || input === '') return null;
  const number = Number(input);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function success(price, usd, now = Date.now()) {
  const quote = value(price), dollars = value(usd);
  if (quote == null || dollars == null) throw new Error('Incomplete market price response');
  return { last_price: quote, last_usd_price: dollars, market_price_stale: false,
    market_price_last_success_at: now, market_price_last_attempt_at: now,
    market_price_error: null, markets_last_updated: Math.floor(now / 1000) };
}

function failure(error, now = Date.now()) {
  // Deliberately omit prices and the success timestamp: retain the last good data.
  return { market_price_stale: true, market_price_last_attempt_at: now,
    market_price_error: typeof error?.code === 'string' ? error.code : 'PROVIDER_ERROR' };
}

function read(stats, now = Date.now()) {
  const row = stats || {};
  const quote = value(row.last_price), usd = value(row.last_usd_price);
  const successAt = Number.isSafeInteger(row.market_price_last_success_at) && row.market_price_last_success_at > 0 ? row.market_price_last_success_at : null;
  const attemptAt = Number.isSafeInteger(row.market_price_last_attempt_at) && row.market_price_last_attempt_at > 0 ? row.market_price_last_attempt_at : null;
  const stale = row.market_price_stale === true || successAt == null || successAt > now || now - successAt > MAX_AGE_MS;
  return { last_price: quote, last_usd_price: usd, market_price: {
    status: quote == null && usd == null ? 'unavailable' : stale ? 'stale' : 'available',
    last_success_at: successAt, last_attempt_at: attemptAt,
    error: row.market_price_error || null, quote_available: quote != null,
    usd_available: usd != null, scope: 'approximate_market_valuation'
  } };
}

module.exports = { success, failure, read };
