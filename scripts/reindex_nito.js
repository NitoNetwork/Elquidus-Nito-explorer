#!/usr/bin/env node
'use strict';
const {MongoClient} = require('mongodb');
const {rebuild, verifyRollback} = require('../lib/nito-rebuild');
function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (['--isolated', '--resume', '--rollback', '--help'].includes(args[i])) result[args[i].slice(2)] = true;
    else if (['--source-db', '--target-db'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) result[args[i++].slice(2)] = args[i];
    else throw Error('Unknown or incomplete option: ' + args[i]);
  }
  return result;
}
async function main() {
  const args = options(process.argv.slice(2));
  if (args.help) {
    console.log('NITO_SETTINGS_PATH=/isolated/settings.json npm run reindex -- --isolated --source-db historical_copy --target-db rebuilt_copy [--resume]\nAll reindex aliases perform a complete archival replay into a fresh database. No source data is modified.\nUse npm run rollback-index with the same arguments to verify the retained source before switching app/config/database back together.'); return;
  }
  if (!args.isolated || !process.env.NITO_SETTINGS_PATH || !args['source-db'] || !args['target-db']) throw Error('Explicit NITO_SETTINGS_PATH, --isolated, --source-db and --target-db are required; see --help');
  if (!require('node:fs').existsSync(process.env.NITO_SETTINGS_PATH)) throw Error('The explicit isolated settings file does not exist');
  for (const name of [args['source-db'], args['target-db']]) if (!/^[a-zA-Z0-9_-]{1,63}$/.test(name)) throw Error('Invalid database name');
  const settings = require('../lib/settings');
  const cfg = settings.dbsettings;
  if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.address) || !['127.0.0.1', 'localhost', '::1'].includes(settings.wallet.host)) throw Error('Isolated reconstruction requires loopback MongoDB and Core endpoints');
  const auth = cfg.user && cfg.password ? `${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@` : '';
  const host = cfg.address === '::1' ? '[::1]' : cfg.address;
  const uri = `mongodb://${auth}${host}:${cfg.port}/${encodeURIComponent(cfg.database)}${cfg.auth_source ? '?authSource=' + encodeURIComponent(cfg.auth_source) : ''}`;
  const client = new MongoClient(uri, {serverSelectionTimeoutMS: 10000});
  try {
    await client.connect();
    const rpc = require('../lib/nito-rpc');
    const report = args.rollback ? await verifyRollback(client, args['source-db'], args['target-db']) : await rebuild({client,
      source: args['source-db'], target: args['target-db'], rpc: rpc.rpc, collect: rpc.pools, coin: settings.coin.name, resume: args.resume});
    console.log(JSON.stringify(report, null, 2));
  } finally { await client.close(); }
}
if (require.main === module) main().catch(e => {console.error(e.message); process.exitCode = 1;});
module.exports = {options, main};
