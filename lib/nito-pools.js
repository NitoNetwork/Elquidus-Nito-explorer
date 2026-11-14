'use strict';
const money = require('./nito-amount');

function activation(tip) {
  if (!tip || !Number.isSafeInteger(tip.privateTxActivationHeight) || !Number.isSafeInteger(tip.blocks) ||
      typeof tip.activated !== 'boolean' || tip.privateTxActivationHeight < -1 ||
      tip.activated !== (tip.privateTxActivationHeight >= 0 && tip.blocks >= tip.privateTxActivationHeight))
    throw Error('Core activation metadata unavailable or inconsistent');
  return tip.activated;
}

function validate(raw, tip) {
  if (!raw || !tip || raw.chain !== tip.chain || raw.blocks !== tip.blocks || raw.bestblockhash !== tip.bestblockhash)
    throw Error('Pool snapshot does not match chain tip');
  if (activation(raw) !== activation(tip) || raw.privateTxActivationHeight !== tip.privateTxActivationHeight)
    throw Error('Pool activation does not match chain tip');
  const result = {chain: raw.chain, blocks: raw.blocks, bestblockhash: raw.bestblockhash,
    activated: raw.activated, privateTxActivationHeight: raw.privateTxActivationHeight,
    scope: 'confirmed_chain_value_including_immature', status: 'available'};
  for (const name of ['transparent', 'orchard', 'total']) {
    if (!raw[name] || raw[name].monitored !== true) throw Error('Pool accounting unavailable');
    const amount = money.integer(raw[name].chainValueNitoshi);
    if (amount < 0n || amount > money.MAX_MONEY || money.nitoshi(raw[name].chainValue) !== amount)
      throw Error('Invalid pool amount');
    result[name] = {chainValueNitoshi: amount.toString(), chainValue: money.coins(amount)};
  }
  if (BigInt(result.transparent.chainValueNitoshi) + BigInt(result.orchard.chainValueNitoshi) !== BigInt(result.total.chainValueNitoshi))
    throw Error('Pool accounting identity failed');
  return result;
}

// One flight per process; only the indexer persists snapshots. Readers reuse this
// collector, which never scans UTXOs without a fully synchronized coinstatsindex.
function collector(rpc) {
  let cached = null, pending = null;
  return async function collect() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const tip = await rpc('getblockchaininfo', []);
        activation(tip);
        if (cached && cached.chain === tip.chain && cached.bestblockhash === tip.bestblockhash && cached.blocks === tip.blocks &&
            cached.activated === tip.activated && cached.privateTxActivationHeight === tip.privateTxActivationHeight) return cached;
        cached = null;
        const indexes = await rpc('getindexinfo', ['coinstatsindex']);
        const index = indexes && indexes.coinstatsindex;
        if (!index || !index.synced || index.best_block_height !== tip.blocks) throw Error('coinstatsindex must be synchronized');
        const raw = await rpc('getorchardpools', []);
        const after = await rpc('getblockchaininfo', []);
        if (after.chain !== tip.chain || after.blocks !== tip.blocks || after.bestblockhash !== tip.bestblockhash) throw Error('Tip changed during pool collection');
        cached = validate(raw, after);
        return cached;
      } catch (error) {
        cached = null;
        return {status: 'unavailable', scope: 'confirmed_chain_value_including_immature', reason: error.message};
      }
    })();
    try { return await pending; } finally { pending = null; }
  };
}
module.exports = {validate, collector, activation};
