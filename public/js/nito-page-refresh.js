'use strict';

(function(root, factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory;
  else
    root.NitoPageRefresh = factory(root, root.document);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(window, document, now = Date.now) {
  const jobs = new Set();
  const resumeDebounceMs = 1500;
  let pageShown = true;

  function isActive() {
    return pageShown && document.visibilityState === 'visible' && window.navigator.onLine !== false;
  }

  function clearTimer(job) {
    window.clearTimeout(job.timer);
    job.timer = undefined;
  }

  function schedule(job) {
    clearTimer(job);
    if (job.intervalMs > 0 && isActive())
      job.timer = window.setTimeout(() => refresh(job), job.intervalMs);
  }

  async function refresh(job) {
    if (!isActive() || job.running)
      return;

    clearTimer(job);
    job.running = true;
    job.startedAt = now();
    try {
      await job.load();
    } catch {
      // The request owns its error handling. Keep automatic refresh running.
    } finally {
      job.running = false;
      if (job.resumePending) {
        job.resumePending = false;
        if (isActive()) {
          refresh(job);
          return;
        }
      }
      schedule(job);
    }
  }

  function resume() {
    if (!isActive())
      return;

    const time = now();
    for (const job of jobs) {
      const age = time - job.startedAt;
      if (age >= 0 && age < resumeDebounceMs)
        continue;

      if (job.running)
        job.resumePending = true;
      else
        refresh(job);
    }
  }

  function pause() {
    for (const job of jobs)
      clearTimer(job);
  }

  document.addEventListener('visibilitychange', () => {
    if (isActive())
      resume();
    else
      pause();
  });
  window.addEventListener('pageshow', event => {
    pageShown = true;
    if (event.persisted)
      resume();
  });
  window.addEventListener('pagehide', () => {
    pageShown = false;
    pause();
  });
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  window.addEventListener('offline', pause);

  function watch(load, { intervalMs = 0, immediate = true } = {}) {
    const job = { load, intervalMs, startedAt: immediate ? -Infinity : now() };
    jobs.add(job);
    if (immediate)
      refresh(job);
    else
      schedule(job);
  }

  function reloadTable(table) {
    const settings = table.settings()[0];
    if (settings.jqXHR?.state() === 'pending')
      return settings.jqXHR;

    // Keep the current rows if a background refresh fails during reconnection.
    table.one('xhr', (event, context, json) => json === null);
    table.ajax.reload(null, false);
    return settings.jqXHR;
  }

  return { watch, reloadTable };
});
