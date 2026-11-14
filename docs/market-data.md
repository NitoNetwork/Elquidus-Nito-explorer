# Market data and Poloniex

Exchange quotes are independent of chain accounting. They never determine the
transparent or Orchard pool balance, and a provider failure cannot turn an
unavailable chain total into zero.

The Poloniex adapter follows the provider's [public market-data contract](https://api-docs.poloniex.com/spot/api/public/market-data).
It requests up to 50 orders per side, 200 trades, and 96 fifteen-minute candles.
These are maximum counts, not guarantees. An empty market is valid. The ticker's
`close` supplies the last price; candles use their interval start time rather than
the timestamp of the provider's update.

Prices, quantities, exchange trade amounts and order totals remain decimal strings
through storage and table rendering. Order totals use integer decimal arithmetic.
Chart coordinates and cross-exchange fiat valuation explicitly use approximate
numeric values. Approximate prices are never reused for on-chain accounting.
The quote aggregator validates numeric conversion and uses a sample-weighted mean,
so string quotes cannot concatenate or bias repeated averaging.

Every Poloniex request has a ten-second absolute deadline. HTTP errors, rate
limits, invalid JSON, malformed fields, unexpected numeric monetary fields,
network errors and truncated data fail the refresh. A partial response never
replaces a full market snapshot. Error payloads are not rendered as HTML.

A failed refresh retains the previous snapshot and its per-pair success timestamp,
but marks it stale. A snapshot older than thirty minutes is also displayed as
stale; legacy records with no success timestamp are unverified. A later successful
refresh clears that state. `sync-markets` returns a failure if a configured pair
fails, preserving the last successful aggregate price and update timestamp.

Run `npm test` for deterministic coverage. The suite exercises the real HTTP
adapter against an ephemeral loopback server, including success, empty data,
HTTP 429/500/503, invalid bodies, timeout, socket reset, partial failure, exact
amounts, quote averaging, retained stale storage and recovery. It needs no live
exchange availability or fixed order-book depth. An optional manual provider
diagnostic can use the same exported `get_data` callback; it is not a replacement
for those offline failure tests.
