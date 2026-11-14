'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {rows} = require('../public/js/nito-supply');
const labels = {total: 'Total', transparent: 'Transparent', orchard: 'Orchard', unavailable: 'Unavailable'};
test('compact supply uses three exact rows only after activation, and clears them on failure or reorg', () => {
  const active = {supply: '410088448.00000000', pools: {status: 'available', activated: true,
    total: {chainValue: '410088448.00000000'}, transparent: {chainValue: '410088447.99999999'}, orchard: {chainValue: '0.00000001'}}};
  assert.deepEqual(rows(active, labels), [
    {label: 'Total', value: '410,088,448'}, {label: 'Transparent', value: '410,088,447.99999999'}, {label: 'Orchard', value: '0.00000001'}]);
  assert.deepEqual(rows({...active, pools: {...active.pools, activated: false}}, labels), [{label: '', value: '410,088,448'}]);
  assert.deepEqual(rows({supply: null, pools: null}, labels), [{label: '', value: 'Unavailable'}]);
  assert.deepEqual(rows(null, labels), [{label: '', value: 'Unavailable'}]);
  assert.deepEqual(rows({supply: '1284565889.99999999'}, labels), [{label: '', value: '1,284,565,889.99999999'}]);
});
