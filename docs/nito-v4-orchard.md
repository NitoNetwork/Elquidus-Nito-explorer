# Nito v4 Orchard Explorer Support

This repository owns the eIquidus-style explorer behavior for Nito v4. Nito
Core documents the chain and wallet rules; this document describes how this
explorer displays those rules without leaking or inventing private state.

## Scope

The explorer indexes transparent scripts and public block/transaction metadata.
It does not index Bech32x Orchard receivers and it does not assign searchable
balances to `nito1x...` addresses.

Private transactions are displayed with privacy-safe markers:

- `Private Orchard input` for private value leaving Orchard;
- `Private Orchard output` for private value entering Orchard;
- `Hidden` for pure Orchard-to-Orchard value that is not public.

Transparent-only transactions keep the classic eIquidus display path.

## Amount Rules

When Nito Core exposes `private_bundle.value_balance`, the explorer can display
the public cross-pool amount for transparent-to-private and private-to-transparent
transactions. That value is a public chain fact because transparent value enters
or leaves the private pool.

Pure private-to-private value remains hidden. The explorer must not guess an
amount from missing public outputs, and it must not create a fake transparent
recipient.

## Indexing Rules

The address and rich-list indexes are transparent-only. The special internal
marker `private_orchard` is excluded from public rich lists and address pages.

If historical address or rich-list state was built with older logic, rebuild the
transparent address index from the node UTXO view before trusting top-holder
pages. The helper script for that operation is:

```bash
npm run rebuild-transparent-address-index -- --datadir=/path/to/nito/data --settings=/path/to/settings.json
```

Run it only against an isolated or maintenance database, then verify sampled
balances against `scantxoutset` from Nito Core.

## Continuous Sync

The one-shot `npm run sync-blocks` command exits after one pass. For a test
deployment that must keep following the chain, run the wrapper:

```bash
npm run sync-blocks-loop
```

The wrapper repeats block syncs and sleeps after failures. It is intended for
PM2-managed test deployments and does not replace a production supervisor
policy.

## Required Node RPC Behavior

Use a Nito Core node that supports:

- verbose transaction fields `has_private_bundle` and `private_bundle`;
- `private_bundle.value_balance` for cross-pool public amounts;
- `getrawtransaction <txid> true <blockhash>` or txindex-enabled raw transaction
  lookup for confirmed transactions.

The explorer also detects the Nito private transaction flag from raw hex as a
defensive display fallback, but RPC metadata is the preferred path.
