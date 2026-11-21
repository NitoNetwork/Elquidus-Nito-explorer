'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
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
  let daemon, mongo, conn, httpServer, peerRpcServer;
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
    if (peerRpcServer?.listening) await new Promise(r => peerRpcServer.close(r));
    await require('mongoose').disconnect();
    if (conn) await conn.close();
    if (mongo) await mongo.stop();
    await stop();
    console.log('Regtest evidence directory:', temp);
  });
  await start();
  const initialTip = await rpc('getblockchaininfo');
  assert.equal(initialTip.privateTxActivationHeight, 105, 'Core binary must expose the configured V4 activation height');
  assert.equal(initialTip.activated, false, 'Core binary must expose the pre-activation V4 state');
  await rpc('createwallet', ['explorer-test']);
  const miner = await rpc('getnewaddress');
  async function mine(count = 1) {
    const target = await rpc('getblockcount') + count;
    while (await rpc('getblockcount') < target) await rpc('generatetoaddress', [target - await rpc('getblockcount'), miner, 10000000]);
    await until(async () => { const i = (await rpc('getindexinfo')).coinstatsindex; return i?.synced && i.best_block_height === target; });
    return rpc('getbestblockhash');
  }
  const collect = collector(rpc);
  const genesisPools = await until(async () => {
    const p = await collect();
    if (p.status !== 'available') throw Error('Genesis pool snapshot unavailable: ' + p.reason);
    return p;
  });
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
  const activationHash = await rpc('getbestblockhash');
  await rpc('invalidateblock', [activationHash]);
  assert.equal((await rpc('getblockchaininfo')).activated, false);
  assert.equal((await until(async () => { const p = await collect(); return p.status === 'available' && p; })).activated, false);
  await rpc('reconsiderblock', [activationHash]);
  assert.equal((await until(async () => { const p = await collect(); return p.status === 'available' && p; })).activated, true);
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
  // Reconstruct a frozen historical regtest copy, retaining labels and ancillary evidence.
  // This is real generated chain history, not a supplied production database export.
  const {rebuild, inventory: migrationInventory, verifyRollback} = require('../../lib/nito-rebuild');
  const legacyName = dbName + '_legacy', rebuiltName = dbName + '_rebuilt';
  const legacyCopy = conn.db(legacyName);
  for (const name of ['txes', 'addresses', 'addresstxes']) {
    const rows = await db.collection(name).find().toArray();
    if (rows.length) await legacyCopy.collection(name).insertMany(rows);
  }
  await legacyCopy.collection('addresses').insertOne({a_id: 'private_orchard', balance: 500000000, received: 500000000, sent: 0});
  await legacyCopy.collection('claimaddresses').insertMany([{a_id: transparent, claim_name: 'Historical transparent label'}, {a_id: privateReceiver, claim_name: 'Must not be published'}]);
  await legacyCopy.collection('markets').insertOne({market: 'fixture', summary: {last: '0.001'}});
  await legacyCopy.collection('networkhistories').insertOne({blockindex: 10, supply: 999});
  await legacyCopy.createCollection('custom_empty');
  const retainedInventory = await migrationInventory(legacyCopy);
  const migration = await rebuild({client: conn, source: legacyName, target: rebuiltName, rpc, collect});
  assert.equal(migration.complete, true);
  assert.deepEqual(await migrationInventory(legacyCopy), retainedInventory);
  const rebuiltDb = conn.db(rebuiltName);
  for (const name of ['addresses', 'addresstxes', 'txes']) {
    const sorted = async database => database.collection(name).find({}, {projection: {_id: 0}}).sort(name === 'addresses' ? {a_id: 1} : name === 'addresstxes' ? {a_id: 1, txid: 1} : {txid: 1}).toArray();
    assert.deepEqual(await sorted(rebuiltDb), await sorted(db), 'rebuilt ' + name);
  }
  const ranked = database => database.collection('addresses').find({}, {projection: {_id: 0}}).sort({balance: -1, a_id: 1}).limit(100).toArray();
  assert.deepEqual(await ranked(rebuiltDb), await ranked(db), 'rebuilt transparent top 100');
  assert.equal((await rebuiltDb.collection('claimaddresses').findOne({a_id: transparent})).claim_name, 'Historical transparent label');
  assert.equal(await rebuiltDb.collection('claimaddresses').countDocuments(), 1);
  assert.equal(await rebuiltDb.collection('legacy_archive_markets').countDocuments(), 1);
  assert.equal(await rebuiltDb.collection('legacy_archive_networkhistories').countDocuments(), 1);
  assert.equal((await rebuiltDb.listCollections({name: 'legacy_archive_custom_empty'}).toArray()).length, 1);
  assert.equal(await rebuiltDb.collection('networkhistories').countDocuments(), 0);
  await assert.rejects(rebuild({client: conn, source: legacyName, target: rebuiltName, rpc, collect}), /Target must be empty/);
  await rebuild({client: conn, source: legacyName, target: rebuiltName, rpc, collect, resume: true});
  const rollback = await verifyRollback(conn, legacyName, rebuiltName);
  const operationalSettings = path.join(temp, 'rebuild-settings.json');
  const mongoUrl = new URL(mongo.getUri());
  const regtestGenesis = await rpc('getblockhash', [0]);
  const operationConfig = JSON.parse(require('jsonminify')(fs.readFileSync(path.resolve(__dirname, '../../settings.json.template'), 'utf8')));
  Object.assign(operationConfig, {
    wallet: {host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password},
    coin: {...operationConfig.coin, name: 'Nito'},
    network: {
      ...operationConfig.network,
      id: 'regtest', label: 'Regtest', enforce: true, expected_chain: 'regtest', expected_genesis: regtestGenesis,
      process_suffix: '', public_url: 'https://regtest.invalid/', robots_noindex: true,
      require_indexes: ['txindex', 'coinstatsindex'], require_synced: true,
      private_activation_height: 105, require_private_active: true,
      switch: {enabled: false, url: '', label: ''}
    },
    dbsettings: {user: '', password: '', database: legacyName, address: '127.0.0.1', port: Number(mongoUrl.port), auth_source: ''}
  });
  fs.writeFileSync(operationalSettings, JSON.stringify(operationConfig));
  async function runOperation(args, script = 'reindex_nito.js', expectedCode = 0) {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../scripts', script), ...args], {
      cwd: path.resolve(__dirname, '../..'), windowsHide: true,
      env: {...process.env, NITO_SETTINGS_PATH: operationalSettings}, stdio: ['ignore', 'pipe', 'pipe']});
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {child.kill(); reject(Error(script + ' exceeded 120 seconds\n' + output));}, 120000);
      child.once('error', error => {clearTimeout(timeout); reject(error);});
      child.once('exit', value => {clearTimeout(timeout); resolve(value);});
    });
    assert.equal(code, expectedCode, output); return output;
  }
  const commandArgs = ['--isolated', '--source-db', legacyName, '--target-db', rebuiltName];
  assert.match(await runOperation([...commandArgs, '--resume']), /"complete": true/);
  assert.match(await runOperation([...commandArgs, '--rollback']), /"verified": true/);
  // Exercise the complete peer command with an isolated RPC fixture and database.
  const peerDbName = dbName + '_peer_sync';
  const peerDb = conn.db(peerDbName);
  await peerDb.collection('coinstats').insertOne({coin: 'Nito'});
  await peerDb.collection('nito_state').insertOne({_id: 'Nito', schema_version: 2, chain: 'regtest', genesis: regtestGenesis});
  let peerRpcResult = [
    {addr: '8.8.8.8:9100', network: 'ipv4', version: 70017, subver: '/Nito:4.0.0/'},
    {addr: '127.0.0.1:9100', network: 'ipv4', version: 70017, subver: '/Nito:4.0.0/'},
    {addr: 'example.onion:9100', network: 'onion', version: 70017, subver: '/Nito:4.0.0/'},
    {addr: 'example.b32.i2p:0', network: 'i2p', version: 70017, subver: '/Nito:4.0.0/'}
  ];
  let peerRpcError = null;
  const verifiedTip = await rpc('getblockchaininfo');
  const verifiedIndexes = await until(async () => {
    const indexes = await rpc('getindexinfo');
    return indexes.txindex?.synced === true && indexes.coinstatsindex?.synced === true ? indexes : false;
  });
  const peerRpcPort = await port();
  peerRpcServer = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => {
      const payload = JSON.parse(body);
      const batch = Array.isArray(payload) ? payload : [payload];
      const replies = batch.map(item => {
        if (peerRpcError && item.method === 'getpeerinfo')
          return {id: item.id, result: null, error: {code: -1, message: peerRpcError}};
        const results = {
          getpeerinfo: peerRpcResult,
          getblockchaininfo: verifiedTip,
          getblockhash: regtestGenesis,
          getindexinfo: verifiedIndexes
        };
        if (!Object.hasOwn(results, item.method))
          return {id: item.id, result: null, error: {code: -32601, message: 'Method not found'}};
        return {id: item.id, result: results[item.method], error: null};
      });
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
    });
  });
  await new Promise(resolve => peerRpcServer.listen(peerRpcPort, '127.0.0.1', resolve));
  operationConfig.dbsettings.database = peerDbName;
  operationConfig.wallet = {...cfg, port: peerRpcPort};
  operationConfig.network_page.peer_sync.geolocation = {
    ...operationConfig.network_page.peer_sync.geolocation,
    provider_url: 'https://127.0.0.1:1/{ip}', timeout_ms: 1000, max_failures_per_pass: 1
  };
  fs.writeFileSync(operationalSettings, JSON.stringify(operationConfig));
  assert.match(await runOperation(['peers'], 'sync.js'), /Peer sync complete \(4 peer record\(s\)\)/);
  assert.equal(await peerDb.collection('peers').countDocuments(), 4);
  const firstPublicPeer = await peerDb.collection('peers').findOne({address: '8.8.8.8'});
  assert.equal(firstPublicPeer.country, '');
  assert.ok(firstPublicPeer.geo_attempted_at instanceof Date);
  assert.equal(firstPublicPeer.geo_checked_at, null);
  const firstPeerTimestamp = (await peerDb.collection('coinstats').findOne({coin: 'Nito'})).network_last_updated;
  assert.ok(firstPeerTimestamp > 0);
  const peerIndexes = await peerDb.collection('peers').listIndexes().toArray();
  assert.equal(peerIndexes.find(indexInfo => indexInfo.name === 'createdAt_1').expireAfterSeconds, 86400);
  assert.equal(peerIndexes.find(indexInfo => indexInfo.name === 'peer_lookup_idx').unique, undefined);
  peerRpcResult[0].subver = '/Nito:4.0.1/';
  await runOperation(['peers'], 'sync.js');
  assert.equal(await peerDb.collection('peers').countDocuments(), 4);
  assert.equal((await peerDb.collection('peers').findOne({address: '8.8.8.8'})).version, 'Nito:4.0.1');
  const stablePeerTimestamp = (await peerDb.collection('coinstats').findOne({coin: 'Nito'})).network_last_updated;
  peerRpcResult = [{addr: ''}];
  await runOperation(['peers'], 'sync.js', 1);
  assert.equal((await peerDb.collection('coinstats').findOne({coin: 'Nito'})).network_last_updated, stablePeerTimestamp);
  peerRpcError = 'simulated getpeerinfo failure';
  await runOperation(['peers'], 'sync.js', 2);
  assert.equal((await peerDb.collection('coinstats').findOne({coin: 'Nito'})).network_last_updated, stablePeerTimestamp);
  peerRpcError = null;
  peerRpcResult = [];
  await delay(1100);
  assert.match(await runOperation(['peers'], 'sync.js'), /Peer sync complete \(0 peer record\(s\)\)/);
  assert.ok((await peerDb.collection('coinstats').findOne({coin: 'Nito'})).network_last_updated > stablePeerTimestamp);
  await new Promise(resolve => peerRpcServer.close(resolve));
  peerRpcServer = null;
  // Exercise the documented startup and sync entry points against the rebuilt copy.
  // The retained source remains frozen; no supervisor or public endpoint is started.
  operationConfig.dbsettings.database = rebuiltName;
  operationConfig.wallet = {host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password};
  operationConfig.markets_page.enabled = false;
  fs.writeFileSync(operationalSettings, JSON.stringify(operationConfig));
  const startupState = await rebuiltDb.collection('nito_state').findOne({_id: 'Nito'});
  const startupStats = await rebuiltDb.collection('coinstats').findOne({coin: 'Nito'});
  const startupCounts = {};
  for (const name of ['txes', 'addresses', 'addresstxes', 'claimaddresses']) startupCounts[name] = await rebuiltDb.collection(name).countDocuments();
  const startupBalances = await ranked(rebuiltDb);
  assert.match(await runOperation([], 'prestart.js'), /Database initialization complete/);
  for (let pass = 0; pass < 2; pass++) assert.match(await runOperation([], 'sync_nito.js'), /Indexed regtest block/);
  assert.deepEqual(await rebuiltDb.collection('nito_state').findOne({_id: 'Nito'}), startupState);
  const afterStartupStats = await rebuiltDb.collection('coinstats').findOne({coin: 'Nito'});
  for (const field of ['txes', 'last', 'count', 'schema_version', 'supply', 'pools']) assert.deepEqual(afterStartupStats[field], startupStats[field], 'startup preserves ' + field);
  for (const [name, count] of Object.entries(startupCounts)) assert.equal(await rebuiltDb.collection(name).countDocuments(), count, 'startup preserves ' + name);
  assert.deepEqual(await ranked(rebuiltDb), startupBalances);
  assert.deepEqual(await migrationInventory(legacyCopy), retainedInventory);
  // Switch the reader back to the retained database, without altering either schema.
  const rolledBackDb = conn.db(rollback.database);
  assert.deepEqual(await migrationInventory(rolledBackDb), retainedInventory);
  assert.equal((await rolledBackDb.collection('addresses').findOne({a_id: 'private_orchard'})).balance, 500000000);
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

  const legacy = conn.db(dbName + '_legacy_refusal');
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
  settings.markets_page.enabled = true;
  settings.markets_page.exchanges.poloniex.enabled = true;
  settings.markets_page.exchanges.poloniex.trading_pairs = ['NITO/BTC'];
  if (process.env.NITO_UI_HOLD) {
    const panels = settings.shared_pages.page_header.panels;
    for (const panel of Object.values(panels)) if (panel && typeof panel === 'object') panel.enabled = false;
    ['network_panel', 'difficulty_panel', 'coin_supply_panel', 'logo_panel'].forEach((name, i) => {
      panels[name].enabled = true; panels[name].display_order = i + 1;
    });
    settings.richlist_page.show_panels = true;
  }
  await db.collection('markets').insertOne({market: 'poloniex', coin_symbol: 'NITO', pair_symbol: 'BTC', stale: true,
    last_success_at: Date.now() - 3600000, last_error: 'HTTP_503', chartdata: '[]',
    summary: {last: '0.00000001', high: '0.00000002', low: '0.00000001', volume: '1284565889.99999999'},
    buys: [{price: '0.00000001', quantity: '1284565889.99999999', total: '12.8456588999999999'}],
    sells: [], history: []});
  await require('mongoose').connect(mongo.getUri(rebuiltName));
  const preservedRichlist = await require('../../lib/nito-store').richlist();
  assert.equal(preservedRichlist.balance.find(row => row.a_id === transparent).claim_name, 'Historical transparent label');
  await require('mongoose').disconnect();
  await require('mongoose').connect(mongo.getUri(dbName));
  const peerUpdatedAt = new Date();
  await db.collection('peers').insertMany([
    {address: '8.8.8.8', port: '9100', protocol: '70016', version: '<img src=x onerror="window.peerXss=1">', network: 'ipv4',
      country: 'United States', country_code: 'US', geo_checked_at: peerUpdatedAt, geo_attempted_at: peerUpdatedAt, createdAt: peerUpdatedAt},
    {address: '2606:4700:4700::1111', port: '9100', protocol: '70016', version: 'Nito:4.0.0', network: 'ipv6',
      country: '', country_code: '', geo_checked_at: peerUpdatedAt, createdAt: peerUpdatedAt}
  ]);
  await db.collection('coinstats').updateOne({coin: 'Nito'}, {$set: {network_last_updated: Math.floor(peerUpdatedAt.getTime() / 1000)}});
  const app = require('../../app');
  const uiPort = await port();
  httpServer = app.listen(uiPort, '127.0.0.1');
  const base = `http://127.0.0.1:${uiPort}`;
  const explorerProcessId = process.pid;
  const visibleText = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ');
  const response = await fetch(base + '/ext/getorchardpools');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), pools);
  const networkPeers = await (await fetch(base + '/ext/getnetworkpeers')).json();
  assert.equal(Array.isArray(networkPeers), true);
  assert.equal(networkPeers.length, 2);
  assert.equal(networkPeers[0].address, '8.8.8.8');
  assert.equal(networkPeers[0].network, 'ipv4');
  assert.equal(networkPeers[0].country_code, 'US');
  assert.equal(networkPeers[0].version, '<img src=x onerror="window.peerXss=1">');
  assert.equal(Object.hasOwn(networkPeers[0], '_id'), false);
  assert.equal(Object.hasOwn(networkPeers[0], '__v'), false);
  assert.equal(Object.hasOwn(networkPeers[0], 'geo_checked_at'), false);
  assert.equal(Object.hasOwn(networkPeers[0], 'geo_attempted_at'), false);
  const databaseModule = require('../../lib/database');
  const workingPeerReader = databaseModule.get_peers;
  databaseModule.get_peers = callback => callback(null, new Error('simulated peer database failure'));
  try {
    const unavailablePeers = await fetch(base + '/ext/getnetworkpeers');
    assert.equal(unavailablePeers.status, 503);
    assert.match((await unavailablePeers.json()).error, /could not be loaded/i);
  } finally {
    databaseModule.get_peers = workingPeerReader;
  }
  const networkPage = await fetch(base + '/network');
  assert.equal(networkPage.status, 200);
  assert.match(await networkPage.text(), /Country is an approximate IP-based estimate/);
  assert.match(await (await fetch(base + '/info')).text(), /id="nito-pool-api-documentation"/);
  const priceState = require('../../lib/market-price-state');
  // The real MongoDB -> stats -> HTTP path must retain provider status everywhere.
  await db.collection('coinstats').updateOne({coin: 'Nito'}, {$set: {last_price: 0, last_usd_price: 0}});
  for (const endpoint of ['/ext/getsummary', '/ext/getbasicstats', '/ext/getcurrentprice']) {
    const result = await (await fetch(base + endpoint)).json();
    assert.equal(result.market_price.status, 'unavailable', endpoint);
    assert.equal(endpoint.endsWith('getsummary') ? result.lastUSDPrice : result.last_price_usd, null);
  }
  const quoteTime = Date.now();
  await db.collection('coinstats').updateOne({coin: 'Nito'}, {$set: priceState.success(0.000001, 0.0123, quoteTime)});
  for (const endpoint of ['/ext/getsummary', '/ext/getbasicstats', '/ext/getcurrentprice']) {
    const result = await (await fetch(base + endpoint)).json();
    assert.equal(result.market_price.status, 'available', endpoint);
    assert.equal(endpoint.endsWith('getsummary') ? result.lastUSDPrice : result.last_price_usd, 0.0123);
  }
  await db.collection('coinstats').updateOne({coin: 'Nito'}, {$set: priceState.failure({code: 'HTTP_503'})});
  for (const endpoint of ['/ext/getsummary', '/ext/getbasicstats', '/ext/getcurrentprice']) {
    const result = await (await fetch(base + endpoint)).json();
    assert.equal(result.market_price.status, 'stale', endpoint);
    assert.equal(result.market_price.last_success_at, quoteTime);
    assert.equal(result.market_price.error, 'HTTP_503');
    assert.equal(endpoint.endsWith('getsummary') ? result.lastUSDPrice : result.last_price_usd, 0.0123);
  }
  for (const name of Object.keys(cases)) {
    const json = await (await fetch(base + '/ext/gettx/' + cases[name].id)).json();
    assert.equal(json.tx.fee_nitoshi, cases[name].tx.fee_nitoshi);
    assert.ok(json.confirmations > 0);
    assert.equal((await fetch(base + '/tx/' + cases[name].id)).status, 200);
  }
  for (const prefix of ['/address/', '/ext/getaddress/', '/ext/getbalance/', '/ext/getaddresstxs/']) {
    assert.equal((await fetch(base + prefix + privateReceiver + (prefix.includes('getaddresstxs') ? '/0/10' : ''))).status, 422);
  }
  for (const url of ['/', '/richlist', '/movement', '/markets/poloniex/NITO/BTC', '/address/' + transparent, '/block/' + cases.private.hash]) {
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
  assert.doesNotMatch(visibleText(await (await fetch(base + '/info')).text()), /Orchard|Bech32x|getorchardpools/i);
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
  console.log('UI_READY', JSON.stringify({base, evidence: temp, privateTx: cases.private.id, mixedTx: mixedId, transparent}));
  if (process.env.NITO_UI_HOLD) {
    const stopFile = path.join(temp, 'finish-ui');
    await until(() => fs.existsSync(stopFile), 600000);
  }
  await rpc('invalidateblock', [activationHash]);
  await until(async () => (await collect()).status === 'available');
  await index.sync(collect);
  const preactivation = await (await fetch(base + '/ext/getorchardpools')).json();
  assert.equal(preactivation.activated, false);
  assert.equal(preactivation.orchard.chainValueNitoshi, '0');
  const supplyView = require('../../public/js/nito-supply');
  const labels = {total: 'Total', transparent: 'Transparent', orchard: 'Orchard', unavailable: 'Unavailable'};
  const beforeSummary = await (await fetch(base + '/ext/getsummary')).json();
  assert.equal(supplyView.rows(beforeSummary, labels).length, 1);
  for (const page of ['/', '/richlist', '/info', '/movement', '/address/' + transparent, '/block/' + preactivation.bestblockhash]) {
    const result = await fetch(base + page);
    assert.equal(result.status, 200, page);
    assert.doesNotMatch(visibleText(await result.text()), /Orchard|Bech32x|getorchardpools/i, page + ' before activation');
  }
  if (process.env.NITO_UI_HOLD) {
    console.log('UI_PREACTIVATION', JSON.stringify({base, evidence: temp}));
    await until(() => fs.existsSync(path.join(temp, 'finish-ui-preactivation')), 600000);
  }
  await rpc('reconsiderblock', [activationHash]);
  await until(async () => (await collect()).status === 'available');
  await index.sync(collect);
  assert.equal((await (await fetch(base + '/ext/getorchardpools')).json()).activated, true);
  const afterSummary = await (await fetch(base + '/ext/getsummary')).json();
  assert.equal(supplyView.rows(afterSummary, labels).length, 3);
  assert.match(await (await fetch(base + '/info')).text(), /id="nito-pool-api-documentation"/);
  assert.equal(process.pid, explorerProcessId, 'activation keeps the explorer process');
  assert.equal(httpServer.listening, true);
  assert.equal(httpServer.address().port, uiPort, 'activation keeps the same HTTP listener');
  if (process.env.NITO_UI_HOLD) {
    console.log('UI_REACTIVATION', JSON.stringify({base, evidence: temp}));
    await until(() => fs.existsSync(path.join(temp, 'finish-ui-reactivation')), 600000);
  }
  fs.writeFileSync(path.join(temp, 'explorer-results.json'), JSON.stringify({base, cases, pools,
    checks: ['activation', 'five transaction forms', 'mempool', 'restart', 'reorg', 'same-height reorg',
      'interrupted write', 'duplicate sync', 'legacy refusal', 'HTTP API', 'HTML',
      'no Orchard promotion before activation', 'automatic activation without explorer restart']}, null, 2));
});
