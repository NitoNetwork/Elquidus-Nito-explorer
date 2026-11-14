'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createRequire} = require('node:module');

function load(file, dependencies) {
  const source = fs.readFileSync(file, 'utf8');
  const localRequire = createRequire(file);
  const sandbox = {module: {exports: {}}, console, setTimeout,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name)};
  vm.runInNewContext(source, sandbox, {filename: file});
  return sandbox.module.exports;
}

test('legacy HTTP explorer consumers return unavailable on malformed JSON, outages and HTTP failures', async () => {
  const methods = {
    get_difficulty: [], get_connectioncount: [], get_masternodelist: [], get_masternodecount: [],
    get_blockcount: [], get_blockhash: [1], get_block: ['hash'], get_rawtransaction: ['hash'],
    get_maxmoney: [], get_maxvote: [], get_vote: [], get_phase: [], get_reward: [],
    get_estnext: [], get_nextin: [], get_descriptorinfo: ['key'], get_deriveaddresses: ['descriptor'],
    get_peerinfo: [], verify_message: ['address', 'signature', 'message']
  };
  const rpcNames = ['getmininginfo', 'getnetworkhashps', 'getdifficulty', 'getconnectioncount', 'getmasternodelist',
    'getmasternodecount', 'getblockcount', 'getblockhash', 'getblock', 'getrawtransaction', 'getmaxmoney',
    'getmaxvote', 'getvote', 'getphase', 'getreward', 'getnextrewardestimate', 'getnextrewardwhenstr',
    'getdescriptorinfo', 'deriveaddresses', 'getpeerinfo', 'verifymessage'];
  const commands = Object.fromEntries(rpcNames.map(name => [name, name]));
  const settings = {webserver: {port: 1}, wallet: {}, localization: {ex_error: 'Error', check_console: 'Check console'},
    api_cmds: {...commands, use_rpc: false, rpc_concurrent_tasks: 1},
    api_page: {public_apis: {rpc: {getmasternodecount: {enabled: true}}}},
    blockchain_specific: {heavycoin: {api_cmds: commands}, bitcoin: {api_cmds: commands}},
    shared_pages: {show_hashrate: true, page_header: {panels: {network_panel: {nethash: 'netmhashps', nethash_units: 'M'}}}}};
  let current;
  const explorer = load(require.resolve('../lib/explorer'), {
    './http-client': (_options, cb) => queueMicrotask(() => cb(...current)),
    './settings': settings, './node': {Client: function() {}}, '../models/address': {}
  });
  for (current of [
    [Object.assign(new Error('Malformed JSON'), {code: 'INVALID_JSON'}), {statusCode: 200}, undefined],
    [new Error('Connection reset'), undefined, undefined],
    [null, {statusCode: 503}, {networkhashps: '1000000'}],
    [null, {statusCode: 200}, null]
  ]) {
    for (const [method, args] of Object.entries(methods))
      assert.equal(await new Promise(resolve => explorer[method](...args, resolve)), null, method);
    for (const source of ['netmhashps', 'getnetworkhashps']) {
      settings.shared_pages.page_header.panels.network_panel.nethash = source;
      assert.equal(await new Promise(resolve => explorer.get_hashrate(resolve)), '-');
    }
    const geo = await new Promise(resolve => explorer.get_geo_location('127.0.0.1', (error, value) => resolve({error, value})));
    assert.ok(geo.error);
    assert.equal(geo.value, null);
  }
  current = [null, {statusCode: 200}, {networkhashps: '123456789'}];
  settings.shared_pages.page_header.panels.network_panel.nethash = 'netmhashps';
  assert.equal(await new Promise(resolve => explorer.get_hashrate(resolve)), '123.4568');
});

test('every legacy market rejects malformed responses and non-success HTTP status before parsing data', async () => {
  for (const name of ['altmarkets', 'dextrade', 'freiexchange', 'nonkyc', 'xeggex', 'yobit']) {
    for (const response of [[new Error('Invalid JSON'), {statusCode: 200}, undefined],
      [null, {statusCode: 503}, {}], [null, undefined, {}]]) {
      const market = load(require.resolve('../lib/markets/' + name), {
        '../http-client': (_options, cb) => queueMicrotask(() => cb(...response)),
        '../ratelimit': {RateLimit: function() { this.schedule = fn => fn(); }}
      });
      const result = await new Promise(resolve => market.get_data({coin: 'nito', exchange: 'btc', api_error_msg: 'Unavailable'},
        (error, data) => resolve({error, data})));
      assert.ok(result.error, name);
      assert.equal(result.data, null, name);
    }
  }
});

test('CAPTCHA consumers fail closed on HTTP failures even with success-shaped provider bodies', async () => {
  const source = fs.readFileSync(require.resolve('../app'), 'utf8');
  const start = source.indexOf('function validate_captcha(');
  const functionSource = source.slice(start, source.indexOf('\n}', start) + 2);
  for (const provider of ['google_recaptcha3', 'google_recaptcha2', 'hcaptcha']) {
    let reply;
    const captcha = Object.fromEntries(['google_recaptcha3', 'google_recaptcha2', 'hcaptcha'].map(name =>
      [name, {enabled: name === provider, pass_score: 0.5, secret_key: 'test-only'}]));
    const sandbox = {module: {exports: {}}, settings: {captcha},
      require(name) {
        assert.equal(name, './lib/http-client');
        return (_options, cb) => queueMicrotask(() => cb(...reply));
      }};
    vm.runInNewContext(functionSource + '\nmodule.exports = validate_captcha;', sandbox);
    for (reply of [[new Error('Invalid JSON'), {statusCode: 200}, undefined],
      [null, {statusCode: 503}, {success: true, score: 1}], [null, undefined, {success: true, score: 1}]]) {
      assert.equal(await new Promise(resolve => sandbox.module.exports(true, {[provider]: 'test-only'}, resolve)), true, provider);
    }
    reply = [null, {statusCode: 200}, {success: true, score: 1}];
    assert.equal(await new Promise(resolve => sandbox.module.exports(true, {[provider]: 'test-only'}, resolve)), false, provider);
  }
});
