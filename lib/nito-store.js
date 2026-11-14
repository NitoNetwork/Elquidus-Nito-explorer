'use strict';
const mongoose = require('mongoose');
const money = require('./nito-amount');
const txlib = require('./nito-transaction');
const node = require('./nito-rpc');
const settings = require('./settings');
const {decimal} = require('./nito-index');
const collection = name => mongoose.connection.db.collection(name);
function plain(value) {
  if (value == null) return value;
  if (value._bsontype === 'Decimal128' || value._bsontype === 'Long') return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}
async function ready() { return !!await collection('nito_state').findOne({_id: settings.coin.name, schema_version: 2}); }
async function stats(coin) {
  const result = plain(await collection('coinstats').findOne({coin}));
  if (!result) return null;
  Object.assign(result, require('./market-price-state').read(result));
  const pools = result.pools;
  result.supply = null; result.pools = null;
  result.supply_scope = 'confirmed_chain_value_including_immature';
  result.pool_status = 'unavailable';
  try {
    const tip = await node.rpc('getblockchaininfo');
    if (pools && result.schema_version === 2 && pools.chain === tip.chain && pools.blocks === tip.blocks && pools.bestblockhash === tip.bestblockhash) {
      result.pools = require('./nito-pools').validate({...pools,
        transparent: {...pools.transparent, monitored: true}, orchard: {...pools.orchard, monitored: true},
        total: {...pools.total, monitored: true}}, tip);
      result.supply = result.pools.total.chainValue; result.pool_status = 'available';
    }
  } catch (_) { /* retained snapshots must not masquerade as current */ }
  return result;
}
async function transaction(txid, blockhash) {
  const stored = await collection('txes').findOne({txid});
  let block = null;
  try {
    const hash = blockhash || (stored && stored.blockhash);
    if (hash) block = await node.rpc('getblockheader', [hash]);
    const raw = await node.rpc('getrawtransaction', hash ? [txid, true, hash] : [txid, true]);
    if (!block && raw.blockhash) block = await node.rpc('getblockheader', [raw.blockhash]);
    return await txlib.normalize(raw, node.rpc, block);
  } catch (_) {
    if (!stored) return null;
    const result = txlib.publicRecord(plain(stored));
    result.confirmations = block ? block.confirmations : null;
    result.chain_status = block ? (block.confirmations < 0 ? 'orphan' : 'confirmed') : 'unavailable';
    return result;
  }
}
async function address(hash) {
  if (txlib.privateAddress(hash) || !await ready()) return null;
  // Base58 is case sensitive. Normalize only valid all-uppercase Bech32 strings.
  if (/^(NITO|TN|NRT)1[A-Z0-9]+$/.test(hash)) hash = hash.toLowerCase();
  return plain(await collection('addresses').findOne({a_id: hash}));
}
async function richlist() {
  if (!await ready()) return {balance: [], received: [], burned: '0', scope: 'transparent_addresses', status: 'unavailable'};
  const excluded = [...settings.richlist_page.burned_coins.addresses, 'coinbase', 'hidden_address', 'unknown_address', 'private_orchard'];
  const query = {a_id: {$nin: excluded, $not: /^(nito|tn|nrt)1x/i}};
  const session = mongoose.connection.getClient().startSession();
  try {
    return await session.withTransaction(async () => {
      const state = await collection('nito_state').findOne({_id: settings.coin.name}, {session});
      const balance = plain(await collection('addresses').find(query, {session}).sort({balance: -1, a_id: 1}).limit(100).toArray());
      const received = plain(await collection('addresses').find(query, {session}).sort({received: -1, a_id: 1}).limit(100).toArray());
      const ids = [...new Set([...balance, ...received].map(row => row.a_id))];
      const claims = await collection('claimaddresses').find({a_id: {$in: ids}}, {session}).toArray();
      const names = new Map(claims.map(claim => [claim.a_id, typeof claim.claim_name === 'string' ? claim.claim_name : '']));
      for (const row of [...balance, ...received]) row.claim_name = names.get(row.a_id) || '';
      return {balance, received,
        bestblockhash: state.hash, blocks: state.height, chain: state.chain,
        burned: '0', scope: 'transparent_addresses', status: 'available'};
    }, {readConcern: {level: 'snapshot'}});
  } finally { await session.endSession(); }
}
function distribution(list, statistics) {
  let pools = statistics && statistics.pools;
  if (pools && (pools.bestblockhash !== list.bestblockhash || pools.blocks !== list.blocks || pools.chain !== list.chain)) {
    statistics.pools = null; pools = null;
  }
  const denominator = pools ? pools.transparent.chainValueNitoshi : null;
  const result = {scope: 'transparent_utxo', denominator_nitoshi: denominator,
    bestblockhash: pools && pools.bestblockhash, blocks: pools && pools.blocks,
    supply: denominator == null ? null : money.coins(denominator)};
  const sums = [0n, 0n, 0n, 0n];
  (list.balance || []).forEach((a, i) => { if (i < 100) sums[Math.floor(i / 25)] += money.integer(a.balance); });
  const remainder = denominator == null ? null : money.integer(denominator) - sums.reduce((a, b) => a + b, 0n);
  // The rest includes other transparent scripts, not Orchard or identifiable owners.
  [...sums, remainder].forEach((amount, i) => {
    const key = ['t_1_25', 't_26_50', 't_51_75', 't_76_100', 't_101plus'][i];
    result[key] = {total: denominator == null || amount == null ? null : money.coins(amount),
      percent: denominator == null || amount == null ? null : money.percent(amount, denominator)};
  });
  return result;
}
async function lastTransactions(start, length, min) {
  const query = {schema_version: 2, total: {$gte: decimal(money.integer(String(min || 0)))}};
  const txs = await collection('txes').find(query).sort({blockindex: -1, block_tx_index: -1, txid: 1}).skip(Number(start)).limit(Number(length)).toArray();
  return {txs: txs.map(tx => txlib.publicRecord(plain(tx))), count: await collection('txes').countDocuments(query)};
}
async function addressTransactions(hash, start, length) {
  if (txlib.privateAddress(hash) || !await ready()) return {txs: [], count: 0};
  const session = mongoose.connection.getClient().startSession();
  try {
    return await session.withTransaction(async () => {
      const order = {blockindex: -1, block_tx_index: -1, txid: 1};
      const sums = await collection('addresstxes').aggregate([{$match: {a_id: hash}}, {$sort: order},
        {$skip: Number(start)}, {$group: {_id: null, total: {$sum: '$amount'}}}], {session}).toArray();
      let balance = sums.length ? money.integer(sums[0].total) : 0n;
      const rows = await collection('addresstxes').find({a_id: hash}, {session}).sort(order).skip(Number(start)).limit(Number(length)).toArray();
      const txs = [];
      for (const row of rows) {
        const tx = await collection('txes').findOne({txid: row.txid}, {session});
        if (tx) txs.push({...txlib.publicRecord(plain(tx)), address_amount: String(row.amount), balance: balance.toString()});
        balance -= money.integer(row.amount);
      }
      return {txs, count: await collection('addresstxes').countDocuments({a_id: hash}, {session})};
    }, {readConcern: {level: 'snapshot'}});
  } finally { await session.endSession(); }
}
module.exports = {stats, transaction, address, richlist, distribution, lastTransactions, addressTransactions, plain};
