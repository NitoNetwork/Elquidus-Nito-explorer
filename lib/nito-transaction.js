'use strict';
const money = require('./nito-amount');

function privateAddress(address) {
  return typeof address === 'string' && (/^(nito|tn|nrt)1x/i.test(address) || address.toLowerCase() === 'private_orchard');
}

// Parse the entire transparent serialization, including canonical CompactSize,
// witness stacks and locktime. Orchard bytes are deliberately NOT guessed.
function transparentHex(hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return false;
  const b = Buffer.from(hex, 'hex');
  let p = 0;
  function skip(n) { if (!Number.isSafeInteger(n) || n < 0 || p + n > b.length) throw Error(); p += n; }
  function size() {
    skip(1); const first = b[p - 1];
    if (first < 253) return first;
    const bytes = first === 253 ? 2 : first === 254 ? 4 : 8;
    skip(bytes);
    const value = bytes === 8 ? b.readBigUInt64LE(p - bytes) : BigInt(b.readUIntLE(p - bytes, bytes));
    if (value < (bytes === 2 ? 253n : bytes === 4 ? 65536n : 4294967296n) || value > BigInt(b.length)) throw Error();
    return Number(value);
  }
  try {
    skip(4);
    let inputs = size(), witness = false;
    if (inputs === 0) {
      skip(1);
      if (b[p - 1] !== 1) return false;
      witness = true;
      inputs = size();
    }
    if (!inputs) return false;
    for (let i = 0; i < inputs; i++) { skip(36); skip(size()); skip(4); }
    const outputs = size();
    for (let i = 0; i < outputs; i++) { skip(8); skip(size()); }
    if (witness) {
      let nonempty = false;
      for (let i = 0; i < inputs; i++) {
        const count = size(); nonempty ||= count > 0;
        for (let j = 0; j < count; j++) skip(size());
      }
      if (!nonempty) return false;
    }
    skip(4);
    return p === b.length;
  } catch (_) { return false; }
}

function privacy(tx) {
  if (tx && (tx.has_private_bundle === true || tx.private_bundle != null)) return 'orchard';
  return tx && transparentHex(tx.hex) ? 'transparent' : 'unknown';
}

function paymentOutputCount(vout) {
  if (!Array.isArray(vout)) return 0;
  // Core identifies witness commitments and other provably unspendable data
  // outputs as nulldata. Keep those rows in transaction details, but do not
  // present them as payments or recipients in summary lists.
  return vout.filter(output => output && output.script_type !== 'nulldata').length;
}

function poolMovement(orchard) {
  if (!orchard || typeof orchard !== 'object') return null;
  try {
    let delta;
    if (orchard.pool_delta_nitoshi != null) delta = money.integer(orchard.pool_delta_nitoshi);
    else if (orchard.value_balance_nitoshi != null) delta = -money.integer(orchard.value_balance_nitoshi);
    else return null;
    if (orchard.pool_delta_nitoshi != null && orchard.value_balance_nitoshi != null &&
        delta !== -money.integer(orchard.value_balance_nitoshi)) return null;
    const amount = delta < 0n ? -delta : delta;
    return {direction: delta > 0n ? 'entry' : delta < 0n ? 'exit' : 'neutral',
      amount_nitoshi: amount.toString(), pool_delta_nitoshi: delta.toString()};
  } catch (_) { return null; }
}

async function normalize(tx, rpc, block) {
  if (!tx || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) throw Error('Transaction RPC unavailable');
  const state = privacy(tx);
  const coinbase = tx.vin.length === 1 && tx.vin[0].coinbase != null;
  let input = 0n, output = 0n, complete = true, balance = null, actions = null;
  const vin = [], vout = [];
  async function add(array, script, amount, index) {
    let address = script && (script.address || (script.addresses && script.addresses.length === 1 && script.addresses[0]));
    // Preserve the inherited P2PK public-key/P2PKH grouping, using Core's
    // network-aware descriptor RPC instead of locally guessing an address.
    let addressKind = 'script';
    if (!address && script?.type === 'pubkey' && /^([0-9a-f]{66}|[0-9a-f]{130}) OP_CHECKSIG$/i.test(script.asm || '')) {
      const descriptor = await rpc('getdescriptorinfo', ['pkh(' + script.asm.split(' ')[0] + ')']);
      [address] = await rpc('deriveaddresses', [descriptor.descriptor]);
      addressKind = 'p2pk_public_key_alias';
    }
    if (privateAddress(address)) throw Error('Private receiver in transparent RPC output');
    array.push({addresses: address || null, amount: amount.toString(), n: index,
      script: script && script.hex, script_type: script && script.type, address_kind: addressKind});
  }
  for (const out of tx.vout) {
    const amount = money.nitoshi(out.value);
    if (amount < 0n) throw Error('Negative output');
    output += amount; await add(vout, out.scriptPubKey, amount, out.n);
  }
  if (coinbase) vin.push({addresses: 'coinbase', amount: output.toString()});
  else for (const prev of tx.vin) {
    let out = prev.prevout;
    try {
      if (!out) {
        const parent = await rpc('getrawtransaction', [prev.txid, true]);
        out = parent.vout.find(o => o.n === prev.vout);
      }
      if (!out) throw Error('Previous output missing');
      const amount = money.nitoshi(out.value);
      if (amount < 0n) throw Error('Negative previous output');
      input += amount; await add(vin, out.scriptPubKey, amount, prev.vout);
    } catch (_) {
      complete = false;
      vin.push({addresses: null, amount: null, txid: prev.txid, n: prev.vout});
    }
  }
  if (state === 'transparent') balance = 0n;
  else if (state === 'orchard' && tx.private_bundle) {
    try { balance = money.nitoshi(tx.private_bundle.value_balance); } catch (_) { /* unavailable */ }
    if (Number.isSafeInteger(tx.private_bundle.actions) && tx.private_bundle.actions > 0) actions = tx.private_bundle.actions;
  }
  let fee = !coinbase && complete && balance != null ? input + balance - output : null;
  if (fee != null && (fee < 0n || fee > money.MAX_MONEY)) throw Error('Invalid transaction fee');
  if (!coinbase && tx.fee != null) {
    const reported = money.nitoshi(tx.fee);
    if (reported < 0n || (fee != null && reported !== fee)) throw Error('RPC fee mismatch');
    fee = reported;
  }
  if (output > money.MAX_MONEY || input > money.MAX_MONEY) throw Error('Transaction outside money range');
  return {
    schema_version: 2, txid: tx.txid, vin, vout, total: output.toString(),
    total_scope: 'transparent_outputs', privacy: state, coinbase,
    raw_output_count: vout.length,
    payment_output_count: paymentOutputCount(vout),
    payment_output_scope: 'transparent_non_nulldata_outputs',
    metadata_complete: state !== 'unknown' && complete && (state !== 'orchard' || (balance != null && actions != null)),
    transparent_input_nitoshi: coinbase || !complete ? null : input.toString(),
    transparent_output_nitoshi: output.toString(),
    fee_nitoshi: fee == null ? null : fee.toString(),
    orchard: state === 'orchard' ? {actions, value_balance_nitoshi: balance == null ? null : balance.toString(),
      pool_delta_nitoshi: balance == null ? null : (-balance).toString()} : null,
    size: Number.isSafeInteger(tx.size) ? tx.size : null,
    timestamp: tx.time || (block && block.time) || null,
    blockhash: (block && block.hash) || tx.blockhash || null,
    blockindex: block ? block.height : (tx.blockheight == null ? -1 : tx.blockheight),
    confirmations: block ? block.confirmations : (tx.confirmations == null ? 0 : tx.confirmations),
    tx_type: state === 'orchard' ? 'nito_orchard' : state === 'unknown' ? 'unknown' : null
  };
}

function publicRecord(tx) {
  const value = typeof tx.toObject === 'function' ? tx.toObject() : {...tx};
  delete value._id; delete value.__v;
  value.vin = (value.vin || []).filter(v => !v.private_marker && !privateAddress(v.addresses));
  value.vout = (value.vout || []).filter(v => !v.private_marker && !privateAddress(v.addresses));
  value.raw_output_count = value.vout.length;
  value.payment_output_count = paymentOutputCount(value.vout);
  value.payment_output_scope = 'transparent_non_nulldata_outputs';
  if (value.schema_version !== 2) {
    value.privacy = value.tx_type === 'nito_orchard' ? 'orchard' : 'unknown';
    value.metadata_complete = false; value.total = null; value.total_scope = 'unavailable_legacy';
    value.fee_nitoshi = null; value.orchard = null;
  } else value.total = String(value.total);
  return value;
}

module.exports = {privateAddress, transparentHex, privacy, paymentOutputCount, poolMovement, normalize, publicRecord};
