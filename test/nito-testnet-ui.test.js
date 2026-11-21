'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const pug = require('pug');

const root = path.resolve(__dirname, '..');
const switchTemplate = path.join(root, 'views', 'includes', 'network_switch.pug');

function assertPngAsset(relativePath, expectedHash, expectedWidth, expectedHeight) {
  const image = fs.readFileSync(path.join(root, relativePath));
  assert.equal(crypto.createHash('sha256').update(image).digest('hex'), expectedHash, `${relativePath} hash`);
  assert.equal(image.toString('ascii', 1, 4), 'PNG', `${relativePath} format`);
  assert.equal(image.readUInt32BE(16), expectedWidth, `${relativePath} width`);
  assert.equal(image.readUInt32BE(20), expectedHeight, `${relativePath} height`);
  assert.equal(image[25], 6, `${relativePath} must retain RGBA colour data`);
}

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
  assertPngAsset(
    path.join('public', 'img', 'nito-testnet-page-title-green.png'),
    'd2efc6bf6c170d321328b40a4b5a8d016cecfce75005835c49256b2cc1eccafb',
    48,
    48
  );
});

test('official mainnet artwork and browser icons remain exact RGBA assets', () => {
  const assets = [
    ['public/img/logo.png', '63e30d830a307e9640f66d3ee173099590119e3ce5efa74635636049a90d1c6b', 128],
    ['public/img/header-logo.png', '1a747893b2341e0a198b89cc66a0b6c6116a7d1ac196da57651d5009d5ada1f6', 64],
    ['public/img/page-title-img.png', '76941cc3b0879577c6da795c13e4528dcadc367f92dd6990bb1af77aa27978c5', 48],
    ['public/favicon-32.png', '4d530ba70e70d86e12d83b66a4baa9e3ee50fcd5bd53c083c5fb44a6c896061b', 32],
    ['public/favicon-128.png', '63e30d830a307e9640f66d3ee173099590119e3ce5efa74635636049a90d1c6b', 128],
    ['public/favicon-180.png', 'f5262d58b6259b23ecd330e8b25fcb97135032b44d0d09fe97ff23b792e6cd78', 180],
    ['public/favicon-192.png', '76c564a23e687f41ac3f397f6f96887c78be4758cfecaa80aebf9f60bc450856', 192]
  ];

  for (const [file, hash, size] of assets) assertPngAsset(file, hash, size, size);
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
  assert.match(html, /role="group" aria-label="Current network: Testnet"/);
  assert.match(html, /href="https:\/\/explorer\.nito\.network\/"/);
  assert.match(html, /aria-label="Switch to Mainnet"/);
  assert.match(html, /nito-network-current" aria-current="page">Testnet</);
  assert.match(html, /nito-network-target"[^>]*>Mainnet</);
  assert.doesNotMatch(html, /search|txid|address/i);
});

test('configured mainnet switch keeps Mainnet visibly current and Testnet secondary', () => {
  const html = renderSwitch({
    id: 'mainnet',
    label: 'Mainnet',
    switch: {
      enabled: true,
      url: 'https://testnet-explorer.nito.network/',
      label: 'Testnet'
    }
  });
  assert.match(html, /role="group" aria-label="Current network: Mainnet"/);
  assert.match(html, /nito-network-current" aria-current="page">Mainnet</);
  assert.match(html, /nito-network-target"[^>]*href="https:\/\/testnet-explorer\.nito\.network\/"[^>]*>Testnet</);
});

test('testnet layout metadata and visual styling stay profile-scoped', () => {
  const layout = fs.readFileSync(path.join(root, 'views', 'layout.pug'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'public', 'css', 'style.scss'), 'utf8');
  assert.match(layout, /robots_noindex/);
  assert.match(layout, /noindex,nofollow,noarchive/);
  assert.match(layout, /bodyClasses\.push\('network-testnet'\)/);
  assert.match(style, /\.network-testnet\s*\{/);
  assert.match(style, /#146c43/);
  assert.match(style, /\.nito-network-current\s*\{[\s\S]*?background-color:\s*#fff/);
  assert.match(style, /\.nito-network-target\s*\{[\s\S]*?&:focus-visible/);
  assert.doesNotMatch(style, /\.nito-network-target\s*\{[^}]*display:\s*none/s);
  assert.doesNotThrow(() => pug.compileFile(path.join(root, 'views', 'layout.pug')));
});
