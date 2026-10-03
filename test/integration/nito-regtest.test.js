'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {MongoClient} = require('mongodb');
const {Client} = require('../../lib/node');
const {Index} = require('../../lib/nito-index');
const txlib = require('../../lib/nito-transaction');
const money = require('../../lib/nito-amount');
const {collector} = require('../../lib/nito-pools');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function until(fn, timeout = 60000) { const deadline = Date.now() + timeout; let error; while (Date.now() < deadline) { try { const v = await fn(); if (v) return v; } catch (e) { error = e; } await delay(200); } throw error || Error('Wait timed out'); }

test('real Core regtest, exact Mongo indexing, HTTP and recovery', {timeout: 900000}, async t => {
  assert.ok(process.env.NITO_DAEMON, 'Set NITO_DAEMON to the tested Core executable');
  const {MongoMemoryReplSet} = require(process.env.NITO_TEST_TOOLS ? path.join(process.env.NITO_TEST_TOOLS, 'node_modules/mongodb-memory-server') : 'mongodb-memory-server');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nito-explorer-regtest-'));
  process.env.NITO_SETTINGS_PATH = path.join(temp, 'isolated-settings.json');
  const cfg = {host: '127.0.0.1', port: await port(), username: 'regtest', password: randomBytes(24).toString('hex'), timeout: 240000};
  const client = new Client(cfg);
  const rpc = (method, params = []) => new Promise((resolve, reject) => client.cmd(method, ...params, (err, value) => err ? reject(err) : resolve(value)));
  let daemon, mongo, conn, httpServer;
  const start = async () => {
    daemon = spawn(process.env.NITO_DAEMON, [`-datadir=${temp}`, '-regtest', '-server=1', '-listen=0', '-connect=0',
      '-txindex=1', '-coinstatsindex=1', '-orchardindex=1', '-privateactivationheight=105', '-fallbackfee=0.0001',
      `-rpcport=${cfg.port}`, '-rpcbind=127.0.0.1', `-rpcuser=${cfg.username}`, `-rpcpassword=${cfg.password}`], {windowsHide: true, stdio: 'ignore'});
    await until(() => rpc('getblockchaininfo'), 90000);
  };
  const stop = async () => {
    if (daemon && daemon.exitCode == null) { await rpc('stop'); await until(() => daemon.exitCode != null, 60000); }
  };
  t.after(async () => {
    if (httpServer) await new Promise(r => httpServer.close(r));
    await require('mongoose').disconnect();
    if (conn) await conn.close();
    if (mongo) await mongo.stop();
    await stop();
    console.log('Regtest evidence directory:', temp);
  });
  await start();
  await rpc('createwallet', ['explorer-test']);
  const miner = await rpc('getnewaddress');
  async function mine(count = 1) {
    const target = await rpc('getblockcount') + count;
    while (await rpc('getblockcount') < target) await rpc('generatetoaddress', [target - await rpc('getblockcount'), miner, 10000000]);
    await until(async () => { const i = (await rpc('getindexinfo')).coinstatsindex; return i?.synced && i.best_block_height === target; });
    return rpc('getbestblockhash');
  }
  const collect = collector(rpc);
  const genesisPools = await until(async () => { const p = await collect(); return p.status === 'available' ? p : false; });
  assert.equal(genesisPools.activated, false);
  const pubkey = (await rpc('getaddressinfo', [miner])).pubkey;
  const p2pkDescriptor = await rpc('getdescriptorinfo', ['pk(' + pubkey + ')']);
  while (await rpc('getblockcount') < 1) await rpc('generatetodescriptor', [1, p2pkDescriptor.descriptor, 10000000]);
  const p2pkBlock = await rpc('getblock', [await rpc('getblockhash', [1]), 3]);
  const p2pkTx = await txlib.normalize(p2pkBlock.tx[0], rpc, p2pkBlock);
  assert.equal(p2pkTx.vout[0].address_kind, 'p2pk_public_key_alias');
  assert.ok(p2pkTx.vout[0].addresses);
  await mine(100);
  assert.equal((await collect()).activated, false);
  await mine(4);
  assert.equal((await collect()).activated, true);
  const transparent = await rpc('getnewaddress');
  const privateReceiver = await rpc('getnewaddress', ['', 'bech32x']);
  const cases = {};
  async function send(name, method, params) {
    const id = await rpc(method, params);
    const pending = await txlib.normalize(await rpc('getrawtransaction', [id, true]), rpc);
    assert.equal(pending.confirmations, 0);
    const hash = await mine();
    const block = await rpc('getblock', [hash, 3]);
    const raw = block.tx.find(tx => tx.txid === id);
    const tx = await txlib.normalize(raw, rpc, block);
    assert.equal(tx.metadata_complete, true, name + ' metadata');
    if (raw.fee != null) assert.equal(tx.fee_nitoshi, money.nitoshi(raw.fee).toString(), name + ' Core fee');
    assert.equal(BigInt(tx.transparent_input_nitoshi) + BigInt(tx.orchard?.value_balance_nitoshi || 0) - BigInt(tx.transparent_output_nitoshi), BigInt(tx.fee_nitoshi));
    assert.ok(tx.vin.concat(tx.vout).every(row => !txlib.privateAddress(row.addresses)));
    cases[name] = {id, hash, tx};
  }
  await send('transparent', 'sendtoaddress', [transparent, 1]);
  await send('shield', 'sendtoaddress', [privateReceiver, 4]);
  await send('unshield', 'sendprivate', [transparent, 0.5]);
  await send('private', 'sendprivate', [privateReceiver, 0.1]);
  // sendmany's final boolean selects private inputs in Core V4.
  const help = await rpc('help', ['sendmany']);
  fs.writeFileSync(path.join(temp, 'sendmany-help.txt'), help);
  // Named JSON-RPC parameters preserve the current Core argument contract.
  const mixedId = await new Promise((resolve, reject) => client.rpc.call('sendmany', {dummy: '', amounts: {[transparent]: 0.25, [privateReceiver]: 0.5}, private: true}, resolve, reject));
  const mixedHash = await mine();
  const mixedBlock = await rpc('getblock', [mixedHash, 3]);
  const mixed = await txlib.normalize(mixedBlock.tx.find(tx => tx.txid === mixedId), rpc, mixedBlock);
  assert.equal(mixed.metadata_complete, true); assert.ok(mixed.vout.length > 0); assert.equal(mixed.privacy, 'orchard');
  cases.mixed = {id: mixedId, hash: mixedHash, tx: mixed};
  assert.equal(cases.private.tx.vout.length, 0); assert.ok(BigInt(cases.private.tx.fee_nitoshi) > 0n);

  mongo = await MongoMemoryReplSet.create({binary: {version: '7.0.14'}, replSet: {count: 1, storageEngine: 'wiredTiger'}, instanceOpts: [{ip: '127.0.0.1'}]});
  conn = await new MongoClient(mongo.getUri()).connect();
  const dbName = 'nito_explorer_test_' + randomBytes(6).toString('hex');
  const db = conn.db(dbName);
  const index = new Index(conn, db, rpc);
  await index.sync(collect);
  const firstCount = await db.collection('txes').countDocuments();
  await index.sync(collect);
  assert.equal(await db.collection('txes').countDocuments(), firstCount);
  assert.equal(await db.collection('addresses').countDocuments({a_id: /^(private_orchard|nrt1x)/i}), 0);
  const before = (await db.collection('addresses').findOne({a_id: transparent})).balance.toString();
  await stop(); await start();
  await index.sync(collect);
  assert.equal((await db.collection('addresses').findOne({a_id: transparent})).balance.toString(), before);

  await rpc('invalidateblock', [mixedHash]);
  assert.equal((await rpc('getblockheader', [mixedHash])).confirmations, -1);
  await index.sync(collect);
  assert.equal(await db.collection('txes').findOne({txid: mixedId}), null);
  await rpc('reconsiderblock', [mixedHash]);
  await index.sync(collect);
  assert.equal((await db.collection('addresses').findOne({a_id: transparent})).balance.toString(), before);
  assert.equal(await db.collection('txes').countDocuments(), firstCount);

  const faultHash = await mine();
  const faultBlock = await rpc('getblock', [faultHash, 3]);
  const faultTxs = [];
  for (const raw of faultBlock.tx) faultTxs.push(await txlib.normalize(raw, rpc, faultBlock));
  const beforeState = await index.state();
  await assert.rejects(index.connect(faultBlock, faultTxs, () => { throw Error('simulated interrupted write'); }), /interrupted write/);
  assert.deepEqual(await index.state(), beforeState);
  assert.equal(await db.collection('txes').countDocuments(), firstCount);
  await index.sync(collect);
  assert.equal(await db.collection('txes').countDocuments(), firstCount + faultTxs.length);

  // Replace a tip with another block at the same height and verify hash-based rollback.
  await rpc('invalidateblock', [faultHash]);
  await rpc('setmocktime', [Math.floor(Date.now() / 1000) + 120]);
  const replacement = await mine(); assert.notEqual(replacement, faultHash);
  await index.sync(collect);
  assert.equal((await index.state()).hash, replacement);
  assert.equal(await db.collection('nito_blocks').findOne({_id: faultHash}), null);
  const pools = await collect();
  const utxos = await rpc('gettxoutsetinfo', ['none']);
  assert.equal(money.nitoshi(utxos.total_amount).toString(), pools.transparent.chainValueNitoshi);
  const dbPools = await db.collection('coinstats').findOne({coin: 'Nito'});
  assert.equal(dbPools.pools.bestblockhash, replacement);
  assert.equal(BigInt(pools.transparent.chainValueNitoshi) + BigInt(pools.orchard.chainValueNitoshi), BigInt(pools.total.chainValueNitoshi));

  const legacy = conn.db(dbName + '_legacy');
  await legacy.collection('addresses').insertOne({a_id: 'private_orchard', balance: 4});
  await assert.rejects(new Index(conn, legacy, rpc).init(), /Legacy index/);
  assert.equal((await legacy.collection('addresses').findOne({})).balance, 4);
  const inventory = await require('../../scripts/audit_nito_index').audit(legacy);
  assert.equal(inventory.requires_isolated_rebuild, true);
  assert.equal(inventory.private_address_records, 1);
  const limitDb = conn.db(dbName + '_limits');
  const limitIndex = new Index(conn, limitDb, rpc);
  const limitState = await limitIndex.init();
  const limitBlock = {height: 1, hash: 'f'.repeat(64), previousblockhash: limitState.hash};
  const limitTx = {schema_version: 2, metadata_complete: true, txid: 'e'.repeat(64), blockhash: limitBlock.hash,
    blockindex: 1, total: '128456588999999999', vin: [], vout: [{addresses: 'limit-test', amount: '128456588999999999'}]};
  await limitIndex.connect(limitBlock, [limitTx]);
  assert.equal((await limitDb.collection('addresses').findOne({a_id: 'limit-test'})).balance.toString(), '128456588999999999');
  await limitIndex.disconnect();
  assert.equal((await limitDb.collection('addresses').findOne({a_id: 'limit-test'})).balance.toString(), '0');

  const settings = require('../../lib/settings');
  settings.wallet = cfg;
  settings.explorer_version = require('../../package.json').version;
  settings.markets_page.enabled = false;
  await require('mongoose').connect(mongo.getUri(dbName));
  const app = require('../../app');
  app.locals.settings = settings;
  const uiPort = await port();
  httpServer = app.listen(uiPort, '127.0.0.1');
  const base = `http://127.0.0.1:${uiPort}`;
  const response = await fetch(base + '/ext/getorchardpools');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), pools);
  for (const name of Object.keys(cases)) {
    const json = await (await fetch(base + '/ext/gettx/' + cases[name].id)).json();
    assert.equal(json.tx.fee_nitoshi, cases[name].tx.fee_nitoshi);
    assert.ok(json.confirmations > 0);
    assert.equal((await fetch(base + '/tx/' + cases[name].id)).status, 200);
  }
  for (const prefix of ['/address/', '/ext/getaddress/', '/ext/getbalance/', '/ext/getaddresstxs/']) {
    assert.equal((await fetch(base + prefix + privateReceiver + (prefix.includes('getaddresstxs') ? '/0/10' : ''))).status, 422);
  }
  for (const url of ['/', '/richlist', '/address/' + transparent, '/block/' + cases.private.hash]) {
    const r = await fetch(base + url); const html = await r.text();
    assert.equal(r.status, 200, url + ': ' + html.slice(0, 300)); assert.ok(!/>\s*NaN\s*</.test(html));
  }
  const list = await (await fetch(base + '/ext/getlasttxs/0')).json();
  assert.ok(JSON.stringify(list).includes(cases.private.id));
  await rpc('invalidateblock', [replacement]);
  assert.equal((await fetch(base + '/ext/getorchardpools')).status, 503);
  const orphanId = (await rpc('getblock', [replacement, 2])).tx[0].txid;
  const orphanResponse = await (await fetch(base + '/ext/gettx/' + orphanId + '?blockhash=' + replacement)).json();
  assert.equal(orphanResponse.confirmations, -1);
  assert.equal((await fetch(base + '/tx/' + orphanId + '?blockhash=' + replacement)).status, 200);
  const addressApi = await (await fetch(base + '/ext/getaddress/' + transparent)).json();
  assert.equal(addressApi.balance_nitoshi, '175000000');
  const addressUtxos = await rpc('scantxoutset', ['start', ['addr(' + transparent + ')']]);
  assert.equal(money.nitoshi(addressUtxos.total_amount).toString(), addressApi.balance_nitoshi);
  const addressHistory = await (await fetch(base + '/ext/getaddresstxs/' + transparent + '/0/10')).json();
  assert.equal(addressHistory[0].received, '0.25000000');
  assert.equal(addressHistory[0].sent, '0.00000000');
  await rpc('reconsiderblock', [replacement]);
  await index.sync(collect);
  await stop();
  assert.equal((await fetch(base + '/ext/getorchardpools')).status, 503);
  const offlineTx = await (await fetch(base + '/ext/gettx/' + cases.private.id)).json();
  assert.equal(offlineTx.tx.privacy, 'orchard');
  assert.equal(offlineTx.confirmations, null);
  assert.equal(offlineTx.tx.fee_nitoshi, cases.private.tx.fee_nitoshi);
  await start();
  const stripped = await rpc('getrawtransaction', [cases.private.id, true]);
  delete stripped.has_private_bundle; delete stripped.private_bundle;
  const unknown = await txlib.normalize(stripped, rpc);
  assert.equal(unknown.privacy, 'unknown'); assert.equal(unknown.fee_nitoshi, null);
  assert.equal(unknown.metadata_complete, false);
  await index.sync(collect);
  fs.writeFileSync(path.join(temp, 'explorer-results.json'), JSON.stringify({base, cases, pools, checks: ['activation', 'five transaction forms', 'mempool', 'restart', 'reorg', 'same-height reorg', 'interrupted write', 'duplicate sync', 'legacy refusal', 'HTTP API', 'HTML']}, null, 2));
  console.log('UI_READY', JSON.stringify({base, evidence: temp, privateTx: cases.private.id, mixedTx: mixedId, transparent}));
  if (process.env.NITO_UI_HOLD) {
    const stopFile = path.join(temp, 'finish-ui');
    await until(() => fs.existsSync(stopFile), 600000);
  }
});
