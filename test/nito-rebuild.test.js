'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {Index} = require('../lib/nito-index');
const {inventory, inventoryPreserved, rebuild, verifyCanonicalCheckpoint} = require('../lib/nito-rebuild');

function rows(values) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield value;
    }
  };
}

function cursor(values) {
  const iterable = rows(values);
  iterable.sort = () => iterable;
  return iterable;
}

function sourceDatabase(values, events = null) {
  return {
    listCollections() {
      if (events) events.push('source-inventory');
      return {toArray: async () => [{name: 'txes'}]};
    },
    collection(name) {
      return {
        find() { return cursor(name === 'txes' ? values : []); },
        listIndexes() { return {toArray: async () => [{name: '_id_', key: {_id: 1}}]}; }
      };
    }
  };
}

test('target verification inventories only expected legacy archives', async () => {
  const visited = [];
  const db = {
    listCollections() {
      return {toArray: async () => [
        {name: 'txes'},
        {name: 'addresses'},
        {name: 'nito_blocks'},
        {name: 'legacy_archive_networkhistories'}
      ]};
    },
    collection(name) {
      return {
        find() {
          visited.push(name);
          if (name !== 'legacy_archive_networkhistories')
            throw new Error(`Derived target collection was inventoried: ${name}`);
          return {sort: () => rows([{_id: 1, blockindex: 10, supply: 999}])};
        },
        listIndexes() {
          return {toArray: async () => [{name: '_id_', key: {_id: 1}}]};
        }
      };
    }
  };

  const result = await inventoryPreserved(db, {
    networkhistories: {destination: 'legacy_archive_networkhistories'}
  });

  assert.deepEqual(Object.keys(result), ['legacy_archive_networkhistories']);
  assert.deepEqual(visited, ['legacy_archive_networkhistories']);
  assert.equal(result.legacy_archive_networkhistories.count, 1);
});

test('an advanced Core tip accepts a reconstruction checkpoint that remains canonical', async () => {
  const state = {chain: 'main', height: 100, hash: 'a'.repeat(64)};
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'getblockchaininfo')
      return {chain: 'main', blocks: 112, bestblockhash: 'b'.repeat(64)};
    if (method === 'getblockhash') return state.hash;
    throw new Error(`Unexpected RPC method: ${method}`);
  };

  const tip = await verifyCanonicalCheckpoint(rpc, state);
  assert.equal(tip.blocks, 112);
  assert.deepEqual(calls, [
    ['getblockchaininfo', []],
    ['getblockhash', [100]]
  ]);
});

test('a reconstruction checkpoint displaced by a reorganization is refused', async () => {
  const state = {chain: 'main', height: 100, hash: 'a'.repeat(64)};
  const rpc = async method => method === 'getblockchaininfo'
    ? {chain: 'main', blocks: 112, bestblockhash: 'b'.repeat(64)}
    : 'c'.repeat(64);

  await assert.rejects(verifyCanonicalCheckpoint(rpc, state), /no longer canonical/);
});

test('a checkpoint outside the current chain identity or height is refused', async () => {
  const state = {chain: 'main', height: 100, hash: 'a'.repeat(64)};
  await assert.rejects(
    verifyCanonicalCheckpoint(async () => ({chain: 'test', blocks: 112}), state),
    /no longer contains/
  );
  await assert.rejects(
    verifyCanonicalCheckpoint(async () => ({chain: 'main', blocks: 99}), state),
    /no longer contains/
  );
});

test('resume synchronizes before its single full source check and still detects source changes', async () => {
  const originalInventory = await inventory(sourceDatabase([{_id: 1, txid: 'original'}]));
  const events = [];
  const sourceDb = sourceDatabase([{_id: 1, txid: 'modified'}], events);
  const state = {chain: 'main', height: 100, hash: 'a'.repeat(64)};
  const targetDb = {
    listCollections() {
      return {toArray: async () => [{name: 'nito_rebuild'}, {name: 'coinstats'}]};
    },
    collection(name) {
      if (name === 'nito_rebuild') return {
        findOne: async () => ({_id: 'migration', source: 'historical', source_inventory: originalInventory}),
        updateOne: async () => {}
      };
      if (name === 'coinstats') return {
        findOne: async () => ({coin: 'Nito', pools: {
          status: 'available', chain: state.chain, blocks: state.height, bestblockhash: state.hash
        }})
      };
      if (name === 'claimaddresses') return {createIndex: async () => {}};
      throw new Error(`Unexpected target collection: ${name}`);
    }
  };
  const client = {db: name => name === 'historical' ? sourceDb : targetDb};
  const originalSync = Index.prototype.sync;
  Index.prototype.sync = async function() {
    events.push('sync');
    return state;
  };

  try {
    await assert.rejects(rebuild({
      client,
      source: 'historical',
      target: 'rebuilt',
      rpc: async () => { throw new Error('RPC must not be reached after a changed source is detected'); },
      collect: async () => { throw new Error('collect is stubbed by Index.sync'); },
      resume: true
    }), /Source changed during reconstruction/);
  } finally {
    Index.prototype.sync = originalSync;
  }

  assert.deepEqual(events, ['sync', 'source-inventory']);
});
