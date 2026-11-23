#!/usr/bin/env node
'use strict';
const {MongoClient} = require('mongodb');
const {Index} = require('../lib/nito-index');
const settings = require('../lib/settings');
const rpc = require('../lib/nito-rpc');
const networkProfile = require('../lib/network-profile');

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
    const database = client.db(cfg.database);
    await networkProfile.verify({database, rpc: rpc.rpc});
    const index = new Index(client, database, rpc.rpc, settings.coin.name, {
      networkHashUnit: settings.shared_pages.page_header.panels.network_panel.nethash_units,
      networkHistoryLimit: (settings.network_history && settings.network_history.max_saved_records) || 1440,
      movementMinimum: settings.movement_page.enabled ? settings.movement_page.movement_table.min_amount : null
    });
    const state = await index.sync(rpc.pools, () => stopped);
    console.log(`Indexed ${state.chain} block ${state.height} (${state.hash})`);
  } finally { await client.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
