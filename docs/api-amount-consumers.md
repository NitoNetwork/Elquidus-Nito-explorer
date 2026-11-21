# Exact monetary API consumers

Chain monetary fields are decimal strings. Integer nitoshi fields are also
strings, because valid Nito amounts exceed JavaScript's safe integer range.
`X-Nito-Amount-Format: decimal-string-v1` identifies this contract on API responses;
it does not change nonmonetary counters or approximate exchange price data.
Unknown monetary values remain `null` or an HTTP 503 response, never a zero.

## Consumer inventory

| Consumer | Contract and implementation |
| --- | --- |
| Shared supply panel | `/ext/getsummary`: exact decimal formatting in `public/js/nito-amount.js`; the transparent/Orchard breakdown follows confirmed activation state |
| Market capitalization panels | Same exact supply; the provider quote is an estimate rounded to eight decimals before integer multiplication; missing supply or quote displays unavailable |
| Latest transactions | `/ext/getlasttxs`: exact decimal strings are split for presentation, without Number conversion; value means transparent outputs including change |
| Movement page | Same endpoint; integer decimal comparisons determine warning thresholds, including amounts above Number precision; Orchard and incomplete metadata badges retained |
| Address history | `/ext/getaddresstxs`: exact strings from snapshot reads, with running transparent balances and signed net movement |
| Address summary | Server formatting converts integer nitoshi strings to exact eight-decimal coin strings |
| Transaction page | Exact transparent I/O, known fees and net Orchard balance are separate values; no recipient amount is inferred from a private bundle |
| Rich list and distribution | Native Decimal128 reads and integer arithmetic; percentages use the transparent UTXO pool at the same block; only chart proportions are rounded |
| Core RPC proxy | Lossless parsing preserves monetary lexemes; consumers must parse the documented strings explicitly |
| Index and migration commands | Native Mongo Decimal128 and BigInt; no HTTP round-trip or binary-float conversion for balances |
| Exchange adapters | External provider quotes, volume and charts are approximate market information; they do not feed chain accounting |
| Legacy masternode reward endpoints | HTTP 410 with a replacement address-history route. Nito Core V4 has no masternode reward classification; coinbase outputs must not be labeled as such |

The repository distributes English (`locale/en.json`) only. The new Nito and
market labels are present in both that catalog and the default locale. Tests
check completeness of every distributed catalog. Custom operator locales must
add the same keys when upgrading.

There are no bundled third-party API clients in this checkout. An operator's
external monitoring, exchange, wallet, tax or portfolio clients are not certified
by repository tests. Inventory those clients before cutover. Any client expecting
JSON numbers must be updated; there is no lossy numeric compatibility mode.

## Client upgrade examples

```js
const response = await fetch('/ext/getorchardpools');
if (!response.ok) throw new Error('Pool snapshot unavailable');
const pools = await response.json();
const transparent = BigInt(pools.transparent.chainValueNitoshi);
const orchard = BigInt(pools.orchard.chainValueNitoshi);
const total = BigInt(pools.total.chainValueNitoshi);
if (transparent + orchard !== total) throw new Error('Inconsistent snapshot');
// Keep BigInt locally; serialize it as a string when returning JSON.
```

For coin-denominated decimal strings, use a decimal library or multiply the
whole and fractional string parts by integer powers of ten. Do not use
`parseFloat(value) * 1e8`, `Number(value)` or lexicographic string comparisons.
The browser helper exposes `format`, `compare`, and `marketValue`; invalid or
missing operands return `null`, and callers must render an unavailable state.

Hashrate and difficulty are nonmonetary estimates. They may be converted to
finite numbers for charting and unit conversion; this exception does not apply
to balances, supply, fees or pool values. The existing summary API keeps its
configured hashrate source unit for compatibility. The interface converts that
value and each chart series in base 1000, choosing one readable unit from H/s
through EH/s without rewriting historical records.

## Checks

`npm run test:v4` includes exact browser formatting and threshold cases near the
Nito maximum amount, missing values, provider quote multiplication, the browser
movement row callback, distributed-locale completeness, and explicit HTTP
handling for unsupported reward endpoints. The real regtest suite exercises
the API and address histories against Core. A final rendered desktop/mobile
check is also required after interface changes.
