'use strict';
const mongoose = require('mongoose');
const money = require('./nito-amount');
const txlib = require('./nito-transaction');
const node = require('./nito-rpc');
const settings = require('./settings');
const {decimal} = require('./nito-index');
const {encodeCursor, MAX_TIME_MS, ORDER, COUNT_INDEX} = require('./nito-latest-page');
const movementCount = require('./nito-movement-count');
const REVERSE_TX_ORDER = {blockindex: 1, block_tx_index: 1, txid: -1};
const collection = name => mongoose.connection.db.collection(name);
function plain(value) {
  if (value == null) return value;
  if (value._bsontype === 'Decimal128' || value._bsontype === 'Long') return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}
async function ready() { return !!await collection('nito_state').findOne({_id: settings.coin.name, schema_version: 2}); }
async function statsFromRecord(record) {
  const result = plain(record);
  if (!result) return null;
  Object.assign(result, require('./market-price-state').read(result));
  const pools = result.pools;
  result.supply = null; result.pools = null;
  result.supply_scope = 'confirmed_chain_value_including_immature';
  result.pool_status = 'unavailable';
  try {
    const tip = await node.rpc('getblockchaininfo');
    if (pools && result.schema_version === 2) {
      result.pools = await require('./nito-pools').validateCanonicalSnapshot(pools, tip, node.rpc);
      result.supply = result.pools.total.chainValue; result.pool_status = 'available';
    }
  } catch (_) { /* non-canonical or structurally incomplete snapshots remain unavailable */ }
  return result;
}
async function stats(coin) { return statsFromRecord(await collection('coinstats').findOne({coin})); }
async function updatedAt(coin, field) {
  const record = await collection('coinstats').findOne({coin}, {projection: {[field]: 1}, timeoutMS: MAX_TIME_MS});
  return record?.[field] ?? null;
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
let rankedAtTip;
async function rankedAddresses(state, session) {
  const key = state.chain + ':' + state.hash;
  const database = mongoose.connection.db;
  if (rankedAtTip?.database === database && rankedAtTip.key === key) return rankedAtTip.pending;
  const excluded = [...settings.richlist_page.burned_coins.addresses, 'coinbase', 'hidden_address', 'unknown_address', 'private_orchard'];
  const query = {a_id: {$nin: excluded, $not: /^(nito|tn|nrt)1x/i}};
  const pending = (async () => {
    const options = {session, timeoutMS: MAX_TIME_MS, projection: {_id: 0, a_id: 1, balance: 1, received: 1, sent: 1}};
    const addresses = collection('addresses');
    const balance = plain(await addresses.find(query, options).sort({balance: -1, a_id: 1}).limit(100).toArray());
    const received = plain(await addresses.find(query, options).sort({received: -1, a_id: 1}).limit(100).toArray());
    return {balance, received};
  })();
  rankedAtTip = {database, key, pending};
  try { return await pending; } catch (error) {
    if (rankedAtTip?.pending === pending) rankedAtTip = undefined;
    throw error;
  }
}
async function richlistAt(session, coin = settings.coin.name) {
  const state = await collection('nito_state').findOne({_id: coin, schema_version: 2}, {session, timeoutMS: MAX_TIME_MS});
  if (!state) return {balance: [], received: [], burned: '0', scope: 'transparent_addresses', status: 'unavailable'};
  const {balance, received} = await rankedAddresses(state, session);
  const ids = [...new Set([...balance, ...received].map(row => row.a_id))];
  // Labels can change without a new block. Keep them outside the rank cache.
  const claims = await collection('claimaddresses').find({a_id: {$in: ids}}, {session, timeoutMS: MAX_TIME_MS}).toArray();
  const names = new Map(claims.map(claim => [claim.a_id, typeof claim.claim_name === 'string' ? claim.claim_name : '']));
  const label = row => ({...row, claim_name: names.get(row.a_id) || ''});
  return {balance: balance.map(label), received: received.map(label),
    bestblockhash: state.hash, blocks: state.height, chain: state.chain,
    burned: '0', scope: 'transparent_addresses', status: 'available'};
}
async function richlist() {
  const session = mongoose.connection.getClient().startSession({snapshot: true});
  try {
    return await richlistAt(session);
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
async function richlistSnapshot(coin) {
  const session = mongoose.connection.getClient().startSession({snapshot: true});
  let snapshot;
  try {
    snapshot = {list: await richlistAt(session, coin),
      stats: await collection('coinstats').findOne({coin}, {session, timeoutMS: MAX_TIME_MS})};
  } finally { await session.endSession(); }
  const statistics = await statsFromRecord(snapshot.stats);
  return {richlist: snapshot.list, stats: statistics,
    distribution: distribution(snapshot.list, statistics)};
}
async function lastTransactions(options) {
  if (!options.internal && !options.after) return readLatestPage(options);
  // Keep the page and its count (or the two cursor ranges) on the same
  // committed chain view if indexing advances during the request.
  const session = mongoose.connection.getClient().startSession({snapshot: true});
  try {
    return await readLatestPage(options, session);
  } finally { await session.endSession(); }
}
async function readLatestPage({start, length, min, internal, cursorMode, after}, session) {
  // All V4 indexed transactions have nonnegative transparent output totals,
  // including Orchard-only transactions with zero transparent outputs.
  const query = min === 0n ? {schema_version: 2} : {schema_version: 2, total: {$gte: decimal(min)}};
  const txCollection = collection('txes');
  const deadline = performance.now() + MAX_TIME_MS;
  const readOptions = () => {
    const timeoutMS = Math.floor(deadline - performance.now());
    if (timeoutMS <= 0) throw new Error('Transaction page query budget expired');
    return {session, timeoutMS};
  };
  const find = (filter, limit, order = ORDER) => txCollection.find(filter, readOptions()).sort(order).limit(limit);
  let rows, count, nextCursor;

  if (cursorMode) {
    const target = length + 1;
    if (after) {
      // Seek within the current block and then into older blocks. Both queries
      // can use the ordered index without skipping earlier pages.
      rows = await find({...query, blockindex: after.blockindex, block_tx_index: {$lt: after.block_tx_index}}, target)
        .hint(ORDER).toArray();
      if (rows.length < target) {
        const older = await find({...query, blockindex: {$lt: after.blockindex}}, target - rows.length)
          .hint(ORDER).toArray();
        rows.push(...older);
      }
    } else {
      rows = await find(query, target).hint(ORDER).toArray();
    }
    const hasMore = rows.length > length;
    if (hasMore) rows.pop();
    nextCursor = hasMore ? encodeCursor(rows.at(-1)) : null;
  } else {
    if (internal) {
      if (min === 0n) {
        const stats = await collection('coinstats').findOne({coin: settings.coin.name, schema_version: 2},
          {...readOptions(), projection: {_id: 0, txes: 1}});
        if (!Number.isSafeInteger(stats?.txes) || stats.txes < 0)
          throw new Error('V4 transaction count unavailable');
        count = stats.txes;
      } else {
        if (min === movementCount.movementMinimum(settings.movement_page.movement_table.min_amount)) {
          const state = await collection('nito_state').findOne({_id: settings.coin.name, schema_version: 2},
            {...readOptions(), projection: {hash: 1, movement_count: 1}});
          count = movementCount.countAt(state, min);
        }
        if (count == null) count = await txCollection.countDocuments(query, {...readOptions(), hint: COUNT_INDEX});
      }
      const pageSize = Math.min(length, count - start);
      if (pageSize <= 0) return {txs: [], count};
      const reverseOffset = count - start - pageSize;
      // The numbered table can jump directly to its last page. Use the
      // shorter indexed scan while keeping its descending display order.
      if (reverseOffset < start) {
        rows = await find(query, pageSize, REVERSE_TX_ORDER).skip(reverseOffset).toArray();
        rows.reverse();
      } else {
        rows = await find(query, pageSize).skip(start).toArray();
      }
    } else {
      rows = await find(query, length).skip(start).toArray();
    }
  }

  return {txs: rows.map(tx => txlib.publicRecord(plain(tx))), count, nextCursor};
}
const ADDRESS_COUNT_CACHE_SIZE = 128;
let addressCountsAtTip;
async function addressCount(ledger, query, stateHash, options) {
  const database = mongoose.connection.db;
  if (addressCountsAtTip?.database !== database || addressCountsAtTip.hash !== stateHash)
    addressCountsAtTip = {database, hash: stateHash, counts: new Map()};
  const counts = addressCountsAtTip.counts;
  if (counts.has(query.a_id)) return counts.get(query.a_id);
  const pending = ledger.countDocuments(query, {...options, hint: {a_id: 1, txid: 1}});
  counts.set(query.a_id, pending);
  if (counts.size > ADDRESS_COUNT_CACHE_SIZE) counts.delete(counts.keys().next().value);
  try { return await pending; } catch (error) {
    if (counts.get(query.a_id) === pending) counts.delete(query.a_id);
    throw error;
  }
}
async function addressTransactions(hash, start, length, includeCount = false) {
  if (txlib.privateAddress(hash)) return {txs: [], count: 0};
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1)
    throw new Error('Invalid address pagination');
  if (/^(NITO|TN|NRT)1[A-Z0-9]+$/.test(hash)) hash = hash.toLowerCase();
  const session = mongoose.connection.getClient().startSession({snapshot: true});
  const deadline = performance.now() + MAX_TIME_MS;
  const options = () => {
    const timeoutMS = Math.floor(deadline - performance.now());
    if (timeoutMS <= 0) throw new Error('Address history query budget expired');
    return {session, timeoutMS};
  };
  try {
    const state = await collection('nito_state').findOne({_id: settings.coin.name, schema_version: 2},
      {...options(), projection: {hash: 1}});
    if (!state) return {txs: [], count: 0};
    const query = {a_id: hash};
    const account = await collection('addresses').findOne(query, {...options(), projection: {balance: 1}});
    if (!account) return {txs: [], count: 0};
    const ledger = collection('addresstxes');
    const count = includeCount ? await addressCount(ledger, query, state.hash, options()) : undefined;
    const pageSize = includeCount ? Math.min(length, count - start) : length;
    if (pageSize <= 0) return {txs: [], count};
    const tail = includeCount && count - start - pageSize < start ? count - start - pageSize : null;
    const rows = await ledger.find(query, options()).sort(tail == null ? ORDER : REVERSE_TX_ORDER)
      .skip(tail ?? start).limit(pageSize).toArray();
    if (!rows.length) return {txs: [], count};
    let balance = tail == null ? money.integer(account.balance.toString()) : 0n;
    const preceding = tail ?? start;
    if (preceding > 0) {
      const sums = await ledger.aggregate([{$match: query}, {$sort: tail == null ? ORDER : REVERSE_TX_ORDER}, {$limit: preceding},
        {$group: {_id: null, total: {$sum: '$amount'}}}], options()).toArray();
      if (sums.length) balance += (tail == null ? -1n : 1n) * money.integer(sums[0].total.toString());
    }
    if (tail != null) {
      // Older deltas plus this page give the balance at its newest row.
      for (const row of rows) balance += money.integer(row.amount.toString());
      rows.reverse();
    }
    const records = await collection('txes').find({txid: {$in: rows.map(row => row.txid)}}, options()).toArray();
    const byId = new Map(records.map(record => [record.txid, record]));
    const txs = [];
    for (const row of rows) {
      const tx = byId.get(row.txid);
      if (tx) txs.push({...txlib.publicRecord(plain(tx)), address_amount: row.amount.toString(), balance: balance.toString()});
      balance -= money.integer(row.amount.toString());
    }
    return {txs, count};
  } finally { await session.endSession(); }
}
module.exports = {stats, updatedAt, transaction, address, richlist, richlistSnapshot, distribution, lastTransactions, addressTransactions, plain};
