'use strict';

const http = require('node:http');
const poloniex = require('../lib/markets/poloniex');
const money = require('../lib/market-decimal');
const marketState = require('../lib/market-state');
const priceState = require('../lib/market-price-state');

describe('Poloniex market integration (local HTTP fixtures)', () => {
  let server, baseUrl, handler, calls;
  const now = 1794660000000;
  const book = { bids: ['0.000714', '9007199254740993.00000001'], asks: ['0.000725', '7.7'] };
  const trade = { price: '0.000714', quantity: '1.25', amount: '0.0008925', takerSide: 'BUY', ts: now, createTime: now - 1000 };
  const ticker = { symbol: 'LTC_BTC', high: '0.000730', low: '0.000600', quantity: '14.50000001',
    amount: '0.01', bid: '0.000714', ask: '0.000725', close: '0.000720', dailyChange: '-0.01001' };
  const candle = ['0.0006', '0.00073', '0.0007', '0.00072', '0.01', '14.5', '0', '0', 4,
    now, '0.00071', 'MINUTE_15', now - 900000, now - 1];

  function fixture(req, res) {
    res.setHeader('content-type', 'application/json');
    const path = new URL(req.url, 'http://localhost').pathname;
    res.end(JSON.stringify(path.endsWith('/orderBook') ? book : path.endsWith('/trades') ? [trade] :
      path.endsWith('/ticker24h') ? ticker : [candle]));
  }
  function collect(timeoutMs = 1000) {
    const client = poloniex.createClient({ baseUrl, timeoutMs, schedule: fn => fn(), now: () => now });
    return new Promise(resolve => client.get_data({ coin: 'ltc', exchange: 'btc' }, (error, result) => resolve({ error, result })));
  }

  beforeEach(async () => {
    calls = [];
    handler = fixture;
    server = http.createServer((req, res) => { calls.push(req.url); handler(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/markets/`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  it('preserves exact amounts, returns close as last, and charts candle start time', async () => {
    const { error, result } = await collect();
    expect(error).toBeNull();
    expect(result.buys[0].quantity).toBe('9007199254740993.00000001');
    expect(result.buys[0].total).toBe('6431140267885.06900200000714');
    expect(result.stats.last).toBe('0.000720');
    expect(result.stats.change).toBe('-1.00100');
    expect(result.trades[0].timestamp).toBe((now - 1000) / 1000);
    expect(result.chartdata[0]).toEqual([now - 900000, 0.0007, 0.00073, 0.0006, 0.00072]);
    expect(calls.length).toBe(4);
    expect(calls[1]).toContain('limit=200');
  });

  for (const status of [429, 500, 503]) {
    it(`rejects HTTP ${status}, even with a success-shaped body`, async () => {
      handler = (req, res) => { res.statusCode = status; fixture(req, res); };
      const { error, result } = await collect();
      expect(error.code).toBe('HTTP_' + status);
      expect(result).toBeNull();
      expect(calls.length).toBe(1);
    });
  }

  for (const body of ['not json', '{}', '{"message":"unavailable"}', '{"bids":["1"],"asks":[]}',
    '{"bids":["NaN","1"],"asks":[]}', '{"bids":[null,"1"],"asks":[]}', '{"bids":[1,"1"],"asks":[]}']) {
    it('rejects malformed/provider error response: ' + body, async () => {
      handler = (req, res) => { res.setHeader('content-type', 'application/json'); res.end(body); };
      const { error, result } = await collect();
      expect(error).toBeTruthy();
      expect(result).toBeNull();
      expect(calls.length).toBe(1);
    });
  }

  it('accepts a genuinely empty market without fabricating trades', async () => {
    handler = (req, res) => {
      if (req.url.includes('/orderBook')) res.end(JSON.stringify({ bids: [], asks: [] }));
      else if (req.url.includes('/trades') || req.url.includes('/candles')) res.end('[]');
      else fixture(req, res);
    };
    const { error, result } = await collect();
    expect(error).toBeNull();
    expect(result.trades).toEqual([]);
  });

  it('rejects partial success rather than publishing half a snapshot', async () => {
    handler = (req, res) => req.url.includes('/candles') ? res.end('[{}]') : fixture(req, res);
    const { error, result } = await collect();
    expect(error.code).toBe('INVALID_CANDLE');
    expect(result).toBeNull();
  });

  it('times out a server that never responds', async () => {
    handler = () => {};
    const { error, result } = await collect(80);
    expect(error.code).toBe('TIMEOUT');
    expect(result).toBeNull();
  });

  it('handles connection resets', async () => {
    handler = req => req.socket.destroy();
    const { error, result } = await collect();
    expect(error.code).toBe('NETWORK');
    expect(result).toBeNull();
  });

  it('uses explicit approximate price conversion and a true average, never string concatenation', () => {
    const quotes = [];
    money.addQuote(quotes, 'BTC', '0.1');
    money.addQuote(quotes, 'btc', '0.2');
    money.addQuote(quotes, 'BTC', '0.6');
    expect(quotes[0].last_price).toBeCloseTo(0.3, 12);
    expect(quotes[0].samples).toBe(3);
    expect(() => money.addQuote(quotes, 'BTC', null)).toThrow();
    expect(money.format('9007199254740993.00000001')).toBe('9,007,199,254,740,993.00000001');
    expect(money.format(1e-8)).toBe('0.00000001');
  });

  it('keeps the last good snapshot on failure, marks age and recovers after success', () => {
    const good = marketState.update({ chartdata: [], buys: book.bids, sells: [], trades: [], stats: ticker }, null, now);
    const failed = { ...good, ...marketState.update(null, Object.assign(new Error('failure'), { code: 'HTTP_500' }), now + 1) };
    expect(failed.summary).toEqual(ticker);
    expect(failed.last_success_at).toBe(now);
    expect(marketState.read(failed, now + 1).stale).toBeTrue();
    expect(marketState.read(good, now + marketState.MAX_AGE_MS + 1).stale).toBeTrue();
    expect(marketState.read(good, now + 1).stale).toBeFalse();
    expect(marketState.read({ summary: ticker }, now).stale).toBeTrue();
  });
});

describe('Market persistence contract', () => {
  const db = require('../lib/database');
  const Markets = require('../models/markets');
  it('retains prices on failed refresh, exposes stale state and replaces it after recovery', async () => {
    let stored = { summary: { last: '0.123456789123456789' }, last_success_at: Date.now() - 1000 };
    spyOn(Markets, 'updateOne').and.callFake((_query, update) => {
      stored = { ...stored, ...update.$set };
      return Promise.resolve({ modifiedCount: 1 });
    });
    const failure = Object.assign(new Error('HTTP failure'), { code: 'HTTP_500' });
    spyOn(poloniex, 'get_data').and.callFake((_settings, cb) => cb(failure, null));
    const refresh = () => new Promise(resolve => db.update_markets_db('poloniex', 'LTC', 'BTC', (error, last) => resolve({ error, last })));
    const failed = await refresh();
    expect(failed.error).toBe(failure);
    expect(failed.last).toBeNull();
    expect(stored.summary.last).toBe('0.123456789123456789');
    expect(stored.stale).toBeTrue();
    poloniex.get_data.and.callFake((_settings, cb) => cb(null, {
      stats: { last: '0.234567891234567891' }, buys: [], sells: [], trades: [], chartdata: []
    }));
    const recovered = await refresh();
    expect(recovered.error).toBeNull();
    expect(recovered.last).toBe('0.234567891234567891');
    expect(stored.summary.last).toBe(recovered.last);
    expect(stored.stale).toBeFalse();
    expect(stored.last_error).toBeNull();
  });
});

describe('Global market price freshness', () => {
  const now = 1794660000000;
  it('exposes absent, legacy zero and invalid prices as null rather than zero', () => {
    for (const row of [null, {}, {last_price: 0, last_usd_price: 0}, {last_price: NaN, last_usd_price: Infinity}]) {
      const result = priceState.read(row, now);
      expect(result.last_price).toBeNull();
      expect(result.last_usd_price).toBeNull();
      expect(result.market_price.status).toBe('unavailable');
    }
  });
  it('retains a failed quote as explicitly stale, marks old metadata and supports recovery', () => {
    const fresh = priceState.success('0.00000001', '0.01', now);
    expect(priceState.read(fresh, now + 1).market_price.status).toBe('available');
    const failed = {...fresh, ...priceState.failure({code: 'HTTP_503'}, now + 2)};
    const response = priceState.read(failed, now + 3);
    expect(response.last_price).toBe(0.00000001);
    expect(response.market_price.status).toBe('stale');
    expect(response.market_price.error).toBe('HTTP_503');
    expect(response.market_price.last_success_at).toBe(now);
    expect(priceState.read(fresh, now + marketState.MAX_AGE_MS + 1).market_price.status).toBe('stale');
    expect(priceState.read({last_price: 0.01}, now).market_price.status).toBe('stale');
    expect(priceState.read({...failed, ...priceState.success(0.02, 0.03, now + 4)}, now + 5).market_price.status).toBe('available');
  });
  it('refuses incomplete successful provider responses before writing freshness', () => {
    for (const values of [[null, 1], [1, null], [0, 1], [1, -1], [Infinity, 1]])
      expect(() => priceState.success(...values, now)).toThrow();
  });
});

describe('Coingecko quote dependency', () => {
  function client(status, body) {
    const source = require('node:fs').readFileSync(require.resolve('../lib/apis/coingecko'), 'utf8');
    const sandbox = { module: {exports: {}}, console,
      require(name) {
        if (name !== 'postman-request') throw new Error('Unexpected dependency');
        return (options, cb) => {
          expect(options.timeout).toBe(10000);
          cb(null, {statusCode: status}, body);
        };
      }
    };
    require('node:vm').runInNewContext(source, sandbox);
    return sandbox.module.exports;
  }
  it('does not accept a success-shaped quote body with HTTP 500', done => {
    client(500, {nito: {btc: 0.01, usd: 1}}).get_market_prices('nito', 'btc', '', (error, quote, usd) => {
      expect(error).toContain('HTTP error 500');
      expect(quote).toBeNull(); expect(usd).toBeNull(); done();
    });
  });
  it('rejects a malformed currency-list response before averaging', done => {
    client(200, {error: 'unavailable'}).get_coin_data('', (error, list) => {
      expect(error).toBeTruthy(); expect(list).toBeNull(); done();
    });
  });
  it('rejects partial conversion data instead of publishing a partial average', done => {
    client(200, {bitcoin: {btc: 1, usd: 100}}).get_avg_market_prices('bitcoin,ethereum', 'btc', [
      {currency: 'BTC', coingecko_id: 'bitcoin', last_price: 0.01},
      {currency: 'ETH', coingecko_id: 'ethereum', last_price: 0.1}
    ], '', (error, quote, usd) => {
      expect(error).toBe('Incomplete market price response');
      expect(quote).toBeNull(); expect(usd).toBeNull(); done();
    });
  });
  it('passes a complete positive quote for atomic freshness validation', done => {
    client(200, {nito: {btc: 0.01, usd: 1}}).get_market_prices('nito', 'btc', '', (error, quote, usd) => {
      expect(error).toBeNull();
      expect(priceState.success(quote, usd).last_price).toBe(0.01); done();
    });
  });
});
