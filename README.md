# NITO eIquidus Explorer

Public block explorer for the NITO network, based on the eIquidus community explorer codebase.

This repository contains the explorer application and public deployment examples. Runtime secrets must stay outside Git in a local settings.json file.

## Live Explorer

- Explorer: https://explorer.nito.network/

## Features

- Block, transaction, and address search
- Latest blocks and transactions
- Network statistics and difficulty information
- Address balances and transaction history
- Rich list and holder pages
- Address label claim system
- Public API endpoints for explorer data
- Nito Core V4 public Orchard metadata and exact pool accounting

## Nito Core V4 compatibility

The explorer shows transparent inputs and outputs alongside the public Orchard
bundle: action count, signed net value balance and known fees. It never creates
private recipients, UTXOs or address balances. Bech32x addresses are excluded from
address search, histories and rankings on every supported network.

Transparent UTXO value, Orchard pool value and their exact combined chain value
come from one `getorchardpools` snapshot. The combined value includes immature
rewards and is distinct from issuance, maximum supply and estimated circulation.

**Existing indexes require an isolated rebuild.** The new indexer commits each
block and its transparent address changes atomically. It refuses legacy data and
standalone MongoDB servers. Do not run an old reindex or address-rebuild script.

Read [the V4 accounting, API, validation and migration guide](docs/nito-v4-orchard.md)
before upgrading. No production database change is part of the validation workflow.

## Installation

This guide is for running an independent NITO explorer instance.

## Requirements

- Linux server, preferably Ubuntu 22.04 or newer
- Node.js 22 or later and npm (Node.js 24 tested)
- MongoDB replica set with transaction support (MongoDB 7 tested)
- PM2
- Nginx
- An archival Nito Core V4 daemon with RPC, synchronized txindex and coinstatsindex

## NITO Daemon Example

Add equivalent options to your NITO daemon config. Replace every CHANGE_ME value before starting the daemon.

~~~conf
server=1
daemon=1
txindex=1
coinstatsindex=1
prune=0
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcuser=CHANGE_ME_RPC_USER
rpcpassword=CHANGE_ME_RPC_PASSWORD
rpcport=8825
~~~

## MongoDB Example

Configure a MongoDB replica set first. Create a new, empty dedicated database and user. Replace CHANGE_ME values before use.

~~~javascript
use nito_explorerdb
db.createUser({
  user: 'CHANGE_ME_MONGO_USER',
  pwd: 'CHANGE_ME_MONGO_PASSWORD',
  roles: [{ role: 'readWrite', db: 'nito_explorerdb' }]
})
~~~

If you run an isolated test explorer database with a MongoDB user authenticated
against another database, set `dbsettings.auth_source` in `settings.json`.
Leave it blank for the standard single-database deployment.

## Application Setup

~~~bash
git clone https://github.com/biigbang0001/explorer-eIquidus-NITO.git
cd explorer-eIquidus-NITO
npm ci
cp settings.json.template settings.json
nano settings.json
~~~

Start the explorer with PM2.

~~~bash
node ./scripts/prestart.js
pm2 start ./bin/instance --name explorer
pm2 save
~~~

Run a first sync manually, then keep block sync running through your supervisor.

~~~bash
npm run sync-blocks
node scripts/sync.js market update
npm run sync-blocks-loop
~~~

The `sync-blocks-loop` script is a simple continuous indexer loop. It is useful
for PM2/systemd deployments where a one-shot `sync-blocks` command would exit
after one pass.

### Reconstruct an isolated historical copy

All reindex commands use the transactional V4 engine. They never rewrite the
configured source database. Restore a consistent historical backup on a local
isolated replica set, use an archival local Core node, and create an isolated
settings file. Then run:

~~~bash
export NITO_SETTINGS_PATH=/absolute/path/to/isolated-settings.json
npm run reindex -- --isolated --source-db historical_copy --target-db rebuilt_copy
# Resume an interrupted reconstruction of the same unchanged source:
npm run reindex -- --isolated --source-db historical_copy --target-db rebuilt_copy --resume
# Verify the retained database before switching the app/config/database back together:
npm run rollback-index -- --isolated --source-db historical_copy --target-db rebuilt_copy
~~~

`reindex-rich`, `reindex-txcount`, `reindex-last`, and
`rebuild-transparent-address-index` accept the same arguments and perform the
same complete reconstruction. Partial legacy rewrites cannot establish reliable
history, so they are no longer separate operations. `check-blocks` runs the
normal resumable sync/reorg reconciliation; it does not repair arbitrary database
corruption. See [migration, preservation and rollback](docs/nito-v4-orchard.md#isolated-migration-and-rollback)
for acceptance checks and the required historical export. Do not use these
commands against production or switch databases while a writer is running.

## Nginx Reverse Proxy

An example Nginx vhost with basic request rate limiting is available at:

~~~text
deployment/nginx/explorer.nito.network.conf.example
~~~

The example uses a conservative public API limit:

~~~nginx
limit_req_zone $binary_remote_addr zone=nito_explorer_limit:10m rate=20r/s;
limit_req zone=nito_explorer_limit burst=80 nodelay;
limit_req_status 429;
~~~

## Verify

~~~bash
pm2 status explorer
curl http://127.0.0.1:3001/ext/getorchardpools
curl http://127.0.0.1:3001/ext/getlasttxs/0/0/10/internal
~~~

For a v4 deployment, also verify one transparent-only transaction and one
transaction containing a private Orchard bundle. The private page should show
the public bundle and known fee, and must not create searchable Bech32x balance pages.

## Security Notes

- Never commit settings.json.
- Keep daemon RPC bound to 127.0.0.1.
- Use a dedicated MongoDB user with readWrite access only to the explorer database.
- Keep wallet files, RPC credentials, database passwords, TLS private keys, and server-only paths out of Git.
- Keep Nginx rate limiting enabled on public explorer endpoints.

## License

This repository follows the license of the eIquidus community explorer codebase.
