'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {options} = require('../scripts/reindex_nito');
const root = path.resolve(__dirname, '..');
test('every reindex alias invokes the safe engine and explains its required isolated target', () => {
  const scripts = require('../package.json').scripts;
  for (const name of ['reindex', 'reindex-rich', 'reindex-txcount', 'reindex-last', 'rebuild-transparent-address-index']) {
    assert.equal(scripts[name], 'node ./scripts/reindex_nito.js');
    const result = spawnSync(process.execPath, ['./scripts/reindex_nito.js', '--help'], {cwd: root, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /complete archival replay/);
  }
  const denied = spawnSync(process.execPath, ['./scripts/reindex_nito.js'], {cwd: root, encoding: 'utf8', env: {...process.env, NITO_SETTINGS_PATH: ''}});
  assert.equal(denied.status, 1); assert.match(denied.stderr, /--isolated/);
});
test('operation options reject ambiguous arguments instead of running an old destructive mode', () => {
  assert.deepEqual(options(['--isolated', '--source-db', 'old_copy', '--target-db', 'new_copy', '--resume']),
    {isolated: true, 'source-db': 'old_copy', 'target-db': 'new_copy', resume: true});
  for (const args of [['--apply'], ['--target-db'], ['--source-db', '--target-db']]) assert.throws(() => options(args), /Unknown or incomplete/);
});
