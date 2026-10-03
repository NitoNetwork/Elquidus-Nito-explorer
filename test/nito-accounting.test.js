'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const money = require('../lib/nito-amount');
const txlib = require('../lib/nito-transaction');
const {collector, validate} = require('../lib/nito-pools');
const fail = async () => { throw Error('RPC offline'); };
const output = value => ({value, n: 0, scriptPubKey: {address: 'transparent-test', type: 'witness_v0_keyhash'}});
const orchard = (balance, vin = [], vout = []) => ({txid: 'test', has_private_bundle: true,
  private_bundle: {actions: 2, value_balance: balance}, vin, vout, size: 9000});

test('RPC parser preserves the original amount lexemes, including beyond 2^53', () => {
  const result = money.parseJSON('{"chainValueNitoshi":128456588999999999,"value":1284565889.99999999,"height":42}');
  assert.equal(result.chainValueNitoshi, '128456588999999999');
  assert.equal(money.nitoshi(result.value).toString(), result.chainValueNitoshi);
  assert.equal(result.height, 42);
  assert.equal(money.coins(result.chainValueNitoshi), '1284565889.99999999');
  assert.throws(() => money.nitoshi(0.00000001));
  assert.throws(() => money.integer(9007199254740992));
  assert.throws(() => money.nitoshi('1284565890.00000001'));
  assert.throws(() => money.nitoshi('0.000000001'));
  assert.equal(money.nitoshi('-0.00000001'), -1n);
});

test('Orchard-to-Orchard publishes fees without recipients or transfer volume', async () => {
  const tx = await txlib.normalize(orchard('0.00001234'), fail);
  assert.equal(tx.fee_nitoshi, '1234');
  assert.equal(tx.orchard.pool_delta_nitoshi, '-1234');
  assert.deepEqual(tx.vin, []); assert.deepEqual(tx.vout, []);
  assert.equal(tx.total_scope, 'transparent_outputs'); assert.equal(tx.total, '0');
});

test('mixed inputs and outputs use input + signed value balance - output', async () => {
  const tx = await txlib.normalize(orchard('-2.00000000', [{prevout: output('4.00000000')}], [output('1.99999999')]), fail);
  assert.equal(tx.fee_nitoshi, '1'); assert.equal(tx.orchard.pool_delta_nitoshi, '200000000');
  assert.equal(tx.vout.length, 1); assert.equal(tx.vin.length, 1);
});

test('unshielding and a zero net mixed bundle retain exact fees', async () => {
  assert.equal((await txlib.normalize(orchard('1.00000001', [], [output('1.00000000')]), fail)).fee_nitoshi, '1');
  assert.equal((await txlib.normalize(orchard('0', [{prevout: output('2')}], [output('1.99999999')]), fail)).fee_nitoshi, '1');
});
test('maximum-range fees remain exact and contradictory RPC fees fail closed', async () => {
  const raw = orchard('0', [{prevout: output('1284565890.00000000')}], [output('1284565889.99999999')]);
  assert.equal((await txlib.normalize(raw, fail)).fee_nitoshi, '1');
  await assert.rejects(txlib.normalize({...raw, fee: '0.00000002'}, fail), /fee mismatch/);
  await assert.rejects(txlib.normalize(orchard('-1'), fail), /Invalid transaction fee/);
});

test('missing bundle or prevout stays incomplete; an independently known fee remains public', async () => {
  let tx = await txlib.normalize({has_private_bundle: true, vin: [], vout: []}, fail);
  assert.equal(tx.privacy, 'orchard'); assert.equal(tx.metadata_complete, false); assert.equal(tx.fee_nitoshi, null);
  tx = await txlib.normalize({...orchard('0', [{txid: 'missing', vout: 0}]), fee: '0.00000001'}, fail);
  assert.equal(tx.metadata_complete, false); assert.equal(tx.fee_nitoshi, '1');
  assert.equal(tx.transparent_input_nitoshi, null);
  tx = await txlib.normalize({vin: [], vout: []}, fail);
  assert.equal(tx.privacy, 'unknown'); assert.equal(tx.fee_nitoshi, null);
});

test('truncated, noncanonical and unsupported hex never proves transparency', () => {
  for (const hex of ['0200000000020000', '0200000000010000', '020000000008', '02000000fd000000', 'garbage', '', undefined]) {
    assert.equal(txlib.privacy({hex}), 'unknown');
  }
  const transparent = '0200000001' + '00'.repeat(36) + '00ffffffff0101000000000000000000000000';
  assert.equal(txlib.privacy({hex: transparent}), 'transparent');
  assert.equal(txlib.privacy({hex: transparent + '00'}), 'unknown');
  assert.equal(txlib.privacy({hex: transparent.slice(0, -2)}), 'unknown');
});

test('private receivers are never public addresses; legacy pseudo outputs are removed', () => {
  for (const address of ['nito1xanything', 'TN1XANYTHING', 'nrt1xanything', 'private_orchard']) assert.equal(txlib.privateAddress(address), true);
  const tx = txlib.publicRecord({vin: [], vout: [{addresses: 'private_orchard', amount: 123}], total: 123});
  assert.deepEqual(tx.vout, []); assert.equal(tx.total, null); assert.equal(tx.privacy, 'unknown');
});

const tip = {chain: 'regtest', blocks: 10, bestblockhash: 'a'.repeat(64)};
function pools() { return {...tip, orchard: {monitored: true, chainValueNitoshi: '1', chainValue: '0.00000001'},
  transparent: {monitored: true, chainValueNitoshi: '9007199254740992', chainValue: '90071992.54740992'},
  total: {monitored: true, chainValueNitoshi: '9007199254740993', chainValue: '90071992.54740993'}}; }
test('pool identity uses integers and rejects missing, inconsistent and cross-tip data', () => {
  assert.equal(validate(pools(), tip).total.chainValueNitoshi, '9007199254740993');
  assert.throws(() => validate(pools(), {...tip, chain: 'main'}));
  assert.throws(() => validate(pools(), {...tip, blocks: 11}));
  assert.throws(() => validate(pools(), {...tip, bestblockhash: 'b'.repeat(64)}));
  const invalid = pools(); delete invalid.orchard.chainValueNitoshi;
  assert.throws(() => validate(invalid, tip));
});
test('pool collection coalesces callers, caches per hash and never scans with an unsynced index', async () => {
  let calls = 0, current = {...tip}, synced = true;
  const collect = collector(async method => {
    if (method === 'getblockchaininfo') return current;
    if (method === 'getindexinfo') return {coinstatsindex: {synced, best_block_height: current.blocks}};
    calls++; return {...pools(), ...current};
  });
  await Promise.all(Array.from({length: 20}, () => collect()));
  await collect(); assert.equal(calls, 1);
  current = {...tip, bestblockhash: 'b'.repeat(64)}; await collect(); assert.equal(calls, 2);
  current = {...tip, blocks: 11}; synced = false;
  assert.equal((await collect()).status, 'unavailable'); assert.equal(calls, 2);
});
test('mid-collection reorgs and RPC outages invalidate the entire pool snapshot', async () => {
  let tips = 0;
  const collect = collector(async method => {
    if (method === 'getblockchaininfo') return ++tips === 1 ? tip : {...tip, bestblockhash: 'c'.repeat(64)};
    if (method === 'getindexinfo') return {coinstatsindex: {synced: true, best_block_height: 10}};
    return pools();
  });
  assert.equal((await collect()).status, 'unavailable');
  assert.equal((await collector(fail)()).status, 'unavailable');
});
