(function(root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./nito-amount'));
  else root.NitoSupply = factory(root.NitoAmount);
})(typeof globalThis === 'object' ? globalThis : this, function(money) {
  'use strict';
  function rows(summary, labels) {
    function format(value) {
      const exact = money.format(value);
      return exact == null ? labels.unavailable : exact.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
    }
    const pools = summary && summary.pools;
    if (pools && pools.status === 'available' && pools.activated === true)
      return ['total', 'transparent', 'orchard'].map(key => ({label: labels[key], value: format(pools[key].chainValue)}));
    return [{label: '', value: format(summary && summary.supply)}];
  }
  function render(container, summary, labels) {
    if (!container) return;
    container.replaceChildren();
    const data = rows(summary, labels);
    container.classList.toggle('nito-supply-active', data.length === 3);
    data.forEach((item, index) => {
      const line = document.createElement('div');
      line.className = 'nito-supply-row';
      if (item.label) {
        const label = document.createElement('span');
        label.textContent = item.label + ':';
        line.appendChild(label);
      }
      const value = document.createElement('span');
      value.textContent = item.value;
      if (index === 0) value.id = 'supply';
      line.appendChild(value);
      container.appendChild(line);
    });
  }
  return {rows, render};
});
