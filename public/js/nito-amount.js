(function(root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NitoAmount = factory();
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const COIN = 100000000n;
  function units(value) {
    if (value == null || (typeof value === 'number' && !Number.isSafeInteger(value))) return null;
    const match = /^(-?)(\d+)(?:\.(\d{1,8}))?$/.exec(String(value));
    if (!match) return null;
    return (BigInt(match[2]) * COIN + BigInt((match[3] || '').padEnd(8, '0'))) * (match[1] ? -1n : 1n);
  }
  function decimal(value) {
    const absolute = value < 0n ? -value : value;
    return (value < 0n ? '-' : '') + String(absolute / COIN) + '.' + String(absolute % COIN).padStart(8, '0');
  }
  function format(value) {
    const amount = units(value);
    if (amount == null) return null;
    const parts = decimal(amount).split('.');
    return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
  }
  function compare(a, b) {
    const left = units(a), right = units(b);
    return left == null || right == null ? null : left < right ? -1 : left > right ? 1 : 0;
  }
  // Prices are provider estimates. Round the price to eight decimals, then
  // multiply without converting the exact chain supply to a binary float.
  function marketValue(price, supply) {
    if (typeof price === 'number') {
      if (!Number.isFinite(price) || price < 0) return null;
      price = price.toFixed(8);
    }
    const quote = units(price), amount = units(supply);
    if (quote == null || amount == null || quote < 0n || amount < 0n) return null;
    return format(decimal((quote * amount + COIN / 2n) / COIN));
  }
  return {format, compare, marketValue};
});
