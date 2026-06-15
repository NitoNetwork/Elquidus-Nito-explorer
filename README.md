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
- Nito v4 private Orchard transaction markers without indexing Bech32x recipients

## Nito v4 Orchard Display

The explorer remains compatible with the transparent v3 chain. When connected to
a v4 node and a block contains private Orchard data, the explorer displays a
privacy-safe `Bech32x...` marker for private Orchard transaction sides. It does
not index `nito1x` recipients, does not create searchable private address
balances, and keeps private-only transactions visible by txid/block without
inventing public amounts.

For best results, run against a Nito Core build that exposes
`has_private_bundle` and `private_bundle` in verbose transaction RPC output.
The explorer also has a defensive fallback that detects the v4 private flag from
raw transaction hex.

See [docs/nito-v4-orchard.md](docs/nito-v4-orchard.md) for the indexing,
display and maintenance rules used by the Nito v4 explorer fork.

## Installation

This guide is for running an independent NITO explorer instance.

## Requirements

- Linux server, preferably Ubuntu 22.04 or newer
- Node.js 20.x and npm
- MongoDB
- PM2
- Nginx
- A fully synced NITO daemon with RPC enabled and txindex enabled

## NITO Daemon Example

Add equivalent options to your NITO daemon config. Replace every CHANGE_ME value before starting the daemon.

~~~conf
server=1
daemon=1
txindex=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcuser=CHANGE_ME_RPC_USER
rpcpassword=CHANGE_ME_RPC_PASSWORD
rpcport=8825
~~~

## MongoDB Example

Create a dedicated database and user. Replace CHANGE_ME values before use.

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
npm install
cp settings.json.template settings.json
nano settings.json
~~~

Start the explorer with PM2.

~~~bash
node ./scripts/prestart.js
pm2 start ./bin/instance --name explorer
pm2 save
~~~

Run a first sync manually, then install a cron job for continuous indexing.

~~~bash
node scripts/sync.js index update
node scripts/sync.js market update
~~~

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
curl -k https://explorer.nito.network/ext/getsummary
curl -k https://explorer.nito.network/ext/getlasttxs/0/0/10/internal
~~~

## Security Notes

- Never commit settings.json.
- Keep daemon RPC bound to 127.0.0.1.
- Use a dedicated MongoDB user with readWrite access only to the explorer database.
- Keep wallet files, RPC credentials, database passwords, TLS private keys, and server-only paths out of Git.
- Keep Nginx rate limiting enabled on public explorer endpoints.

## License

This repository follows the license of the eIquidus community explorer codebase.
