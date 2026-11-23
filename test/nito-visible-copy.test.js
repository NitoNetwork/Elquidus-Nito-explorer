'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const jsonminify = require('jsonminify');
const pug = require('pug');

const root = path.resolve(__dirname, '..');
const editedViews = [
  'views/nito-richlist.pug',
  'views/address.pug',
  'views/movement.pug',
  'views/nito-tx.pug',
  'views/info.pug',
  'views/network.pug',
  'views/market.pug'
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('public pages omit operator explanations and chain snapshot debug text', () => {
  const visibleSources = editedViews.map(read).join('\n') + read('locale/en.json');

  for (const text of [
    'Transparent addresses only',
    'Percentages use the transparent UTXO pool',
    'Chart proportions are rounded',
    'Country is an approximate IP-based estimate',
    'Market prices and charts are approximate provider data'
  ]) assert.doesNotMatch(visibleSources, new RegExp(text));

  const richlist = read('views/nito-richlist.pug');
  assert.doesNotMatch(richlist, /stats\.pools\.(?:chain|blocks|bestblockhash)/);
  assert.doesNotMatch(richlist, /nito_(?:rich|chart)_scope/);
});

test('compact labels still identify the transparent rich-list scope', () => {
  const locale = JSON.parse(jsonminify(read('locale/en.json')));

  assert.equal(locale.rl_title, 'Top {1} Transparent Addresses');
  assert.equal(locale.rl_current_balance, 'Top 100 · Transparent Balance');
  assert.equal(locale.rl_received_coins, 'Top 100 · Transparent Received');
  assert.equal(locale.nito_balance, 'Net Orchard value balance');
  assert.equal(locale.nito_other, '101+');
  assert.equal(locale.rl_hundredplus, '101+');
  assert.match(read('views/nito-richlist.pug'), /rl_wealth \+ ' · ' \+ settings\.localization\.nito_supply_transparent/);
});

test('cleaned public templates compile and retain required unavailable states', () => {
  for (const view of editedViews)
    assert.doesNotThrow(() => pug.compileFile(path.join(root, view)), view);

  assert.match(read('views/nito-richlist.pug'), /nito_unavailable/);
  assert.match(read('views/nito-tx.pug'), /nito_incomplete/);
});

test('transaction copy distinguishes Orchard bundle data from coinbase presentation', () => {
  const locale = JSON.parse(jsonminify(read('locale/en.json')));
  const transaction = read('views/nito-tx.pug');

  assert.equal(locale.nito_actions, 'Orchard bundle actions');
  assert.match(locale.nito_pool_entry, /Net entry.*Orchard pool/i);
  assert.match(locale.nito_pool_exit, /Net exit.*Orchard pool/i);
  assert.match(transaction, /orchardMovement\.direction == 'entry'/);
  assert.match(transaction, /orchardMovement\.direction == 'exit'/);
  assert.match(transaction, /script_type\s*!=\s*'nulldata'/);
  assert.match(transaction, /row\.addresses == 'coinbase'/);
  assert.match(transaction, /table-info/);
  assert.match(transaction, /new_coins/);
  assert.match(transaction, /if tx\.privacy == 'orchard'[\s\S]*nito_privacy/);
  assert.doesNotMatch(transaction, /tx\.privacy == 'transparent' \? settings\.localization\.nito_outputs/);
});

test('transaction table headers use concise output labels without changing transaction detail copy', () => {
  const locale = JSON.parse(jsonminify(read('locale/en.json')));

  assert.equal(locale.nito_table_outputs, 'outputs');
  assert.equal(locale.nito_table_output_value, 'output value');
  assert.equal(locale.nito_outputs, 'Transparent outputs');

  for (const view of ['views/index.pug', 'views/block.pug']) {
    const source = read(view);
    assert.match(source, /settings\.localization\.nito_table_outputs/);
    assert.match(source, /settings\.localization\.nito_table_output_value/);
  }
});

test('peer and footer labels distinguish active connections from 24-hour observations', () => {
  const locale = JSON.parse(jsonminify(read('locale/en.json')));
  const layout = read('views/layout.pug');

  assert.equal(locale.net_connections, 'Peers (24h)');
  assert.equal(locale.net_active_connection, 'active connection');
  assert.equal(locale.net_active_connections, 'active connections');
  assert.match(layout, /connectionCount === 1/);
  assert.match(layout, /footer\.style\.minHeight = height/);
  assert.match(read('public/css/style.scss'), /clamp\(16px, var\(--footer-icon-size, 22px\), 24px\)/);
  assert.doesNotMatch(layout, /\$\('#footer-container'\)\.height\(\) \* \(socialLinkHeight/);
});
