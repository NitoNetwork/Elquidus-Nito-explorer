'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const pug = require('pug');
const provenance = require('../lib/provenance');

const full = 'a'.repeat(40);
const other = 'b'.repeat(40);
const root = path.resolve(__dirname, '..');

function runner(revision = full, status = '') {
  return (_command, args) => args[0] === 'status' ? status : revision + '\n';
}

test('source provenance links the exact clean checkout revision', () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push([command, args, options.cwd]);
    return runner()(command, args);
  };
  assert.deepEqual(provenance.resolve({root, environment: {NITO_EXPLORER_REQUIRE_CLEAN_REVISION: '1'}, execFileSync: run}), {
    repositoryUrl: provenance.REPOSITORY_URL,
    revision: full,
    shortRevision: 'aaaaaaa',
    sourceUrl: provenance.REPOSITORY_URL + '/tree/' + full
  });
  assert.deepEqual(calls.find(call => call[1][0] === 'status')[1], ['status', '--porcelain=v1', '--untracked-files=all']);
  assert.throws(() => provenance.resolve({root, environment: {NITO_EXPLORER_REVISION: other}, execFileSync: runner()}), /does not match/);
  assert.throws(() => provenance.resolve({root, environment: {NITO_EXPLORER_REQUIRE_CLEAN_REVISION: '1'}, execFileSync: runner(full, ' M app.js')}), /clean Git/);
  assert.throws(() => provenance.resolve({root, environment: {NITO_EXPLORER_REQUIRE_CLEAN_REVISION: '1'}, execFileSync: runner(full, '?? private-note.txt')}), /clean Git/);
});

test('archive provenance accepts only an explicit full revision and otherwise uses the repository root', () => {
  const unavailable = () => { throw new Error('git unavailable'); };
  assert.equal(provenance.resolve({root, environment: {}, execFileSync: unavailable}).sourceUrl, provenance.REPOSITORY_URL);
  assert.equal(provenance.resolve({root, environment: {NITO_EXPLORER_REVISION: full}, execFileSync: unavailable}).revision, full);
  assert.throws(() => provenance.resolve({root, environment: {NITO_EXPLORER_REVISION: 'abc'}, execFileSync: unavailable}), /40-character/);
  assert.throws(() => provenance.resolve({root, environment: {NITO_EXPLORER_REQUIRE_CLEAN_REVISION: 'yes'}, execFileSync: unavailable}), /must be 0 or 1/);
  assert.throws(() => provenance.resolve({root, environment: {NITO_EXPLORER_REQUIRE_CLEAN_REVISION: '1'}, execFileSync: unavailable}), /verified Git revision/);
});

test('footer renders escaped official source provenance without configured HTML', () => {
  const html = pug.renderFile(path.join(root, 'views', 'includes', 'provenance.pug'), {settings: {
    explorer_version: '1.102.0', revision: 'aaaaaaa', explorer_source_url: provenance.REPOSITORY_URL + '/tree/' + full
  }});
  assert.match(html, /NITO Explorer v1\.102\.0-aaaaaaa/);
  assert.match(html, new RegExp(`href="${provenance.REPOSITORY_URL}/tree/${full}"`));
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /team-exor|!\{|script/i);
});
