#!/usr/bin/env node
'use strict';
throw new Error('Retired unsafe rebuild: use a new isolated database and scripts/sync_nito.js; see docs/nito-v4-orchard.md');

const fs = require('fs');
const http = require('http');
const path = require('path');
const { MongoClient } = require('mongodb');

const args = new Set(process.argv.slice(2));
const getArg = (name, fallback) => {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

const APPLY = args.has('--apply');
const BATCH = Number(getArg('--batch', '250'));
const TO_ARG = getArg('--to', null);
const DATADIR = getArg('--datadir', process.env.NITO_DATADIR || path.join(process.env.HOME || '.', '.nito'));
const SETTINGS_PATH = getArg('--settings', process.env.NITO_EQUIDUS_SETTINGS || path.join(__dirname, '..', 'settings.json'));
const CONF_PATH = getArg('--conf', process.env.NITO_CONF || path.join(DATADIR, 'nito.conf'));
const SPECIAL = new Set(['coinbase', 'hidden_address', 'unknown_address', 'private_orchard']);

function loadIni(filePath) {
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

const conf = loadIni(CONF_PATH);
const rpcPort = Number(conf.rpcport || 8825);
const rpcAuth = Buffer.from(`${conf.rpcuser}:${conf.rpcpassword}`).toString('base64');
const agent = new http.Agent({keepAlive: true, maxSockets: 4});
let rpcId = 0;

function rpcBatch(calls) {
  const payload = JSON.stringify(calls.map((call) => ({
    jsonrpc: '1.0',
    id: ++rpcId,
    method: call.method,
    params: call.params || []
  })));

  const options = {
    host: conf.rpcconnect || '127.0.0.1',
    port: rpcPort,
    method: 'POST',
    agent,
    headers: {
      Authorization: `Basic ${rpcAuth}`,
      'Content-Type': 'text/plain',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of arr) {
            if (item.error) return reject(new Error(JSON.stringify(item.error)));
          }
          resolve(arr.map((item) => item.result));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function rpc(method, params) {
  return (await rpcBatch([{method, params}]))[0];
}

function sat(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 100000000));
}

function asNumber(value) {
  return Number(value.toString());
}

function txoutAddress(vout) {
  const spk = vout && vout.scriptPubKey ? vout.scriptPubKey : {};
  if (spk.address) return spk.address;
  if (Array.isArray(spk.addresses) && spk.addresses.length > 0) return spk.addresses[0];
  return null;
}

function isPublicAddress(addr) {
  return !!addr && !SPECIAL.has(addr);
}

function ensureStat(stats, addr) {
  let stat = stats.get(addr);
  if (!stat) {
    stat = {received: 0n, sent: 0n, balance: 0n};
    stats.set(addr, stat);
  }
  return stat;
}

function addNet(map, addr, amount) {
  if (!isPublicAddress(addr) || amount === 0n) return;
  map.set(addr, (map.get(addr) || 0n) + amount);
}

async function main() {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  const dbs = settings.dbsettings;
  const auth = dbs.user ? `${encodeURIComponent(dbs.user)}:${encodeURIComponent(dbs.password)}@` : '';
  const authSource = dbs.auth_source ? `?authSource=${encodeURIComponent(dbs.auth_source)}` : '';
  const mongo = await MongoClient.connect(`mongodb://${auth}${dbs.address}:${dbs.port}/${dbs.database}${authSource}`, {serverSelectionTimeoutMS: 10000});
  const db = mongo.db(dbs.database);

  const info = await rpc('getblockchaininfo', []);
  const toHeight = TO_ARG == null ? info.blocks : Math.min(Number(TO_ARG), info.blocks);
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const addrTmp = `addresses_rebuild_${suffix}`;
  const atxTmp = `addresstxes_rebuild_${suffix}`;
  const stats = new Map();
  const utxos = new Map();
  let missingInputs = 0;
  let addresstxCount = 0;
  let processedTx = 0;

  if (APPLY) {
    await db.collection(addrTmp).deleteMany({});
    await db.collection(atxTmp).deleteMany({});
    await db.collection(addrTmp).createIndex({a_id: 1}, {unique: true});
    await db.collection(addrTmp).createIndex({balance: 1});
    await db.collection(addrTmp).createIndex({received: 1});
    await db.collection(addrTmp).createIndex({sent: 1});
    await db.collection(atxTmp).createIndex({a_id: 1});
    await db.collection(atxTmp).createIndex({blockindex: 1});
    await db.collection(atxTmp).createIndex({txid: 1});
    await db.collection(atxTmp).createIndex({amount: 1});
    await db.collection(atxTmp).createIndex({a_id: 1, blockindex: -1});
  }

  let atxBuffer = [];
  async function flushAtx() {
    if (!APPLY || atxBuffer.length === 0) return;
    const batch = atxBuffer;
    atxBuffer = [];
    await db.collection(atxTmp).insertMany(batch, {ordered: false});
  }

  for (let start = 0; start <= toHeight; start += BATCH) {
    const end = Math.min(toHeight, start + BATCH - 1);
    const hashCalls = [];
    for (let h = start; h <= end; h++) hashCalls.push({method: 'getblockhash', params: [h]});
    const hashes = await rpcBatch(hashCalls);
    const blocks = await rpcBatch(hashes.map((hash) => ({method: 'getblock', params: [hash, 2]})));

    for (const block of blocks) {
      for (const tx of block.tx) {
        processedTx++;
        const txNet = new Map();

        if (Array.isArray(tx.vin)) {
          for (const vin of tx.vin) {
            if (vin.coinbase != null) continue;
            const key = `${vin.txid}:${vin.vout}`;
            const prev = utxos.get(key);
            if (!prev) {
              missingInputs++;
              continue;
            }
            utxos.delete(key);
            const stat = ensureStat(stats, prev.address);
            stat.sent += prev.amount;
            stat.balance -= prev.amount;
            addNet(txNet, prev.address, -prev.amount);
          }
        }

        if (Array.isArray(tx.vout)) {
          for (const vout of tx.vout) {
            const addr = txoutAddress(vout);
            if (!isPublicAddress(addr)) continue;
            const amount = sat(vout.value);
            if (amount <= 0n) continue;
            utxos.set(`${tx.txid}:${vout.n}`, {address: addr, amount});
            const stat = ensureStat(stats, addr);
            stat.received += amount;
            stat.balance += amount;
            addNet(txNet, addr, amount);
          }
        }

        if (APPLY) {
          for (const [addr, amount] of txNet) {
            if (amount === 0n) continue;
            atxBuffer.push({a_id: addr, blockindex: block.height, txid: tx.txid, amount: asNumber(amount)});
            addresstxCount++;
          }
          if (atxBuffer.length >= 10000) await flushAtx();
        }
      }
    }

    if (start === 0 || end === toHeight || end % (BATCH * 20) === BATCH * 20 - 1) {
      console.log(JSON.stringify({height: end, toHeight, processedTx, addresses: stats.size, utxos: utxos.size, missingInputs, addresstxCount, apply: APPLY}));
    }
  }

  await flushAtx();

  if (APPLY) {
    const docs = [];
    for (const [addr, stat] of stats) {
      docs.push({a_id: addr, received: asNumber(stat.received), sent: asNumber(stat.sent), balance: asNumber(stat.balance)});
      if (docs.length >= 5000) {
        await db.collection(addrTmp).insertMany(docs, {ordered: false});
        docs.length = 0;
      }
    }
    if (docs.length > 0) await db.collection(addrTmp).insertMany(docs, {ordered: false});

    const backupAddr = `addresses_pre_rebuild_${suffix}`;
    const backupAtx = `addresstxes_pre_rebuild_${suffix}`;
    await db.collection('addresses').rename(backupAddr, {dropTarget: true});
    await db.collection('addresstxes').rename(backupAtx, {dropTarget: true});
    await db.collection(addrTmp).rename('addresses', {dropTarget: true});
    await db.collection(atxTmp).rename('addresstxes', {dropTarget: true});

    const excluded = ['coinbase', 'hidden_address', 'private_orchard', 'unknown_address'];
    const balance = await db.collection('addresses').aggregate([
      {$match: {a_id: {$nin: excluded}}},
      {$sort: {balance: -1}},
      {$limit: 100},
      {$project: {_id: 0, __v: 0, sent: 0}}
    ]).toArray();
    const received = await db.collection('addresses').aggregate([
      {$match: {a_id: {$nin: excluded}}},
      {$sort: {received: -1}},
      {$limit: 100},
      {$project: {_id: 0, __v: 0, sent: 0}}
    ]).toArray();
    await db.collection('richlists').updateOne({coin: 'NITO'}, {$set: {balance, received, burned: 0}}, {upsert: true});
    await db.collection('coinstats').updateOne({coin: 'NITO'}, {$set: {richlist_last_updated: Math.floor(Date.now() / 1000)}});

    console.log(JSON.stringify({applied: true, backupAddr, backupAtx, addressDocs: stats.size, addresstxCount, missingInputs, utxos: utxos.size}, null, 2));
  } else {
    const top = [...stats.entries()].sort((a, b) => Number(b[1].balance - a[1].balance)).slice(0, 10).map(([a, s]) => ({a, balance: Number(s.balance) / 1e8, received: Number(s.received) / 1e8, sent: Number(s.sent) / 1e8}));
    console.log(JSON.stringify({applied: false, toHeight, addressDocs: stats.size, addresstxCount, missingInputs, utxos: utxos.size, top}, null, 2));
  }

  await mongo.close();
  agent.destroy();
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
