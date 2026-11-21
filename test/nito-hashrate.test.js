'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const hashrate = require('../public/js/nito-hashrate');

test('adaptive hashrate uses exact base-1000 display boundaries', () => {
  assert.deepEqual(hashrate.scale('999', 'H'), { value: 999, unitKey: 'H', unit: 'H/s' });
  assert.deepEqual(hashrate.scale('1000', 'H'), { value: 1, unitKey: 'K', unit: 'kH/s' });
  assert.deepEqual(hashrate.scale('1001', 'H'), { value: 1.001, unitKey: 'K', unit: 'kH/s' });

  assert.deepEqual(hashrate.scale('999', 'T'), { value: 999, unitKey: 'T', unit: 'TH/s' });
  assert.deepEqual(hashrate.scale('1000', 'T'), { value: 1, unitKey: 'P', unit: 'PH/s' });
  assert.deepEqual(hashrate.scale('1001', 'T'), { value: 1.001, unitKey: 'P', unit: 'PH/s' });
});

test('adaptive hashrate converts from the explorer configured source unit', () => {
  assert.deepEqual(hashrate.scale('0.2976', 'P'), { value: 297.6, unitKey: 'T', unit: 'TH/s' });
  assert.deepEqual(hashrate.scale('1.001', 'P'), { value: 1.001, unitKey: 'P', unit: 'PH/s' });
  assert.deepEqual(hashrate.scale('0.000000001', 'P'), { value: 1, unitKey: 'M', unit: 'MH/s' });
  assert.deepEqual(hashrate.scale('1000', 'P'), { value: 1, unitKey: 'E', unit: 'EH/s' });
});

test('chart series uses one coherent adaptive unit selected from its peak', () => {
  assert.deepEqual(hashrate.scaleSeries(['0.5', '999', '1001'], 'T'), {
    values: [0.0005, 0.999, 1.001],
    unitKey: 'P',
    unit: 'PH/s'
  });
  assert.deepEqual(hashrate.scaleSeries(['500', '999'], 'T'), {
    values: [500, 999],
    unitKey: 'T',
    unit: 'TH/s'
  });
});

test('invalid or unavailable hashrate remains unavailable', () => {
  for (const value of [null, '', 'not-a-number', '-1', 'Infinity'])
    assert.equal(hashrate.scale(value, 'P'), null);
  assert.equal(hashrate.scale('1', 'invalid'), null);
});

test('UI adapts the API value without changing the legacy API field contract', () => {
  const layout = fs.readFileSync(path.join(__dirname, '..', 'views', 'layout.pug'), 'utf8');

  assert.match(layout, /NitoHashrate\.scale\(json\.hashrate, networkHashSourceUnit\)/);
  assert.match(layout, /NitoHashrate\.scaleSeries\(sourceChartData\.map/);
  assert.doesNotMatch(layout, /json\.hashrate\s*=/);
});
