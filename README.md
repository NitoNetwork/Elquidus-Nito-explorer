# NITO eIquidus Explorer

[![CI](https://github.com/NitoNetwork/Elquidus-Nito-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/NitoNetwork/Elquidus-Nito-explorer/actions/workflows/ci.yml)

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
- Patched Node.js 24 LTS, at least 24.22.3 and below 25, with npm
- MongoDB replica set with transaction support (MongoDB 7 tested)
- PM2 installed locally from this repository's lockfile by `npm ci`
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
git clone https://github.com/NitoNetwork/Elquidus-Nito-explorer.git
cd Elquidus-Nito-explorer
npm ci
cp settings.json.template settings.json
nano settings.json
~~~

Before the first start, review `network_page.peer_sync.geolocation.enabled`.
The default country enrichment sends only publicly routable peer IP addresses to
the disclosed HTTPS provider; set it to `false` if that is not acceptable for the
installation. Peer collection continues without country enrichment.

Start the explorer with the local, lockfile-pinned PM2. The start command compiles
styles, checks database initialization and starts or reloads both the web process
and one supervised peer collector. No global PM2 installation or package download
occurs during startup.

~~~bash
npm run start-pm2
node scripts/pm2.js save
~~~

Use `npm run stop-pm2` and `npm run reload-pm2` for routine process management.
For automatic recovery after an operating-system reboot, configure the PM2 startup
service for the same account and local PM2 installation; saving the process list
alone does not install an operating-system service. For an existing systemd or
container supervisor, run `npm run start-instance` for the web process and
`npm run sync-peers-loop` as a separate single-instance worker.

Forever is no longer distributed or supported. Its former start, stop and reload
commands exit with migration instructions without changing a running service.
If an old installation still uses Forever, stop it using that original installation
before starting this version under PM2, so two explorers do not share the same port.

### Reproducible software upgrades

Prepare the chosen commit in a separate checkout, retain the existing application,
settings and database backup for rollback, then run `npm ci`, `npm test` and
`npm run test:v4`. Run `npm run validate:publication` before publishing a source
revision. Run `npm run test:integration` against an isolated Core regtest
environment as described in the V4 guide. Review the migration requirements before
switching the running application. Restart or reload the service once to load the
new application and patched dependencies.

The old `update-explorer` command now exits with instructions. It no longer runs
`git pull`, changes dependency versions with `npm update`, or reloads a service.
Subsequent Orchard activation is detected from the node; it does not require another
software installation or an explorer restart.

Run the initial block and market collections manually, then keep block sync running
through your supervisor.

~~~bash
npm run sync-blocks
npm run sync-markets
npm run sync-blocks-loop
~~~

The `sync-blocks-loop` script is a simple continuous indexer loop. It is useful
for PM2/systemd deployments where a one-shot `sync-blocks` command would exit
after one pass. `npm run start-pm2` already supervises `sync-peers-loop`; do not
start a second copy. The peer worker runs immediately, then every five minutes,
uses the existing lock to prevent overlap and retries failures without presenting
them as an empty network. `npm run sync-peers` remains available as a one-shot
diagnostic command; run it only while the supervised peer worker is stopped.

### Peer observations and country estimates

The Network page lists peers observed by the explorer's own Core node during the
last 24 hours. It is not a census of every NITO node. Core's `getpeerinfo` RPC must
be available to the explorer RPC user; include it if `rpcwhitelist` is enabled.

Peer storage is independent of geolocation. An unavailable country provider leaves
the country as `Unknown` and never discards the peer. IPv4 and IPv6 public addresses
are eligible for lookup; private, unroutable, Tor, I2P and CJDNS addresses are never
submitted. The default provider is the keyless HTTPS
[country.is API](https://country.is/), which states that it permits commercial use
and does not log requests. Disable external lookups without disabling the peer page:

~~~json
"geolocation": {
  "enabled": false
}
~~~

For critical or high-volume installations, self-host a compatible endpoint and set
`network_page.peer_sync.geolocation.provider_url` to its HTTPS URL containing the
required `{ip}` placeholder. Never put API credentials in that URL or commit them.
Country values are approximate network-location estimates, not proof of a person's
identity or physical address.

`/ext/getnetworkpeers` keeps its successful top-level JSON array contract. The
additive `network` field identifies Core's reported transport; country fields can
be empty. Internal lookup timestamps are not exposed. A database read failure is
reported as HTTP 503 and must not be interpreted by consumers as an empty peer set.

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

### Database backup, restore and deletion

The inherited `create-backup`, `restore-backup` and `delete-database` commands
are intentionally disabled and exit without changing data. Their former
implementations passed credentials through shell commands, could download code at
runtime and did not coordinate with the transactional writer.

Use the version-matched MongoDB Database Tools as a separate operator procedure.
Stop the writer first, keep credentials in a protected tools configuration rather
than command-line arguments, write backups outside the source checkout and test
every restore into a different isolated replica set. Database deletion and any
production cutover require a separate, explicit operator decision.

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
node scripts/pm2.js status
curl http://127.0.0.1:3001/ext/getorchardpools
curl http://127.0.0.1:3001/ext/getlasttxs/0/0/10/internal
curl http://127.0.0.1:3001/ext/getnetworkpeers
~~~

PM2 should report both `explorer` and the single `explorer-peers` worker online.
After the first successful pass, `/network` must show a current timestamp and the
API must remain a JSON array. A missing/stale warning indicates collector or RPC
failure; it must not be interpreted as zero connected NITO peers.

For a v4 deployment, also verify one transparent-only transaction and one
transaction containing a private Orchard bundle. The private page should show
the public bundle and known fee, and must not create searchable Bech32x balance pages.

## Security Notes

See [dependency maintenance and validation](docs/dependency-security.md) for the
runtime baseline, lockfile policy and compatibility decisions.
Security reports should follow the private process in [SECURITY.md](SECURITY.md).

- Never commit settings.json.
- Keep daemon RPC bound to 127.0.0.1.
- Use a dedicated MongoDB user with readWrite access only to the explorer database.
- Keep wallet files, RPC credentials, database passwords, TLS private keys, and server-only paths out of Git.
- Keep Nginx rate limiting enabled on public explorer endpoints.

## License

The explorer is distributed under the [BSD 3-Clause License](LICENSE). Bundled
third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
