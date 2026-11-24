const assert = require('node:assert/strict');
const test = require('node:test');
const createPageRefresh = require('../public/js/nito-page-refresh');

test('resumes the current table page once after a suspended request', async () => {
  const window = new EventTarget();
  const document = new EventTarget();
  const timers = new Set();
  let time = 0;
  window.navigator = {onLine: true};
  window.setTimeout = callback => {
    timers.add(callback);
    return callback;
  };
  window.clearTimeout = callback => timers.delete(callback);
  document.visibilityState = 'visible';
  const refresh = createPageRefresh(window, document, () => time);
  const settings = {};
  const reloads = [];
  const table = {
    settings: () => [settings],
    one(event, handler) {
      assert.equal(event, 'xhr');
      assert.equal(handler(null, settings, null), true);
    },
    ajax: {
      reload(callback, resetPaging) {
        reloads.push([callback, resetPaging]);
        settings.jqXHR = null;
      }
    }
  };
  let finishRequest;
  const initialRequest = new Promise(resolve => { finishRequest = resolve; });
  initialRequest.state = () => 'pending';
  settings.jqXHR = initialRequest;
  refresh.watch(() => refresh.reloadTable(table), {intervalMs: 60000, immediate: false});
  assert.equal(timers.size, 1);

  time = 2000;
  window.dispatchEvent(new Event('focus'));
  assert.equal(reloads.length, 0, 'keeps the DataTables request already running');
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(timers.size, 0);

  time += 120000;
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  const restored = new Event('pageshow');
  restored.persisted = true;
  window.dispatchEvent(restored);
  window.dispatchEvent(new Event('focus'));
  assert.equal(reloads.length, 0, 'waits for the interrupted request');

  settings.jqXHR = null;
  finishRequest();
  await new Promise(setImmediate);
  assert.deepEqual(reloads, [[null, false]]);
  assert.equal(timers.size, 1);
});
