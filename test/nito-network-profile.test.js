'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const profile = require('../lib/network-profile');

const genesis = 'a'.repeat(64);
const base = {
  id: 'testnet', label: 'Testnet', enforce: true, expected_chain: 'test', expected_genesis: genesis,
  public_url: 'https://testnet-explorer.nito.network/', robots_noindex: true, allow_market_data: true,
  require_indexes: ['txindex', 'coinstatsindex'], require_synced: true, private_activation_height: 0,
  require_private_active: true, process_suffix: 'testnet', switch: {enabled: true, url: 'https://explorer.nito.network/', label: 'Mainnet'}
};

function database(state = {_id: 'NITO', schema_version: 2, chain: 'test', genesis}, populated) {
  let currentState = state;
  return {
    command: async () => ({setName: 'rs0'}),
    collection: name => ({
      findOne: async () => name === 'nito_state' ? currentState : populated === name ? {_id: 1} : null,
      updateOne: async (_filter, update) => {
        if (name === 'nito_state' && !currentState) currentState = update.$setOnInsert;
        return {acknowledged: true};
      }
    })
  };
}

function rpc(overrides = {}) {
  const values = {
    getblockchaininfo: {chain: 'test', blocks: 10, bestblockhash: 'b'.repeat(64), pruned: false,
      initialblockdownload: false, privateTxActivationHeight: 0, activated: true},
    getblockhash: genesis,
    getindexinfo: {txindex: {synced: true}, coinstatsindex: {synced: true}},
    ...overrides
  };
  return async method => values[method];
}

test('legacy default profile remains non-enforcing and validates redirect origins', async () => {
  assert.equal(profile.normalize().enforce, false);
  assert.equal((await profile.verify()).status, 'disabled');
  assert.throws(() => profile.normalize({...base, public_url: 'https://example.test/path'}), /without credentials, query, fragment or path/);
  assert.throws(() => profile.normalize({...base, switch: {...base.switch, url: 'https://user@example.test/'}}), /without credentials/);
  assert.throws(() => profile.normalize(base, {NITO_INSTANCE_ID: 'mainnet'}), /does not match/);
  assert.throws(() => profile.normalize({...base, require_indexes: ['txindex']}), /txindex and coinstatsindex/);
  assert.throws(() => profile.normalize({...base, private_activation_height: '0'}), /non-negative safe integer/);
});

test('enforced profile verifies Core, required indexes, replica set and Mongo identity', async () => {
  const result = await profile.verify({profile: base, environment: {NITO_INSTANCE_ID: 'testnet'}, database: database(), rpc: rpc(), coin: 'NITO'});
  assert.equal(result.status, 'verified');
  assert.equal(result.chain, 'test');
  assert.equal(result.genesis, genesis);
  const initialized = await profile.verify({profile: base, environment: {NITO_INSTANCE_ID: 'testnet'},
    database: database(null), rpc: rpc(), coin: 'NITO', initializeState: true});
  assert.deepEqual(initialized.state, {_id: 'NITO', schema_version: 2, chain: 'test', genesis, height: 0, hash: genesis});
});

test('enforced profile fails closed on network, activation, index and database mismatches', async () => {
  const options = {profile: base, environment: {NITO_INSTANCE_ID: 'testnet'}, database: database(), coin: 'NITO'};
  await assert.rejects(profile.verify({...options, rpc: rpc({getblockchaininfo: {...await rpc()('getblockchaininfo'), chain: 'main'}})}), /network mismatch/);
  await assert.rejects(profile.verify({...options, rpc: rpc({getblockhash: 'b'.repeat(64)})}), /genesis mismatch/);
  await assert.rejects(profile.verify({...options, rpc: rpc({getindexinfo: {txindex: {synced: true}}})}), /coinstatsindex is not enabled/);
  await assert.rejects(profile.verify({...options, rpc: rpc({getblockchaininfo: {...await rpc()('getblockchaininfo'), pruned: true}})}), /archival/);
  await assert.rejects(profile.verify({...options, rpc: rpc({getblockchaininfo: {...await rpc()('getblockchaininfo'), activated: false}})}), /does not report private/);
  await assert.rejects(profile.verify({...options, database: database(null, 'txes'), rpc: rpc()}), /contains chain data/);
  await assert.rejects(profile.verify({...options, database: database(null, 'coinstats'), rpc: rpc()}), /coinstats contains chain data/);
  await assert.rejects(profile.verify({...options, database: database({...await database().collection('nito_state').findOne(), chain: 'main'}), rpc: rpc()}), /does not match/);
  await assert.rejects(profile.verify({...options, database: {...database(), command: async () => ({})}, rpc: rpc()}), /replica set/);
});
