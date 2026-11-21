'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const assets = Object.freeze({
  'public/vendor/fontawesome/css/all.min.css': '74005d7c17d4a02f2f25404ec0655d9bc2fdaa53166874c87d7b7eec69d9088a',
  'public/vendor/fontawesome/webfonts/fa-brands-400.ttf': '808443ae6c8204395add8543da8a90a60b9376fb0f87ed8e8ea37d109596d805',
  'public/vendor/fontawesome/webfonts/fa-brands-400.woff2': 'd7236a19bf23cbb2027280e8f51dc99d6c45976a2ed60de73382b034b18a2b68',
  'public/vendor/fontawesome/webfonts/fa-regular-400.ttf': '54cf6086f7bb21f9d072ad494a19b4681fa516dd0a14cee52da01d3651a913a3',
  'public/vendor/fontawesome/webfonts/fa-regular-400.woff2': 'e3456d1283b9d75337a773dfd147bf908fd02c01b4bf48576d8603a69b13cbe5',
  'public/vendor/fontawesome/webfonts/fa-solid-900.ttf': 'd2f0593540b0e33ba6de255a54f272d466e31144806956bea8cfdbf7edffc9bd',
  'public/vendor/fontawesome/webfonts/fa-solid-900.woff2': 'aa75998623a391e61c6901794ace832e3ecdd288b56d608f21bea0411acc0b8e',
  'public/vendor/fontawesome/webfonts/fa-v4compatibility.ttf': '30f6abf6baa425825828793d6dfad1fb63765d0e5abaa7af6feafb9bfcece5a0',
  'public/vendor/fontawesome/webfonts/fa-v4compatibility.woff2': '0ce9033c69dc714f5f45ef9bf17d55e4c46bcdfad6799a4e92b38e7781bf86bd',
  'licenses/FONTAWESOME-FREE-6.7.2.txt': '9b914eae88817d63b576eab5aafde7068c7a1abae125d7cdfb034f1da43a9afc'
});

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath));
}

test('Font Awesome Free 6.7.2 remains a byte-exact local bundle', () => {
  for (const [file, expectedHash] of Object.entries(assets)) {
    const actualHash = crypto.createHash('sha256').update(read(file)).digest('hex');
    assert.equal(actualHash, expectedHash, `${file} hash`);
  }
});

test('the shared layout loads icons from the explorer origin only', () => {
  const layout = read('views/layout.pug').toString('utf8');
  assert.match(layout, /href='\/vendor\/fontawesome\/css\/all\.min\.css'/);
  assert.doesNotMatch(layout, /use\.fontawesome\.com/i);
});

test('the local stylesheet resolves every bundled font and essential menu icon', () => {
  const css = read('public/vendor/fontawesome/css/all.min.css').toString('utf8');
  assert.doesNotMatch(css, /url\(\s*['"]?(?:https?:)?\/\//i);

  for (const file of Object.keys(assets).filter(file => file.includes('/webfonts/')))
    assert.ok(css.includes(`../webfonts/${path.basename(file)}`), `${file} is referenced by the stylesheet`);

  for (const icon of [
    'fa-bars', 'fa-cubes', 'fa-network-wired', 'fa-btc', 'fa-circle-info',
    'fa-address-card', 'fa-rectangle-xmark', 'fa-github'
  ]) assert.ok(css.includes(`.${icon}`), `${icon} is defined by the local stylesheet`);
});
