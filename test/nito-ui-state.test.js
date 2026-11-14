'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('an open supply card follows activation, RPC failure and recovery without reload', () => {
  const source = fs.readFileSync(require.resolve('../views/includes/nito-pools.pug'), 'utf8').split('script.')[1]
    .replace(/#\{[^}]+\}/g, 'label');
  const nodes = new Map(); let refresh, clear, request, removed = false;
  function $(selector) {
    if (typeof selector === 'function') return selector();
    if (!nodes.has(selector)) nodes.set(selector, {});
    const node = nodes.get(selector);
    const api = {prop(key, value) {node[key] = value; return api;}, text(value) {node.text = value; return api;}, addClass() {return api;}};
    return api;
  }
  $.ajax = options => {request = {options}; const chain = {done(fn) {request.success = fn; return chain;}, fail(fn) {request.failure = fn; return chain;}}; return chain;};
  vm.runInNewContext(source, {$, NitoAmount: require('../public/js/nito-amount'),
    setInterval(fn, duration) {assert.equal(duration, 60000); refresh = fn; return 7;},
    clearInterval(id) {assert.equal(id, 7); removed = true;}, window: {addEventListener(event, fn) {assert.equal(event, 'pagehide'); clear = fn;}}});
  const active = {status: 'available', activated: true, chain: 'regtest', blocks: 1, bestblockhash: 'a',
    total: {chainValue: '1.00000000'}, transparent: {chainValue: '1.00000000'}, orchard: {chainValue: '0.00000000'}};
  assert.equal(request.options.timeout, 10000);
  request.success(active); assert.equal(nodes.get('#nito-pools').hidden, false);
  assert.equal(nodes.get('[data-pool="orchard"]').text, '0.00000000 label');
  refresh(); request.success({...active, activated: false}); assert.equal(nodes.get('#nito-pools').hidden, true);
  refresh(); request.success(active); assert.equal(nodes.get('#nito-pools').hidden, false);
  refresh(); request.failure(); assert.equal(nodes.get('#nito-pools').hidden, true);
  assert.equal(nodes.get('#nito-pool-tip').text, '');
  refresh(); request.success({status: 'unavailable'}); assert.equal(nodes.get('#nito-pools').hidden, true);
  clear(); assert.equal(removed, true);
});
