'use strict';

const settings = require('./settings');

const CHAIN_COLLECTIONS = [
  'coinstats',
  'txes',
  'addresses',
  'addresstxes',
  'nito_blocks',
  'nito_pools',
  'orphans'
];

function rootHttpsUrl(value, name, required = false) {
  if (value == null || value === '') {
    if (required) throw new Error(`${name} must be an absolute HTTPS URL`);
    return '';
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== ''))
    throw new Error(`${name} must be an HTTPS origin without credentials, query, fragment or path`);

  return `${parsed.origin}/`;
}

function normalize(profile = settings.network, environment = process.env) {
  const value = profile || {};
  const id = String(value.id || '').toLowerCase();
  const label = String(value.label || '').trim();
  const expectedChain = String(value.expected_chain || '').toLowerCase();
  const expectedGenesis = String(value.expected_genesis || '').toLowerCase();
  const processSuffix = String(value.process_suffix || '').toLowerCase();
  const requiredIndexes = Array.isArray(value.require_indexes) ? [...new Set(value.require_indexes.map(String))] : [];
  const enabled = value.enforce === true;

  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error('network.id must be a lowercase identifier');
  if (!label || label.length > 32) throw new Error('network.label must contain between 1 and 32 characters');
  if (enabled && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(expectedChain)) throw new Error('network.expected_chain must be configured');
  if (enabled && !/^[0-9a-f]{64}$/.test(expectedGenesis)) throw new Error('network.expected_genesis must be a 64-character hexadecimal block hash');
  if (enabled && (!requiredIndexes.includes('txindex') || !requiredIndexes.includes('coinstatsindex')))
    throw new Error('network.require_indexes must include txindex and coinstatsindex');
  if (enabled && (!Number.isSafeInteger(value.private_activation_height) || value.private_activation_height < 0))
    throw new Error('network.private_activation_height must be a non-negative safe integer');
  if (processSuffix && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(processSuffix)) throw new Error('network.process_suffix must be empty or a lowercase identifier');
  if (requiredIndexes.some(index => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(index))) throw new Error('network.require_indexes contains an invalid index name');

  const publicUrl = rootHttpsUrl(value.public_url, 'network.public_url', enabled);
  const switchSettings = value.switch || {};
  const switchEnabled = switchSettings.enabled === true;
  const switchUrl = rootHttpsUrl(switchSettings.url, 'network.switch.url', switchEnabled);
  const switchLabel = String(switchSettings.label || '').trim();
  if (switchEnabled && (!switchLabel || switchLabel.length > 32)) throw new Error('network.switch.label must contain between 1 and 32 characters');
  if (switchEnabled && switchUrl === publicUrl) throw new Error('network.switch.url must point to another explorer origin');

  const instanceId = String(environment.NITO_INSTANCE_ID || '').toLowerCase();
  if (instanceId && instanceId !== processSuffix)
    throw new Error(`NITO_INSTANCE_ID ${instanceId} does not match network.process_suffix ${processSuffix || '(empty)'}`);

  const exchanges = settings.markets_page && settings.markets_page.exchanges;
  const exchangeEnabled = exchanges && Object.values(exchanges).some(exchange => exchange && exchange.enabled === true);
  if (value.allow_market_data === false && settings.markets_page &&
      (settings.markets_page.enabled === true || settings.markets_page.market_price === 'COINGECKO' || exchangeEnabled))
    throw new Error(`Market data must remain disabled for the ${id} explorer profile`);

  return {
    id,
    label,
    enforce: enabled,
    expected_chain: expectedChain,
    expected_genesis: expectedGenesis,
    process_suffix: processSuffix,
    public_url: publicUrl,
    robots_noindex: value.robots_noindex === true,
    allow_market_data: value.allow_market_data !== false,
    require_indexes: requiredIndexes,
    require_synced: value.require_synced === true,
    private_activation_height: Number.isSafeInteger(value.private_activation_height) ? value.private_activation_height : null,
    require_private_active: value.require_private_active === true,
    switch: {enabled: switchEnabled, url: switchUrl, label: switchLabel}
  };
}

async function verify(options = {}) {
  const profile = normalize(options.profile, options.environment);
  if (!profile.enforce) return {profile, status: 'disabled'};

  const rpc = options.rpc || require('./nito-rpc').rpc;
  const database = options.database;
  const coin = options.coin || settings.coin.name;
  if (!database || typeof database.collection !== 'function') throw new Error('Network verification requires a MongoDB database handle');

  const hello = await database.command({hello: 1});
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Atomic explorer indexing requires a MongoDB replica set');

  const tip = await rpc('getblockchaininfo', []);
  if (!tip || tip.chain !== profile.expected_chain)
    throw new Error(`Core network mismatch: expected ${profile.expected_chain}, received ${tip && tip.chain ? tip.chain : 'unavailable'}`);
  if (tip.pruned === true) throw new Error('Full explorer indexing requires an archival Core node');
  if (profile.require_synced && tip.initialblockdownload !== false) throw new Error('Core is still in initial block download');
  if (profile.private_activation_height != null && tip.privateTxActivationHeight !== profile.private_activation_height)
    throw new Error(`Core private activation mismatch: expected height ${profile.private_activation_height}`);
  if (profile.require_private_active && tip.activated !== true) throw new Error('Core does not report private transactions as active');

  const genesis = String(await rpc('getblockhash', [0])).toLowerCase();
  if (genesis !== profile.expected_genesis)
    throw new Error(`Core genesis mismatch: expected ${profile.expected_genesis}, received ${genesis || 'unavailable'}`);

  const indexes = await rpc('getindexinfo', []);
  for (const name of profile.require_indexes) {
    if (!indexes || !indexes[name]) throw new Error(`Required Core index ${name} is not enabled`);
    if (indexes[name].synced !== true) throw new Error(`Required Core index ${name} is not synchronized`);
  }

  const state = await database.collection('nito_state').findOne({_id: coin});
  if (state) {
    if (state.schema_version !== 2 || state.chain !== profile.expected_chain || String(state.genesis).toLowerCase() !== profile.expected_genesis)
      throw new Error('MongoDB explorer state does not match the configured network, genesis or schema');
  } else {
    for (const name of CHAIN_COLLECTIONS) {
      if (await database.collection(name).findOne({}, {projection: {_id: 1}}))
        throw new Error(`MongoDB collection ${name} contains chain data without a verified nito_state record`);
    }
  }

  return {profile, status: 'verified', chain: tip.chain, genesis, blocks: tip.blocks, bestblockhash: tip.bestblockhash, state: state || null};
}

module.exports = {CHAIN_COLLECTIONS, normalize, rootHttpsUrl, verify};
