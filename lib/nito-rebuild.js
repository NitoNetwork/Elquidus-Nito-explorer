'use strict';
const {createHash} = require('node:crypto');
const {BSON: {EJSON}} = require('mongodb');
const {Index} = require('./nito-index');
const {privateAddress} = require('./nito-transaction');
const derived = new Set(['addresses', 'addresstxes', 'txes', 'coinstats', 'richlists', 'nito_state', 'nito_blocks', 'nito_pools', 'orphans', 'nito_rebuild']);

// A frozen, isolated source is required. Hash canonical BSON without converting money to Number.
async function inventory(db, requestedNames = null) {
  const result = {};
  const available = (await db.listCollections({}, {nameOnly: true}).toArray()).map(c => c.name).sort();
  const names = requestedNames == null
    ? available
    : [...new Set(requestedNames)].filter(name => available.includes(name)).sort();
  for (const name of names) {
    const hash = createHash('sha256'); let count = 0;
    for await (const row of db.collection(name).find().sort({_id: 1})) {
      hash.update(EJSON.stringify(row, {relaxed: false}) + '\n'); count++;
    }
    result[name] = {count, sha256: hash.digest('hex'), indexes: await db.collection(name).listIndexes().toArray()};
  }
  return result;
}

async function inventoryPreserved(db, preservation) {
  return inventory(db, Object.values(preservation).map(entry => entry.destination));
}

async function verifyCanonicalCheckpoint(rpc, state) {
  const currentTip = await rpc('getblockchaininfo', []);
  if (currentTip.chain !== state.chain || currentTip.blocks < state.height)
    throw Error('Core no longer contains the reconstruction checkpoint; resume before acceptance');
  const canonicalHash = await rpc('getblockhash', [state.height]);
  if (canonicalHash !== state.hash)
    throw Error('Reconstruction checkpoint is no longer canonical; resume before acceptance');
  return currentTip;
}

async function rebuild({client, source, target, rpc, collect, coin = 'Nito', resume = false}) {
  if (!source || !target || source === target) throw Error('Source and fresh target databases must be explicitly different');
  const old = client.db(source), db = client.db(target);
  const existing = await db.listCollections({}, {nameOnly: true}).toArray();
  const marker = await db.collection('nito_rebuild').findOne({_id: 'migration'});
  let before;
  if (existing.length) {
    const saved = marker?.source_inventory;
    if (!resume || !marker || marker.source !== source || !saved || Array.isArray(saved) || !Object.keys(saved).length) {
      throw Error('Target must be empty, or --resume must match this source and migration manifest');
    }
    // Resume indexing immediately. The full source check below still proves that
    // the frozen source matches the inventory captured by the initial run.
    before = saved;
  } else {
    before = await inventory(old);
    if (!Object.keys(before).length) throw Error('Source database is empty; use sync-blocks with a dedicated empty database instead');
  }
  if (!marker) await db.collection('nito_rebuild').insertOne({_id: 'migration', source, source_inventory: before, complete: false});
  else await db.collection('nito_rebuild').updateOne({_id: 'migration'}, {$set: {complete: false}});
  const index = new Index(client, db, rpc, coin);
  const state = await index.sync(collect);
  const statistics = await db.collection('coinstats').findOne({coin});
  if (!statistics?.pools || statistics.pools.bestblockhash !== state.hash || statistics.pools.blocks !== state.height || statistics.pools.chain !== state.chain) {
    throw Error('Reconstruction has no complete same-tip pool snapshot; synchronize coinstatsindex and resume');
  }
  const preservation = {};
  // Retain ancillary data for review, without presenting legacy statistics as current totals.
  for (const name of Object.keys(before).filter(name => !derived.has(name))) {
    const destination = 'legacy_archive_' + name;
    try { await db.createCollection(destination); } catch (e) { if (e.code !== 48) throw e; }
    for await (const row of old.collection(name).find()) await db.collection(destination).replaceOne({_id: row._id}, row, {upsert: true});
    preservation[name] = {destination, count: before[name].count};
  }
  await db.collection('claimaddresses').createIndex({a_id: 1}, {unique: true});
  let accepted = 0, rejected = 0;
  const seen = new Set();
  for (const name of ['claimaddresses', 'addresses']) {
    for await (const row of old.collection(name).find(name === 'addresses' ? {name: {$type: 'string', $ne: ''}} : {})) {
      const label = name === 'addresses' ? row.name : row.claim_name;
      if (!label || typeof row.a_id !== 'string' || privateAddress(row.a_id) || seen.has(row.a_id)) { rejected++; continue; }
      const validation = await rpc('validateaddress', [row.a_id]);
      if (!validation?.isvalid) { rejected++; continue; }
      await db.collection('claimaddresses').replaceOne({a_id: row.a_id}, {a_id: row.a_id, claim_name: label}, {upsert: true});
      seen.add(row.a_id); accepted++;
    }
  }
  const after = await inventory(old);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw Error('Source changed during reconstruction; do not cut over');
  const targetInventory = await inventoryPreserved(db, preservation);
  for (const [name, entry] of Object.entries(preservation)) {
    const copied = targetInventory[entry.destination];
    if (!copied || copied.count !== before[name].count || copied.sha256 !== before[name].sha256) throw Error('Ancillary archive mismatch: ' + name);
    entry.sha256 = copied.sha256;
  }
  await verifyCanonicalCheckpoint(rpc, state);
  const report = {source, target, source_inventory: before, checkpoint: state, preservation, claims: {accepted, rejected}, complete: true};
  await db.collection('nito_rebuild').replaceOne({_id: 'migration'}, {_id: 'migration', ...report});
  return report;
}

// Rollback verification is deliberately read-only: select the retained app/config/database together.
async function verifyRollback(client, source, target) {
  if (!source || source === target) throw Error('Rollback needs distinct source and target databases');
  const marker = await client.db(target).collection('nito_rebuild').findOne({_id: 'migration'});
  if (!marker || marker.source !== source) throw Error('No matching reconstruction manifest');
  const current = await inventory(client.db(source));
  if (JSON.stringify(current) !== JSON.stringify(marker.source_inventory)) throw Error('Retained source changed; rollback cannot be verified');
  return {verified: true, database: source, inventory: current, instruction: 'Use the retained explorer revision and configuration with this database; never downgrade the rebuilt database in place.'};
}
module.exports = {rebuild, inventory, inventoryPreserved, verifyCanonicalCheckpoint, verifyRollback};
