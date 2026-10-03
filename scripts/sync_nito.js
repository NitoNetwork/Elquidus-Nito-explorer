#!/usr/bin/env node
'use strict';
const {MongoClient} = require('mongodb');
const {Index} = require('../lib/nito-index');
const settings = require('../lib/settings');
const rpc = require('../lib/nito-rpc');

async function main() {
  const cfg = settings.dbsettings;
  const auth = cfg.user && cfg.password ? `${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@` : '';
  const uri = `mongodb://${auth}${cfg.address}:${cfg.port}/${encodeURIComponent(cfg.database)}${cfg.auth_source ? '?authSource=' + encodeURIComponent(cfg.auth_source) : ''}`;
  const client = new MongoClient(uri, {serverSelectionTimeoutMS: 10000});
  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  process.once('SIGTERM', () => { stopped = true; });
  try {
    await client.connect();
    const index = new Index(client, client.db(cfg.database), rpc.rpc, settings.coin.name);
    const state = await index.sync(rpc.pools, () => stopped);
    console.log(`Indexed ${state.chain} block ${state.height} (${state.hash})`);
  } finally { await client.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
