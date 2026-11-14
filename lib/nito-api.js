'use strict';
const express = require('express');
const store = require('./nito-store');
const money = require('./nito-amount');
const {privateAddress} = require('./nito-transaction');
const settings = require('./settings');
const router = express.Router();
const run = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(() => res.status(503).json({error: 'Data unavailable'}));
const allowed = method => (req, res, next) => {
  if (!settings.api_page.enabled || !settings.api_page.public_apis.ext[method]?.enabled) return res.status(403).json({error: 'Method disabled'});
  next();
};

router.use((req, res, next) => {
  // Consumers must not silently interpret exact monetary strings as Numbers.
  if (req.path.startsWith('/ext/') || req.path.startsWith('/api/')) res.set('X-Nito-Amount-Format', 'decimal-string-v1');
  const parts = req.path.split('/').filter(Boolean);
  if (['address', 'claim', 'qr', 'getaddress', 'getbalance', 'getaddresstxs', 'getmasternoderewards', 'getmasternoderewardstotal'].includes(parts[parts[0] === 'ext' ? 1 : 0]) && privateAddress(parts[parts[0] === 'ext' ? 2 : 1]))
    return res.status(422).json({error: settings.localization.nito_private_address, scope: 'transparent_only'});
  next();
});
for (const method of ['getmasternoderewards', 'getmasternoderewardstotal']) {
  router.use('/ext/' + method, allowed(method), (req, res) => res.status(410).json({
    error: settings.localization.nito_unsupported_rewards, code: 'unsupported_nito_feature', replacement: '/ext/getaddresstxs/:address/:start/:length'
  }));
}
// The retained UTXO scan is an operator RPC, never a visitor-triggered endpoint.
router.use('/api/gettxoutsetinfo', (req, res) => res.status(403).json({error: 'Use the cached /ext/getorchardpools endpoint'}));
router.get('/ext/getorchardpools', allowed('getmoneysupply'), run(async (req, res) => {
  const stats = await store.stats(settings.coin.name);
  if (!stats?.pools) return res.status(503).json({status: 'unavailable', scope: 'confirmed_chain_value_including_immature'});
  res.json(stats.pools);
}));
router.get('/ext/getbasicstats', allowed('getbasicstats'), run(async (req, res) => {
  const stats = await store.stats(settings.coin.name);
  if (!stats) return res.status(503).json({error: 'Statistics unavailable'});
  const currency = require('./explorer').get_market_currency_code().toLowerCase();
  res.json({block_count: stats.count, money_supply: stats.supply,
    supply_scope: stats.supply_scope, pools: stats.pools,
    ['last_price_' + currency]: stats.last_price == null ? null : stats.last_price,
    last_price_usd: stats.last_usd_price == null ? null : stats.last_usd_price,
    market_price: stats.market_price});
}));
router.get('/ext/getmoneysupply', allowed('getmoneysupply'), run(async (req, res) => {
  const stats = await store.stats(settings.coin.name);
  res.set('X-Amount-Scope', 'confirmed-chain-value-including-immature');
  if (stats?.supply == null) return res.status(503).send('Unavailable');
  res.type('text').send(stats.supply);
}));
router.get('/ext/gettx/:txid', allowed('gettx'), run(async (req, res) => {
  const tx = await store.transaction(req.params.txid, /^[0-9a-f]{64}$/i.test(req.query.blockhash || '') ? req.query.blockhash : undefined);
  if (!tx) return res.status(503).json({error: 'Transaction unavailable'});
  res.json({active: 'tx', tx, confirmations: tx.confirmations, blockcount: null});
}));
router.get('/ext/getaddress/:hash', allowed('getaddress'), run(async (req, res) => {
  const address = await store.address(req.params.hash);
  if (!address) return res.status(404).json({error: 'Transparent address unavailable'});
  const {txs} = await store.addressTransactions(address.a_id, 0, settings.api_page.public_apis.ext.getaddresstxs.max_items_per_query);
  res.json({address: address.a_id, scope: 'transparent_address', sent: money.coins(address.sent), received: money.coins(address.received),
    balance: money.coins(address.balance), balance_nitoshi: address.balance,
    last_txs: txs.map(tx => ({addresses: tx.txid, type: BigInt(tx.address_amount) < 0n ? 'vin' : 'vout'}))});
}));
router.get('/ext/getbalance/:hash', allowed('getbalance'), run(async (req, res) => {
  const address = await store.address(req.params.hash);
  if (!address) return res.status(404).json({error: 'Transparent address unavailable'});
  res.set('X-Amount-Scope', 'transparent-address').type('text').send(money.coins(address.balance));
}));
router.get('/ext/getaddresstxs/:address/:start/:length/:internal?', run(async (req, res) => {
  const internal = req.params.internal === 'internal';
  if (!internal && (!settings.api_page.enabled || !settings.api_page.public_apis.ext.getaddresstxs.enabled)) return res.status(403).json({error: 'Method disabled'});
  const start = Math.max(0, Number.parseInt(req.params.start, 10) || 0);
  const length = Math.min(settings.api_page.public_apis.ext.getaddresstxs.max_items_per_query, Math.max(1, Number.parseInt(req.params.length, 10) || 10));
  const {txs, count} = await store.addressTransactions(req.params.address, start, length);
  const data = txs.map(tx => {
    const delta = BigInt(tx.address_amount);
    const received = money.coins(delta > 0n ? delta : 0n);
    const sent = money.coins(delta < 0n ? -delta : 0n);
    return internal ? [tx.timestamp, tx.txid, received, sent, money.coins(tx.balance)] : {
      timestamp: tx.timestamp, txid: tx.txid, sent, received, balance: money.coins(tx.balance),
      net_nitoshi: tx.address_amount, amount_scope: 'transparent_address_net', privacy: tx.privacy};
  });
  res.json(internal ? {data, recordsTotal: count, recordsFiltered: count} : data);
}));
module.exports = router;
