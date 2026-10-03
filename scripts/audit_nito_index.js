#!/usr/bin/env node
'use strict';
// Read-only inventory. Supply the URI through the environment, never command-line credentials.
const {MongoClient} = require('mongodb');
async function audit(db) {
  const state = await db.collection('nito_state').findOne({schema_version: 2});
  const legacyTransactions = await db.collection('txes').countDocuments({schema_version: {$ne: 2}});
  const privateAddresses = await db.collection('addresses').countDocuments({a_id: /^(private_orchard$|(?:nito|tn|nrt)1x)/i});
  const markers = await db.collection('txes').countDocuments({$or: [{'vin.addresses': 'private_orchard'}, {'vout.addresses': 'private_orchard'}]});
  const duplicates = await db.collection('addresstxes').aggregate([
    {$group: {_id: {address: '$a_id', tx: '$txid'}, count: {$sum: 1}}}, {$match: {count: {$gt: 1}}}, {$count: 'groups'}
  ]).toArray();
  const types = await db.collection('addresses').aggregate([{$group: {_id: {$type: '$balance'}, count: {$sum: 1}}}]).toArray();
  return {schema_version: state?.schema_version || null, indexed_height: state?.height ?? null,
    indexed_hash: state?.hash || null, chain: state?.chain || null, legacy_transactions: legacyTransactions,
    private_address_records: privateAddresses, transactions_with_pseudo_outputs: markers,
    duplicate_address_transaction_groups: duplicates[0]?.groups || 0, balance_storage_types: types,
    requires_isolated_rebuild: !state || legacyTransactions > 0 || privateAddresses > 0 || markers > 0 || duplicates.length > 0,
    note: 'Read-only structural inventory; not proof of agreement with Core or a complete historical audit.'};
}
if (require.main === module) {
  (async () => {
    if (!process.env.NITO_AUDIT_MONGO_URI || !process.env.NITO_AUDIT_DATABASE) throw Error('Set NITO_AUDIT_MONGO_URI and NITO_AUDIT_DATABASE for an isolated copy');
    const client = new MongoClient(process.env.NITO_AUDIT_MONGO_URI, {serverSelectionTimeoutMS: 10000});
    try { await client.connect(); console.log(JSON.stringify(await audit(client.db(process.env.NITO_AUDIT_DATABASE)), null, 2)); }
    finally { await client.close(); }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = {audit};
