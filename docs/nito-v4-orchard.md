# Nito Core V4 explorer accounting

## Supported contract

Use an archival Nito Core V4 node with `txindex=1`, `coinstatsindex=1`,
`prune=0` and RPC bound to a trusted interface. Both indexes must finish syncing.
The explorer needs public block and transaction RPCs; it does not need wallet
keys, viewing keys, wallet RPCs or an address-to-Orchard-note index.
`orchardindex` is needed by the wallets that generate integration-test payments,
not by this explorer's public accounting. `transparenthistoryindex` is not an
explorer dependency. A pruned node can answer `getorchardpools`, but cannot
necessarily provide old blocks and prevouts for a full rebuild or orphan lookup.

Use Node.js 24 LTS, version 24.22.3 or later within the 24.x series. This
security baseline also supports the JSON reviver's original numeric lexeme.
Install the reviewed dependency graph with `npm ci`; do not run `npm update`
on an installed explorer. The runtime version is checked before startup.
MongoDB must support multi-document transactions (a replica set, or a compatible
sharded deployment). The tested database configuration is MongoDB 7 on a local
single-member replica set; that test topology is not a high-availability design.

## Public transaction data

`has_private_bundle` and `private_bundle` are the Orchard authority. The explorer
stores only the public action count and signed value balance. It does not add
private entries to `vin` or `vout`. Nullifiers and commitments, when exposed by
raw Core data, have no wallet or private-address attribution here.

For a non-coinbase transaction:

```text
fee_nitoshi = transparent_input_nitoshi
            + value_balance_nitoshi
            - transparent_output_nitoshi
orchard_pool_delta_nitoshi = -value_balance_nitoshi
```

A positive value balance leaves Orchard; a negative value enters Orchard.
It is a **net** value, not a recipient amount or private transfer volume. A fully
private transfer can have a positive public value balance equal to its fee.
Coinbase has no transaction fee. All transparent outputs, including scripts with
no address, contribute to fee arithmetic. Previous-output failure leaves inputs
and derived fees unavailable. A separately reported Core fee can remain known;
if both derivations are available they must agree.

The old hex-prefix heuristic has been removed. Without structured Orchard
metadata, the explorer accepts transparent classification only after parsing the
entire transparent serialization, canonical CompactSize values, witness stacks
and locktime. Unknown extensions, truncated data and private envelopes without
their metadata remain `unknown`, never assumed fully transparent. This parser
is a display completeness check, not a replacement for Core consensus validation.

The block and latest-transaction lists label their amount as **transparent output
value**, including transparent change. A zero on a fully Orchard row means zero
transparent output value, not a zero private payment. Recipient counts on these
lists count transparent outputs only. Transaction pages expose txid, block,
confirmations, size, known fee, actions and net pool balance separately.
An orphan has confirmations `-1`; an unconfirmed transaction has `0`; a failed
confirmation lookup has `null`. Block pages link with `?blockhash=...` so the
orphan's exact transaction context can be retained.

## Pool accounting and precision

The three totals are collected from **one** `getorchardpools` response and checked
against the chain identity, height and best hash before and after collection:

```text
transparent.chainValueNitoshi + orchard.chainValueNitoshi
    = total.chainValueNitoshi
```

Every integer and corresponding coin-decimal field must agree. Monetary JSON
literals are preserved before JavaScript number conversion. Calculations use
`BigInt`; database amount fields use exact BSON Decimal128; API amounts use
decimal strings. No float is used for value-pool identities, fees, address
balances or distribution percentages. Charts round their proportions to two
decimal places. Market-price valuations are approximate and explicitly use
accounted chain value, not an estimate of circulating supply.

The total includes immature coinbase rewards. Lost private keys cannot be
deducted. Genesis outputs excluded from the UTXO set, provably unspendable outputs
and unclaimed rewards mean this total can differ from theoretical cumulative
issuance. It is neither maximum supply nor an estimate of circulating coins.
Shielding moves value between pools and does not destroy coins.

The existing compact header supply panel shows one total before activation.
There is no separate full-width supply section or explanatory copy in the panel.
It expands to three stacked rows, **Total**,
**Transparent** and **Orchard** only when a valid same-tip Core snapshot reports
`activated: true`. The `activated` and `privateTxActivationHeight` fields must
agree with `getblockchaininfo`; the explorer does not hardcode an activation
height or infer activation from a positive pool balance. An activated but empty
Orchard pool is still displayed. A reorg below activation restores the single
total view. The Top 100 and its distribution remain transparent-only in either
mode, with the transparent UTXO total as the percentage denominator.

Install and synchronize Core V4 with the required indexes before starting this
explorer. No explorer restart or configuration change is needed when Core later
activates Orchard. Keep the documented continuous indexer running: its default
pause is 45 seconds after each synchronization, and an open page refreshes the
header every 60 seconds. The three rows appear after indexing has caught up and
the next successful page poll; delayed or unavailable data remains unavailable.
New page requests also pick up activation immediately after a matching snapshot
is stored. The API documentation's Orchard section is omitted before activation.
This visibility rule does not remove stable raw API field names or falsify a
previously observed private transaction on an orphaned branch.

Only the indexer collects pool totals. It checks that `coinstatsindex` is synced
at the target height, coalesces concurrent collection and caches by network and
block hash. Web requests read the persisted snapshot and use a cheap chain-tip
check; they never call `getorchardpools` or scan UTXOs. The visitor-facing
`/api/gettxoutsetinfo` endpoint is disabled. A missing, mismatched or stale snapshot
is unavailable, not zero. Reorganizations invalidate snapshots by hash even if
height is unchanged.

`nito_pools` retains snapshots collected while the indexer was running. It is
**not** a complete retrospective supply series: heights missed during catch-up
have no snapshot. Old supply fields and cumulative address receipts must never
be relabeled as historical Orchard totals. Existing network charts show hashrate
and difficulty only; they do not reconstruct monetary history.

## Transparent addresses and distribution

Bech32x prefixes for mainnet, testnet/Signet and regtest are blocked from address,
balance, history and claim views. This is an exclusion guard, not address checksum
validation. `private_orchard` is also blocked and never created by the indexer.
Old pseudo-address rows cannot become public balances through the new API.

Address indexes include only identifiable transparent scripts. Scripts without
a single public address remain visible on transaction pages without inventing
an owner. Historical P2PK scripts retain the inherited grouping under the
corresponding public-key P2PKH address, derived by Core and marked
`address_kind: p2pk_public_key_alias`. This is a transparent script alias, not
an Orchard receiver or proof of common ownership. Rich lists rank addresses,
not people or wallets. Their percentages
use the **transparent UTXO pool** at the same indexed block, never total chain
value or cumulative receipts. The remainder includes other transparent scripts
and configured excluded addresses. Cumulative received rankings have no supply
percentage and may exceed current supply because coins can move repeatedly.

## Database and restart behavior

`npm run sync-blocks` uses `scripts/sync_nito.js`. For each block, a MongoDB
transaction commits transactions, exact transparent address deltas, unique
address/transaction records, the block checkpoint and transaction count together.
A failed write aborts the whole block. A retry does not apply the block twice.
The indexer reconciles its stored hash against Core, disconnects orphaned blocks
atomically, reverses both sent and received counters, then connects the new chain.
Run one scheduled writer per database; concurrent writers are protected by the
checkpoint write conflict, but unnecessarily increase retries.

Collections and required indexes are created by the new indexer:

| Collection | Identity / query indexes |
| --- | --- |
| `nito_state` | coin identity, schema version, network, genesis, height and hash |
| `nito_blocks` | unique hash and unique height |
| `txes` | unique txid; descending block height, transaction position and txid |
| `addresses` | unique address; balance and cumulative received order |
| `addresstxes` | unique address + txid; address + height + transaction position + txid |
| `nito_pools` | unique block hash |

Legacy transactions can still be looked up through Core. If RPC is unavailable,
their private markers are removed and their incomplete monetary summary remains
unavailable. Old address totals are not trusted by the new views. The indexer
refuses to append to a legacy database; casting an old rounded number to Decimal128
cannot recover the missing nitoshis.

## API contract

Existing transparent endpoints remain available. Monetary fields now use strings;
clients must use decimal or integer arithmetic instead of coercing them to a
JavaScript `Number`.

| Endpoint | Amount meaning |
| --- | --- |
| `/ext/getorchardpools` | All three exact pools, network, height, hash and scope; HTTP 503 if unavailable |
| `/ext/getmoneysupply` | Plain-text combined chain value; `X-Amount-Scope` header; HTTP 503 if unavailable |
| `/ext/getbasicstats`, `/ext/getsummary` | `money_supply` / `supply` has the same chain-value meaning, or null; includes scope and pools |
| `/ext/gettx/:txid` | `total` is transparent outputs in nitoshis; `total_scope`, `privacy`, `metadata_complete`, `fee_nitoshi`, `orchard` are explicit |
| `/ext/getlasttxs/...` | Coin-denominated transparent output value; public JSON includes scope, privacy, fee and Orchard metadata |
| `/ext/getaddress/:address`, `/ext/getbalance/:address` | Exact transparent address amounts; private receivers return HTTP 422 |
| `/ext/getaddresstxs/:address/:start/:length` | Exact net transparent movement and historical balance, not private movement |
| `/ext/getdistribution` | Transparent denominator, hash and exact rounded percentages |

The raw RPC proxy also preserves monetary lexemes as strings. The inherited API
enable/disable settings still apply. English is the supplied locale; new labels
are centralized in `lib/locale.js` and `locale/en.json`, so custom locales can
translate them without changing templates.

## Isolated migration and rollback

Do not run a rebuild on a production database. The former address-only UTXO
rebuild and legacy index writers are disabled because they cannot establish
complete sent/received history or correct old private pseudo-balances.

1. Keep the deployed explorer revision, configuration and consistent database
   backup together. Restore an existing authorized backup into a separate,
   isolated MongoDB instance. Do not point a test process at production.
2. Run the read-only structural inventory on that copy:

   ```bash
   export NITO_AUDIT_MONGO_URI='mongodb://127.0.0.1:27018'
   export NITO_AUDIT_DATABASE='explorer_validation_copy'
   npm run audit-index
   ```

   It reports legacy documents, private pseudo-addresses, duplicate history keys
   and balance storage types. It never deletes, repairs or rounds data. Structural
   checks alone do not certify balances against Core.
3. Choose a **different empty database**, for example `explorer_v4_validation`,
   on the same isolated replica set. Use a separate explorer checkout and an
   explicit isolated settings file, a local web port, and the intended archival
   Core network. Both MongoDB and Core endpoints must use loopback addresses.
4. Run the supported reconstruction command:

   ```bash
   export NITO_SETTINGS_PATH=/absolute/path/to/isolated-settings.json
   npm run reindex -- --isolated --source-db explorer_validation_copy --target-db explorer_v4_validation
   ```

   On PowerShell, set the same environment variable with
   `$env:NITO_SETTINGS_PATH = 'C:/isolated/settings.json'` before the npm command.
   The indexer
   rebuilds full transparent history from blocks; it does not import old money
   totals. The source is read-only and must remain frozen. A nonempty target is
   refused unless `--resume` is supplied and its manifest matches the source.
   This supports recovery after interrupted block or ancillary-data writes.
   All reindex aliases (`reindex-rich`, `reindex-txcount`, `reindex-last`, and
   `rebuild-transparent-address-index`) perform this complete archival replay;
   none performs an in-place partial rewrite. Ordinary `sync-blocks` and
   `check-blocks` resume indexing and reconcile reorgs without reconstructing.

   Transparent claims are validated against Core and copied to `claimaddresses`.
   Legacy `addresses.name` labels are imported only if no claim takes precedence.
   Private/invalid receivers are excluded from active claims. Other ancillary
   collections, including market and network history, are preserved as
   `legacy_archive_<collection>` for operator review. They are not exposed as
   current data: historical supply cannot be repaired by relabeling old values.
   Retain the source backup for all original fields and rejected labels. The
   reconstruction manifest records collection document counts, BSON-value hashes,
   index definitions, preservation destinations and the new chain checkpoint.
5. Compare sampled address balances against Core `scantxoutset` **as a one-off
   operator validation**, not a web request. Check all three totals against a
   same-tip `getorchardpools`, verify the network/genesis identity, test an orphan,
   restart the writer, and run it twice to check stable counts and balances.
6. Compare representative pre-activation historical transactions and scripts,
   transparent/private/mixed transactions and API clients. Keep unavailable
   historical pool heights as gaps. Retain the original backup for rollback.
7. Production cutover requires a separate operator decision. If authorized later,
   stop the old writer, complete the new database's catch-up, then switch the app
   and writer together. Never run an old writer against schema version 2.

Before rollback, verify the retained source against the reconstruction manifest:

```bash
npm run rollback-index -- --isolated --source-db explorer_validation_copy --target-db explorer_v4_validation
```

This command checks the source without changing either database. It does not
switch running services. Rollback means stopping the new writer and returning the app, configuration and
old database together to the retained revision. Do not downgrade the new schema
in place. The old explorer has the accounting limitations described above; keep
private/rich-list features disabled there until their correctness is established.

### Historical export required for production-history acceptance

Generated regtest history proves the mechanism but cannot certify an existing
installation's historical data. Supply a consistent MongoDB backup (BSON dump
with metadata/index definitions or a `mongodump --archive --gzip` archive) of the
entire explorer database, including `txes`, `addresses`, `addresstxes`,
`claimaddresses`, `richlists`, `coinstats`, network history, markets and any custom
collections. Include the MongoDB version, backup time, deployed explorer SHA,
network/genesis and indexed height/hash, plus sanitized relevant settings such as
coin identity and excluded rich-list addresses. Do not include passwords, RPC
cookies, wallet files, private keys or seeds. Archive files and operator reports
must remain outside Git.

An isolated archival Core data copy for the same network through that checkpoint,
or an independently synchronized archival local node, is also necessary to replay
and compare transactions. A pruned data directory or UTXO snapshot alone cannot
reconstruct historical address activity. Do not obtain the export by connecting
a test process to production.

## Validation

```bash
npm ci
npm run test:core
npm run test:v4
NITO_DAEMON=/path/to/tested/nitod npm run test:integration
```

The integration test creates its own isolated regtest datadir and ephemeral local
MongoDB replica set, then stops both. It requires the `mongodb-memory-server`
development dependency, which downloads an official MongoDB test binary on first
use. It never reads production settings for its RPC or database connections.
The test exercises pre/post activation, real transparent/shield/unshield/private/
mixed transactions, mempool and confirmed metadata, Core fee agreement, exact
pool identity, repeated sync, restart, orphan reversal, same-height replacement,
aborted database writes, legacy-index refusal, HTTP routes and RPC outage.

Unit tests cover missing metadata, previous-output failure, serialization errors,
signed balances, exact maximum-range arithmetic and pool cache/index failures.
Run `npm test` as well: explorer and Poloniex tests use deterministic local
fixtures, including provider errors, timeouts and recovery. See
[market data](market-data.md) and [API consumers](api-amount-consumers.md).
Desktop/mobile browser checks remain part of acceptance. Local regtest evidence
does not certify production history, mainnet operation or another platform.
