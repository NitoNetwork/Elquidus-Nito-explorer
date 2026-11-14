'use strict';
const request = require('postman-request');
const money = require('../market-decimal');
const rateLimit = new (require('../ratelimit').RateLimit)(1, 2000, false);
const market_url_template = 'https://poloniex.com/trade/{coin}_{base}?type=spot';

function failure(code) {
  return Object.assign(new Error('Poloniex market data unavailable (' + code + ')'), { code });
}

function decimal(value, signed = false) {
  if (typeof value !== 'string') throw failure('INVALID_DECIMAL_TYPE');
  return money.decimal(value, signed);
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('INVALID_TIMESTAMP');
  return value;
}

function createClient({ baseUrl = 'https://api.poloniex.com/markets/', timeoutMs = 10000,
                        schedule = fn => rateLimit.schedule(fn), now = Date.now } = {}) {
  function get(path) {
    return new Promise((resolve, reject) => schedule(() => {
      let completed = false;
      let req;
      const finish = (error, value) => {
        if (completed) return;
        completed = true;
        clearTimeout(deadline);
        if (error) reject(error); else resolve(value);
      };
      // An absolute deadline also bounds servers that keep streaming a partial body.
      const deadline = setTimeout(() => {
        finish(failure('TIMEOUT'));
        if (req) req.abort();
      }, timeoutMs);
      req = request({ uri: baseUrl + path, timeout: timeoutMs, json: true,
                      followRedirect: false, headers: { Accept: 'application/json' } }, (error, response, body) => {
        if (error) return finish(failure(/TIME/.test(error.code || '') ? 'TIMEOUT' : 'NETWORK'));
        if (!response || response.statusCode !== 200) return finish(failure('HTTP_' + (response?.statusCode || 'UNKNOWN')));
        if (!body || typeof body !== 'object' || body.message != null || body.code != null)
          return finish(failure('INVALID_RESPONSE'));
        finish(null, body);
      });
    }));
  }

  async function collect(settings) {
    const coin = String(settings.coin || '').toUpperCase();
    const exchange = String(settings.exchange || '').toUpperCase();
    if (!/^[A-Z0-9]+$/.test(coin) || !/^[A-Z0-9]+$/.test(exchange)) throw failure('INVALID_PAIR');
    const pair = coin + '_' + exchange;
    const book = await get(pair + '/orderBook?limit=50');
    function orders(values) {
      if (!Array.isArray(values) || values.length % 2) throw failure('INVALID_ORDER_BOOK');
      const result = [];
      for (let i = 0; i < values.length; i += 2) {
        const price = decimal(values[i]), quantity = decimal(values[i + 1]);
        result.push({ price, quantity, total: money.multiply(price, quantity) });
      }
      return result;
    }
    const buys = orders(book.bids), sells = orders(book.asks);
    const history = await get(pair + '/trades?limit=200');
    if (!Array.isArray(history)) throw failure('INVALID_TRADES');
    const trades = history.map(row => {
      if (!['BUY', 'SELL'].includes(row.takerSide)) throw failure('INVALID_TRADE_SIDE');
      return { ordertype: row.takerSide, price: decimal(row.price), quantity: decimal(row.quantity),
               total: decimal(row.amount), timestamp: Math.floor(timestamp(row.createTime ?? row.ts) / 1000) };
    });
    const ticker = await get(pair + '/ticker24h');
    if (ticker.symbol !== pair) throw failure('INVALID_SYMBOL');
    const stats = { high: decimal(ticker.high), low: decimal(ticker.low),
      volume: decimal(ticker.quantity), volume_btc: decimal(ticker.amount),
      bid: decimal(ticker.bid), ask: decimal(ticker.ask), last: decimal(ticker.close),
      change: money.multiply(decimal(ticker.dailyChange, true), '100') };
    const end = now();
    const candles = await get(pair + '/candles?interval=MINUTE_15&limit=96&startTime=' + (end - 86400000) + '&endTime=' + end);
    if (!Array.isArray(candles)) throw failure('INVALID_CANDLES');
    const chartdata = candles.map(row => {
      if (!Array.isArray(row) || row.length < 14) throw failure('INVALID_CANDLE');
      // Plot coordinates are explicitly approximate; source prices remain exact in tables.
      return [timestamp(row[12]), ...[2, 1, 0, 3].map(i => Number(decimal(row[i])))];
    }).sort((a, b) => a[0] - b[0]);
    return { buys, sells, trades, stats, chartdata };
  }

  return { get_data(settings, cb) {
    collect(settings).then(result => cb(null, result), error => cb(error.code ? error : failure('INVALID_DATA'), null));
  } };
}

module.exports = {
  market_name: 'Poloniex',
  market_logo: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAF8WlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNi4wLWMwMDIgNzkuMTY0NDYwLCAyMDIwLzA1LzEyLTE2OjA0OjE3ICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIiB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iIHhtbG5zOnBob3Rvc2hvcD0iaHR0cDovL25zLmFkb2JlLmNvbS9waG90b3Nob3AvMS4wLyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgMjEuMiAoV2luZG93cykiIHhtcDpDcmVhdGVEYXRlPSIyMDIwLTEyLTI1VDIwOjU1OjMzLTA3OjAwIiB4bXA6TWV0YWRhdGFEYXRlPSIyMDIwLTEyLTI1VDIwOjU1OjMzLTA3OjAwIiB4bXA6TW9kaWZ5RGF0ZT0iMjAyMC0xMi0yNVQyMDo1NTozMy0wNzowMCIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDphMzU0YTQ5My02M2VlLTQ3NDUtOTAyMC1jZjQ5ZTZlODRlNDQiIHhtcE1NOkRvY3VtZW50SUQ9ImFkb2JlOmRvY2lkOnBob3Rvc2hvcDowZTZlOTkxZi05YTM4LTgxNDAtYTlmMS0yMGU3MThjOTU5YjMiIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDplNzcwYmQ5Zi1kMzM2LTliNGQtYmVhMC0wOTIwNjZkNDIwZDIiIGRjOmZvcm1hdD0iaW1hZ2UvcG5nIiBwaG90b3Nob3A6Q29sb3JNb2RlPSIzIiBwaG90b3Nob3A6SUNDUHJvZmlsZT0ic1JHQiBJRUM2MTk2Ni0yLjEiPiA8eG1wTU06SGlzdG9yeT4gPHJkZjpTZXE+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJjcmVhdGVkIiBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOmU3NzBiZDlmLWQzMzYtOWI0ZC1iZWEwLTA5MjA2NmQ0MjBkMiIgc3RFdnQ6d2hlbj0iMjAyMC0xMi0yNVQyMDo1NTozMy0wNzowMCIgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUGhvdG9zaG9wIDIxLjIgKFdpbmRvd3MpIi8+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJzYXZlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDphMzU0YTQ5My02M2VlLTQ3NDUtOTAyMC1jZjQ5ZTZlODRlNDQiIHN0RXZ0OndoZW49IjIwMjAtMTItMjVUMjA6NTU6MzMtMDc6MDAiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCAyMS4yIChXaW5kb3dzKSIgc3RFdnQ6Y2hhbmdlZD0iLyIvPiA8L3JkZjpTZXE+IDwveG1wTU06SGlzdG9yeT4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz4yAdy4AAACnUlEQVQ4y11TS09TQRid9raFloIY45/wHUNijEsXBjeKC40r3Wrig7b0AS229AVIotISATdiSohuVJDYEkXjxsSFCQlEDSASdvIwo4BiheOZK1x6bTLp3PnOOd/3nZlPOJKpOVs8IUWDXwqPT4p6rxTBkHSn0tKWSEqNq5J7EQgy5iGGcV+DVBw7ucIajRX33exAW6GA8PM8EoURnM/1QzQ2wZVMoZJLhBpxNpdDYmQE4Xwe7fw/QI6NXLGLGXY0hTH2eQalvzM9PbAEgrAFQ6jr7jbFxme+oCocgeIKF8uzU2B/uhW/VlYM0PzCAjR/AO5IM1alNM5//1zFoXQbLKzQmUxJobEXVSr7w6X+flOm7KvX2Hndg8WlJePs8sAAsV5UkWNV3pWxDJoFZ0tcD7wZHzeJnLvTiaPxhL4fm5qElYlcxNJAKK5wbApUsAUX+zrIwOL3H4bAV5Zf4fHB+/ARau9264a6iVUcx5YAFwSzVDMgvD5cuN9nquLdh48QV67CwgS2VHqLbBawlAhc7HtgEng7MQGNAlokAjsF7PH/BOz8cLe2wklnD7e149vyskH+ND+Psmv1SAwOoa73HkQgpLegbQnoJipDoi3QmH1scsqU/TiFT9y6re8nZ2dRRkx5LLZtInuXbnWNvC7/00ETOfD4CXaTgLU148w/NKRfeTVbsahrZDnSzgdzKtMFrK8bwPdT0xStRzkf2cRMySvd2MDpbBds5FSoGXFFY3IPK0BJ33/4ImtS9ISuq1WTTqO4srotQuxechRXWCPNxWOZLDpGRxEaHkacg3Kyp5dzEEI5y3TSMAvnoZZnsXwBgWfDaH/xEkc6M9CabxQFQXMi1vJvTL2b49zYJFV52uY466XyTB9nhVFYZlfcv+GHou2DaH9cAAAAAElFTkSuQmCC',
  market_url_template,
  market_url_case: 'u',
  createClient,
  get_data: createClient().get_data
};
