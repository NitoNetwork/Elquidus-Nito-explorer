(function(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports)
    module.exports = api;
  else
    root.NitoHashrate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const units = [
    { key: 'H', label: 'H/s' },
    { key: 'K', label: 'kH/s' },
    { key: 'M', label: 'MH/s' },
    { key: 'G', label: 'GH/s' },
    { key: 'T', label: 'TH/s' },
    { key: 'P', label: 'PH/s' },
    { key: 'E', label: 'EH/s' }
  ];

  function sourceIndex(sourceUnit) {
    let normalized = String(sourceUnit == null ? '' : sourceUnit).trim().toUpperCase().replace(/\s/g, '');

    if (normalized.endsWith('H/S')) {
      normalized = normalized.slice(0, -3);

      if (normalized === '')
        normalized = 'H';
    }

    const index = units.findIndex(function(unit) { return unit.key === normalized; });

    return index === -1 ? null : index;
  }

  function toHashesPerSecond(value, sourceUnit) {
    if (value == null || (typeof value === 'string' && value.trim() === ''))
      return null;

    const numericValue = Number(value);
    const index = sourceIndex(sourceUnit);

    if (index == null || !Number.isFinite(numericValue) || numericValue < 0)
      return null;

    const hashesPerSecond = numericValue * Math.pow(1000, index);

    return Number.isFinite(hashesPerSecond) ? hashesPerSecond : null;
  }

  function displayIndex(hashesPerSecond) {
    let index = 0;

    while (index < units.length - 1 && hashesPerSecond >= Math.pow(1000, index + 1))
      index++;

    return index;
  }

  function cleanNumber(value) {
    return Number(value.toPrecision(15));
  }

  function scale(value, sourceUnit) {
    const hashesPerSecond = toHashesPerSecond(value, sourceUnit);
    const configuredIndex = sourceIndex(sourceUnit);

    if (hashesPerSecond == null)
      return null;

    const index = displayIndex(hashesPerSecond);

    return {
      value: cleanNumber(Number(value) * Math.pow(1000, configuredIndex - index)),
      unit: units[index].label,
      unitKey: units[index].key
    };
  }

  function scaleSeries(values, sourceUnit) {
    const configuredIndex = sourceIndex(sourceUnit);
    const hashesPerSecond = values.map(function(value) {
      return toHashesPerSecond(value, sourceUnit);
    });
    const validValues = hashesPerSecond.filter(function(value) { return value != null; });

    if (validValues.length === 0)
      return { values: hashesPerSecond, unit: '', unitKey: null };

    const index = displayIndex(Math.max.apply(null, validValues));

    return {
      values: values.map(function(value, valueIndex) {
        return hashesPerSecond[valueIndex] == null ? null : cleanNumber(Number(value) * Math.pow(1000, configuredIndex - index));
      }),
      unit: units[index].label,
      unitKey: units[index].key
    };
  }

  return Object.freeze({
    scale: scale,
    scaleSeries: scaleSeries,
    toHashesPerSecond: toHashesPerSecond
  });
});
