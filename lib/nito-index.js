'use strict';
const {Decimal128} = require('mongodb');
const money = require('./nito-amount');
const txlib = require('./nito-transaction');
const decimal = value => Decimal128.fromString(String(value));

class Index {
  constructor(client, db, rpc, coin = 'Nito') {
    Object.assign(this, {client, db, rpc, coin});
  }
  async init() {
    const hello = await this.db.command({hello: 1});
    if (!hello.setName && hello.msg !== 'isdbgrid') throw Error('Atomic indexing requires a MongoDB replica set');
    const tip = await this.rpc('getblockchaininfo', []);
    if (tip.pruned) throw Error('Full explorer indexing requires an archival Core node');
    const indexes = await this.rpc('getindexinfo', []);
    if (!indexes.txindex || !indexes.txindex.synced) throw Error('A synchronized txindex is required');
    const genesis = await this.rpc('getblockhash', [0]);
    let state = await this.db.collection('nito_state').findOne({_id: this.coin});
    if (!state) {
      for (const name of ['txes', 'addresses', 'addresstxes']) {
        if (await this.db.collection(name).findOne({})) throw Error('Legacy index detected; rebuild in a new isolated database');
      }
      state = {_id: this.coin, schema_version: 2, chain: tip.chain, genesis, height: 0, hash: genesis};
      await this.db.collection('nito_state').insertOne(state);
    }
    if (state.schema_version !== 2 || state.chain !== tip.chain || state.genesis !== genesis) throw Error('Index network/schema mismatch');
    for (const name of ['txes', 'addresses', 'addresstxes', 'nito_blocks', 'nito_pools', 'coinstats', 'orphans']) {
      try { await this.db.createCollection(name); } catch (e) { if (e.code !== 48) throw e; }
    }
    await this.db.collection('txes').createIndex({txid: 1}, {unique: true});
    await this.db.collection('txes').createIndex({blockindex: -1, block_tx_index: -1, txid: 1});
    await this.db.collection('addresses').createIndex({a_id: 1}, {unique: true});
    await this.db.collection('addresses').createIndex({balance: -1});
    await this.db.collection('addresses').createIndex({received: -1});
    await this.db.collection('addresstxes').createIndex({a_id: 1, txid: 1}, {unique: true});
    await this.db.collection('addresstxes').createIndex({a_id: 1, blockindex: -1, block_tx_index: -1, txid: 1});
    await this.db.collection('nito_blocks').createIndex({height: 1}, {unique: true});
    return state;
  }
  async atomic(fn) {
    const session = this.client.startSession();
    try { return await session.withTransaction(() => fn(session), {readConcern: {level: 'snapshot'}, writeConcern: {w: 'majority'}}); }
    finally { await session.endSession(); }
  }
  async state(session) { return this.db.collection('nito_state').findOne({_id: this.coin}, {session}); }
  async addressEffects(tx, direction, session) {
    const grouped = new Map();
    for (const [field, rows] of [['sent', tx.vin], ['received', tx.vout]]) {
      for (const row of rows) {
        if (!row.addresses || row.addresses === 'coinbase' || txlib.privateAddress(row.addresses)) continue;
        const sums = grouped.get(row.addresses) || {sent: 0n, received: 0n};
        sums[field] += money.integer(row.amount); grouped.set(row.addresses, sums);
      }
    }
    for (const [address, sums] of grouped) {
      const net = sums.received - sums.sent;
      const inc = {sent: decimal(sums.sent * direction), received: decimal(sums.received * direction), balance: decimal(net * direction)};
      await this.db.collection('addresses').updateOne({a_id: address}, {$inc: inc}, {upsert: direction === 1n, session});
      if (direction === 1n) await this.db.collection('addresstxes').insertOne({a_id: address, txid: tx.txid,
        blockindex: tx.blockindex, block_tx_index: tx.block_tx_index, amount: decimal(net)}, {session});
    }
    if (direction === -1n) await this.db.collection('addresstxes').deleteMany({txid: tx.txid}, {session});
  }
  async connect(block, transactions, fault) {
    return this.atomic(async session => {
      const state = await this.state(session);
      if (state.hash === block.hash) return; // an acknowledged or retried block
      if (state.hash !== block.previousblockhash || state.height + 1 !== block.height) throw Error('Index tip changed; retry sync');
      for (const tx of transactions) {
        if (!tx.metadata_complete) throw Error('Incomplete transaction; index checkpoint not advanced');
        await this.addressEffects(tx, 1n, session);
        if (fault) await fault(tx);
        await this.db.collection('txes').insertOne({...tx, total: decimal(tx.total)}, {session});
      }
      await this.db.collection('nito_blocks').insertOne({_id: block.hash, height: block.height, previous: block.previousblockhash}, {session});
      await this.db.collection('orphans').deleteMany({orphan_blockhash: block.hash}, {session});
      await this.db.collection('orphans').updateMany({blockindex: block.height}, {$set: {good_blockhash: block.hash}}, {session});
      await this.db.collection('nito_state').updateOne({_id: this.coin, hash: state.hash}, {$set: {height: block.height, hash: block.hash}}, {session});
      await this.db.collection('coinstats').updateOne({coin: this.coin}, {$set: {last: block.height, count: block.height,
        schema_version: 2, supply: null, pools: null}, $inc: {txes: transactions.length}}, {upsert: true, session});
    });
  }
  async disconnect() {
    return this.atomic(async session => {
      const state = await this.state(session);
      if (!state.height) throw Error('Cannot disconnect genesis');
      const block = await this.db.collection('nito_blocks').findOne({_id: state.hash}, {session});
      if (!block) throw Error('Index checkpoint has no block');
      const txs = await this.db.collection('txes').find({blockhash: state.hash}, {session}).toArray();
      for (const tx of txs) await this.addressEffects(tx, -1n, session);
      await this.db.collection('txes').deleteMany({blockhash: state.hash}, {session});
      await this.db.collection('nito_blocks').deleteOne({_id: state.hash}, {session});
      await this.db.collection('nito_pools').deleteOne({_id: state.hash}, {session});
      await this.db.collection('orphans').updateOne({orphan_blockhash: state.hash}, {$set: {orphan_blockhash: state.hash,
        blockindex: state.height, prev_blockhash: block.previous, good_blockhash: null, next_blockhash: null}}, {upsert: true, session});
      await this.db.collection('nito_state').updateOne({_id: this.coin, hash: state.hash}, {$set: {height: state.height - 1, hash: block.previous}}, {session});
      await this.db.collection('coinstats').updateOne({coin: this.coin}, {$set: {last: state.height - 1, count: state.height - 1,
        supply: null, pools: null}, $inc: {txes: -txs.length}}, {session});
    });
  }
  async reconcile() {
    while (true) {
      const state = await this.state();
      const tip = await this.rpc('getblockchaininfo', []);
      if (tip.chain !== state.chain) throw Error('Core network changed');
      if (state.height <= tip.blocks && await this.rpc('getblockhash', [state.height]) === state.hash) return;
      await this.disconnect();
    }
  }
  async sync(collect, stopped = () => false) {
    await this.init();
    await this.reconcile();
    const target = await this.rpc('getblockcount', []);
    while (!stopped()) {
      const state = await this.state();
      if (state.height >= target) break;
      const hash = await this.rpc('getblockhash', [state.height + 1]);
      const block = await this.rpc('getblock', [hash, 3]);
      const txs = [];
      for (const raw of block.tx) txs.push({...await txlib.normalize(raw, this.rpc, block), block_tx_index: txs.length});
      if (await this.rpc('getblockhash', [block.height]) !== hash) { await this.reconcile(); continue; }
      await this.connect(block, txs);
    }
    await this.reconcile();
    const pools = await collect();
    await this.atomic(async session => {
      const state = await this.state(session);
      const valid = pools.status === 'available' && pools.chain === state.chain && pools.blocks === state.height && pools.bestblockhash === state.hash;
      await this.db.collection('coinstats').updateOne({coin: this.coin}, {$set: {schema_version: 2, last: state.height, count: state.height,
        supply: valid ? pools.total.chainValue : null,
        pools: valid ? pools : null, supply_scope: 'confirmed_chain_value_including_immature',
        blockchain_last_updated: Math.floor(Date.now() / 1000)}, $setOnInsert: {txes: 0}}, {upsert: true, session});
      if (valid) await this.db.collection('nito_pools').replaceOne({_id: state.hash}, {_id: state.hash, ...pools}, {upsert: true, session});
    });
    return this.state();
  }
}
module.exports = {Index, decimal};
