'use strict';

const MAX_AGE_MS = 30 * 60 * 1000;

function update(result, error, now = Date.now()) {
  if (error) return { last_attempt_at: now, last_error: String(error.code || 'PROVIDER_ERROR'), stale: true };
  return { chartdata: JSON.stringify(result.chartdata), buys: result.buys, sells: result.sells,
    history: result.trades, summary: result.stats, last_success_at: now, last_attempt_at: now,
    last_error: null, stale: false };
}

function read(row, now = Date.now()) {
  if (!row) return null;
  const data = row.toObject ? row.toObject() : { ...row };
  data.stale = data.stale === true || !data.last_success_at || now - data.last_success_at > MAX_AGE_MS;
  return data;
}

module.exports = { update, read, MAX_AGE_MS };
