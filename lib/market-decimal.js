'use strict';

// Exchange values are decimal strings, not chain accounting or JavaScript floats.
function decimal(value, signed = false) {
  let text = String(value);
  // Older adapters already return Numbers; expand their spelling without
  // coercing exact provider strings through floating-point arithmetic.
  if (typeof value === 'number' && Number.isFinite(value) && /e/i.test(text)) {
    const [coefficient, exponent] = text.toLowerCase().split('e');
    const negative = coefficient.startsWith('-');
    const unsigned = negative ? coefficient.slice(1) : coefficient;
    const [whole, fraction = ''] = unsigned.split('.');
    const digits = whole + fraction;
    const point = whole.length + Number(exponent);
    text = (negative ? '-' : '') + (point <= 0 ? '0.' + '0'.repeat(-point) + digits :
      point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point));
  }
  if (text.length > 100 || !(signed ? /^-?\d+(?:\.\d{1,30})?$/ : /^\d+(?:\.\d{1,30})?$/).test(text))
    throw new Error('Invalid market decimal');
  return text;
}

function parts(value) {
  const text = decimal(value, true);
  const [whole, fraction = ''] = text.split('.');
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

function fromParts(units, scale) {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  return (negative ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}

function multiply(a, b) {
  const x = parts(a), y = parts(b);
  return fromParts(x.units * y.units, x.scale + y.scale);
}

function format(value) {
  try {
    const text = String(value);
    // Exact products can have twice the decimal places of either factor.
    const normalized = typeof value === 'string' && /^-?\d{1,100}(?:\.\d{1,60})?$/.test(text) ? text : decimal(value, true);
    const [whole, fraction = ''] = normalized.split('.');
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + fraction.padEnd(2, '0');
  } catch { return 'N/A'; }
}

function approximatePrice(value) {
  // Only fiat valuation and charts may use rounded Number values. Never chain totals.
  decimal(value);
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error('Unavailable market price');
  return number;
}

function addQuote(quotes, currency, value) {
  const price = approximatePrice(value);
  const entry = quotes.find(item => item.currency.toUpperCase() === currency.toUpperCase());
  if (entry) {
    entry.samples = (entry.samples || 1) + 1;
    entry.last_price += (price - entry.last_price) / entry.samples;
  } else quotes.push({ currency, last_price: price, samples: 1 });
}

module.exports = { decimal, multiply, format, approximatePrice, addQuote };
