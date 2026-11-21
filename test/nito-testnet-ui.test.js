'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const pug = require('pug');

const root = path.resolve(__dirname, '..');
const switchTemplate = path.join(root, 'views', 'includes', 'network_switch.pug');

function renderSwitch(network) {
  return pug.renderFile(switchTemplate, {
    settings: {
      network,
      localization: {
        network_current: 'Current network: {1}',
        network_switch_to: 'Switch to {1}'
      }
    }
  });
}

test('approved testnet logo remains byte-exact and 48 by 48 pixels', () => {
  const logo = fs.readFileSync(path.join(root, 'public', 'img', 'nito-testnet-page-title-green.png'));
  assert.equal(crypto.createHash('sha256').update(logo).digest('hex'), 'd2efc6bf6c170d321328b40a4b5a8d016cecfce75005835c49256b2cc1eccafb');
  assert.equal(logo.toString('ascii', 1, 4), 'PNG');
  assert.equal(logo.readUInt32BE(16), 48);
  assert.equal(logo.readUInt32BE(20), 48);
});

test('legacy mainnet profile does not add a network control', () => {
  const html = renderSwitch({id: 'mainnet', label: 'Mainnet', switch: {enabled: false}});
  assert.equal(html.trim(), '');
});

test('testnet control identifies the current network and links only to configured root', () => {
  const html = renderSwitch({
    id: 'testnet',
    label: 'Testnet',
    switch: {
      enabled: true,
      url: 'https://explorer.nito.network/',
      label: 'Mainnet'
    }
  });
  assert.match(html, /class="nito-network-control"/);
  assert.match(html, /href="https:\/\/explorer\.nito\.network\/"/);
  assert.match(html, /aria-label="Switch to Mainnet"/);
  assert.doesNotMatch(html, /aria-current/);
  assert.match(html, /nito-network-current">Testnet</);
  assert.match(html, /nito-network-target">Mainnet</);
  assert.doesNotMatch(html, /search|txid|address/i);
});

test('testnet layout metadata and visual styling stay profile-scoped', () => {
  const layout = fs.readFileSync(path.join(root, 'views', 'layout.pug'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'public', 'css', 'style.scss'), 'utf8');
  assert.match(layout, /robots_noindex/);
  assert.match(layout, /noindex,nofollow,noarchive/);
  assert.match(layout, /bodyClasses\.push\('network-testnet'\)/);
  assert.match(style, /\.network-testnet\s*\{/);
  assert.match(style, /#146c43/);
  assert.doesNotThrow(() => pug.compileFile(path.join(root, 'views', 'layout.pug')));
});
