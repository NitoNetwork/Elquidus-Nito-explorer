'use strict';

const assert = require('node:assert/strict');
const {once} = require('node:events');
const test = require('node:test');
const express = require('express');
const db = require('../lib/database');
const explorer = require('../lib/explorer');
const settings = require('../lib/settings');
const routes = require('../routes');

test('the search form resolves indexed addresses, hashes and block heights', async t => {
  const mainnetTaproot = 'nito1p7rth7m3arys96wuw4xkx895xqv93h0rvfrjrs5lau7rds787sw7smzzha3';
  const testnetTaproot = 'tn1p84kutzcn23zwre2nl6903h3jcd2hsca38v6mmnd3j72tvkkz9r3sd7t8ce';
  const mainnetWitnessV0 = 'nito1q' + 'p'.repeat(58);
  const base58 = '1C2BhS55PLDjjwhUJQ9ctKuXp1JD2qhh4H';
  const addresses = new Set([mainnetTaproot, testnetTaproot, mainnetWitnessV0, base58]);
  const blockHash = 'b'.repeat(64);
  const indexedTxid = 'a'.repeat(64);
  const walletTxid = 'c'.repeat(64);

  t.mock.method(db, 'get_address', (query, _caseSensitive, cb) =>
    cb(addresses.has(query) ? {a_id: query} : null));
  t.mock.method(db, 'get_tx', (query, cb) => cb(query === indexedTxid ? {txid: query} : null));
  t.mock.method(explorer, 'get_block', (query, cb) => cb(query === blockHash ? {height: 42} : null));
  t.mock.method(explorer, 'get_rawtransaction', (query, cb) => cb(query === walletTxid ? {txid: query} : null));
  t.mock.method(explorer, 'get_blockhash', (query, cb) => {
    assert.equal(query, '42');
    cb(blockHash);
  });
  t.mock.method(db, 'get_updated_at', (_coin, _field, cb) => cb(null));

  const app = express();
  app.use(express.urlencoded({extended: true}));
  app.use((_req, res, next) => {
    res.render = (view, locals) => res.json({view, error: locals.error});
    next();
  });
  app.use(routes);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  const searchUrl = 'http://127.0.0.1:' + server.address().port + '/search';
  const post = body => fetch(searchUrl, {method: 'POST', body: new URLSearchParams(body), redirect: 'manual'});

  for (const [query, location] of [
    ...Array.from(addresses, address => [' ' + address + ' ', '/address/' + address]),
    [indexedTxid, '/tx/' + indexedTxid],
    [walletTxid, '/tx/' + walletTxid],
    [blockHash.toUpperCase(), '/block/' + blockHash],
    [settings.transaction_page.genesis_tx, '/block/' + settings.block_page.genesis_block],
    ['42', '/block/' + blockHash]
  ]) {
    const response = await post({search: query});
    assert.equal(response.status, 302, query);
    assert.equal(response.headers.get('location'), location, query);
  }

  for (const body of [{search: '42-invalid'}, {'search[]': '42'}, {}]) {
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).view, 'index');
  }
});
