'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const amounts = require('../public/js/nito-amount');

test('browser integrations can read the additive exact-amount and network headers through CORS', () => {
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.match(app, /Access-Control-Expose-Headers[^\n]+X-Nito-Network[^\n]+X-Nito-Amount-Format[^\n]+X-Amount-Scope/);
});

test('browser amount consumer preserves nitoshis beyond Number precision', () => {
  assert.equal(amounts.format('1284565889.99999999'), '1,284,565,889.99999999');
  assert.equal(amounts.format('-0.00000001'), '-0.00000001');
  assert.equal(amounts.compare('9', '10'), -1);
  assert.equal(amounts.compare('1284565889.99999999', '1284565889.99999998'), 1);
  assert.equal(amounts.marketValue('1', '1284565889.99999999'), '1,284,565,889.99999999');
  assert.equal(amounts.marketValue(0.01, '1.99999999'), '0.02000000');
  for (const value of [null, undefined, '', 'Unavailable', 'NaN', 0.01, '0.000000001']) {
    assert.equal(amounts.format(value), null);
    assert.equal(amounts.compare(value, '1'), null);
  }
  for (const value of [null, undefined, NaN, Infinity, -1, 'bogus']) assert.equal(amounts.marketValue(value, '100'), null);
  assert.equal(amounts.marketValue(1, null), null);
  const browser = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/nito-amount.js'), 'utf8'), browser);
  assert.equal(browser.NitoAmount.format('410088447.99993393'), '410,088,447.99993393');
});

test('movement rows use exact warning comparisons and preserve unavailable/Orchard states', () => {
  const source = fs.readFileSync(path.join(__dirname, '../views/movement.pug'), 'utf8').replace(/\r\n/g, '\n');
  const callback = source.slice(source.indexOf('          var blockindex ='), source.indexOf('        },\n        fnDrawCallback'));
  const cells = new Map();
  const context = {NitoAmount: amounts, data: [1, 'hash', 'tx', 0, '1284565889.99999999', 123, 'privacy:orchard'], row: {},
    $: selector => ({html(value) { cells.set(selector, value); return this; }, addClass() { return this; }}), format_unixtime: () => 'time'};
  const executable = callback.replace(/#\{settings\.movement_page\.movement_table\.high_warning_flag\}/g, '1000000000')
    .replace(/#\{settings\.movement_page\.movement_table\.low_warning_flag\}/g, '1000000')
    .replace(/#\{settings\.shared_pages\.date_time\.enable_alt_timezone_tooltips\}/g, 'false')
    .replace(/#\{[^}]+\}/g, 'Unavailable');
  vm.runInNewContext(executable, context);
  assert.match(cells.get('td:eq(2)'), /1,284,565,889\.<span class="decimal">99999999/);
  assert.match(cells.get('td:eq(2)'), /bg-danger/);
  assert.match(cells.get('td:eq(2)'), /Orchard/);
  context.data[4] = null; context.data[6] = 'privacy:unknown';
  vm.runInNewContext(executable, context);
  assert.match(cells.get('td:eq(2)'), /bg-secondary/);
  assert.match(cells.get('td:eq(2)'), /Unavailable/);
  assert.doesNotMatch(cells.get('td:eq(2)'), /NaN|undefined/);
});

test('every distributed locale supplies all new Nito and market labels', () => {
  const defaults = require('../lib/locale').localization;
  const minify = require('jsonminify');
  const directory = path.join(__dirname, '../locale');
  const keys = Object.keys(defaults).filter(key => key.startsWith('nito_') || ['mkt_data_stale', 'mkt_data_unavailable', 'mkt_approximate_chart'].includes(key));
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.json'))) {
    const locale = JSON.parse(minify(fs.readFileSync(path.join(directory, file), 'utf8')));
    for (const key of keys) assert.equal(typeof locale[key] === 'string' && locale[key].trim().length > 0, true, file + ': ' + key);
  }
});

test('nonmonetary hashrate lexemes remain usable in every display unit', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/explorer.js'), 'utf8');
  const implementation = source.slice(source.indexOf('function convertHashUnits('), source.indexOf('function processVoutAddresses('));
  const context = {settings: {shared_pages: {page_header: {panels: {network_panel: {nethash_units: 'H'}}}}}};
  vm.runInNewContext(implementation, context);
  assert.equal(context.convertHashUnits('123.456789'), '123.4568');
  for (const value of [null, '', 'bad', '-1', 'Infinity']) assert.equal(context.convertHashUnits(value), '-');
  for (const [unit, value] of [['K', '1000.125'], ['M', '1000000.125'], ['G', '1000000000.125'], ['T', '1000000000000.125'], ['P', '1000000000000000.125']]) {
    context.settings.shared_pages.page_header.panels.network_panel.nethash_units = unit;
    assert.match(context.convertHashUnits(value), /^1\.000[01]$/);
  }
  context.settings.shared_pages.page_header.panels.network_panel.nethash_units = 'P';
  assert.equal(context.convertHashUnits('1100.040564404735'), '0.0000000000011000');
});

test('legacy masternode monetary endpoints fail explicitly instead of rounding or inventing rewards', async t => {
  process.env.NITO_SETTINGS_PATH = path.join(__dirname, 'isolated-missing-settings.json');
  const express = require('express');
  const app = express();
  app.use(require('../lib/nito-api'));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  for (const method of ['getmasternoderewards', 'getmasternoderewardstotal']) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/ext/' + method + '/transparent/0');
    assert.equal(response.status, 410);
    assert.equal(response.headers.get('x-nito-amount-format'), 'decimal-string-v1');
    assert.equal(response.headers.get('x-nito-network'), 'mainnet');
    assert.equal((await response.json()).code, 'unsupported_nito_feature');
  }
});
