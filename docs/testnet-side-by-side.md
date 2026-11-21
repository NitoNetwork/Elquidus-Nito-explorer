# Running mainnet and testnet side by side

This guide adds a NITO testnet explorer next to an existing mainnet explorer on
one host. It uses a second checkout, settings file, Core RPC endpoint, MongoDB
replica-set instance, database, local HTTP port, and set of supervised workers.
It never copies or reuses mainnet chain data.

The explorer verifies Core's chain, genesis, archive mode, required indexes,
synchronization and Orchard activation before it listens or writes. A mismatch
is a startup error; it never triggers a database reset or automatic repair.

## Isolation map

| Resource | Mainnet example | Testnet example |
| --- | --- | --- |
| Checkout | `/srv/nito-explorer-mainnet` | `/srv/nito-explorer-testnet` |
| Settings | checkout-local `settings.json` | `/etc/nito-explorer/testnet.json` |
| MongoDB endpoint | `127.0.0.1:27017` | `127.0.0.1:27018` |
| MongoDB database | `nito_explorerdb` | `nito_explorer_testnet` |
| Core RPC | `127.0.0.1:8825` | `127.0.0.1:8845` |
| Explorer HTTP | `127.0.0.1:3001` | `127.0.0.1:3002` |
| PM2 home | existing mainnet home | checkout-local `tmp/pm2-testnet` |
| PM2 names | `explorer`, `explorer-peers` | `explorer-testnet`, `explorer-testnet-peers`, `explorer-testnet-indexer` |
| Public host | `explorer.nito.network` | `testnet-explorer.nito.network` |

Separate checkouts also isolate compiled CSS and PID locks. Never point the two
profiles at the same database, port, checkout, settings file, or process name.

Use one operating-system account for the testnet checkout, protected settings,
local PM2 dependency, and testnet PM2 service. It may be the existing mainnet
account, but the `.nito-instance` marker forces a different `PM2_HOME`, so no
testnet command can address the mainnet daemon. Record the account as
`EXPLORER_USER` and its primary group as `EXPLORER_GROUP`. Run every application
command in this guide as that account.

```bash
export EXPLORER_USER=CHANGE_ME_EXISTING_PM2_ACCOUNT
export EXPLORER_GROUP="$(id -gn "$EXPLORER_USER")"
```

## 1. Prepare the testnet Core node

Use a separate testnet Core configuration and data directory. Keep RPC on
loopback and make the explorer requirements explicit:

```ini
prune=0
txindex=1
coinstatsindex=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=8845
rpcauth=nito_explorer_testnet:CHANGE_ME_SALT$CHANGE_ME_HASH
```

Generate `rpcauth` with the script distributed by the same NITO Core revision:

```bash
python3 share/rpcauth/rpcauth.py nito_explorer_testnet
```

Put only the generated hash line in Core. Put the clear password only in the
mode-600 explorer settings created later. Do not use the rotating RPC cookie and
do not put a clear `rpcpassword` in Core's configuration.

After changing Core, restart only the testnet service. Wait until the new index
is present and synchronized; merely setting `txindex=1` is not sufficient proof.
A current V4 node normally catches up the optional index without a full chain
reindex. Use `-reindex` only if Core reports an incompatible or damaged index,
and never leave `reindex=1` in the configuration.

```bash
nito-cli -testnet -conf=/absolute/path/to/testnet/nito.conf getblockchaininfo
nito-cli -testnet -conf=/absolute/path/to/testnet/nito.conf getblockhash 0
nito-cli -testnet -conf=/absolute/path/to/testnet/nito.conf getindexinfo
nito-cli -testnet -conf=/absolute/path/to/testnet/nito.conf getorchardpools
```

Required results are:

- chain `test` and genesis
  `00000000ddbcc1487e98d0e27fcc235129c543e6b6066df0cc0d157a0e02312b`;
- `pruned: false` and initial block download complete;
- `txindex.synced: true` and `coinstatsindex.synced: true`;
- Orchard active at testnet height zero;
- successful Basic RPC authentication with the dedicated explorer account.

If `rpcwhitelist` is used, include the read-only methods in the NITO Core V4 RPC
reference, including `getpeerinfo` for the Network page.

## 2. Create a separate MongoDB replica set

Do not convert or reconfigure the mainnet MongoDB service. The testnet explorer
uses its own `mongod` process on `127.0.0.1:27018`, because the V4 indexer needs
transactions and a replica set. Review available memory first; the example caps
the additional WiredTiger cache at 0.25 GiB.

The repository provides:

- `deployment/mongodb/mongod-testnet-explorer.conf.example`;
- `deployment/systemd/mongod-testnet-explorer.service.example`.

Create only the dedicated paths and an internal replica-set key:

```bash
sudo install -d -o mongodb -g mongodb -m 750 /var/lib/mongodb-testnet-explorer
sudo install -d -o mongodb -g mongodb -m 750 /var/log/mongodb-testnet-explorer
sudo sh -c 'umask 177; head -c 756 /dev/urandom | base64 -w 0 > /etc/nito-explorer-testnet-mongodb.key; printf "\n" >> /etc/nito-explorer-testnet-mongodb.key'
sudo chown mongodb:mongodb /etc/nito-explorer-testnet-mongodb.key
```

For the one-time bootstrap, install the example configuration without its final
`security` section, then install and start the separate unit:

```bash
sudo install -o root -g mongodb -m 640 /dev/null /etc/mongod-testnet-explorer.conf
sudo sed '/^security:/,$d' deployment/mongodb/mongod-testnet-explorer.conf.example | sudo tee /etc/mongod-testnet-explorer.conf >/dev/null
sudo chown root:mongodb /etc/mongod-testnet-explorer.conf
sudo install -m 644 deployment/systemd/mongod-testnet-explorer.service.example /etc/systemd/system/mongod-testnet-explorer.service
sudo systemctl daemon-reload
sudo systemctl enable --now mongod-testnet-explorer.service
mongosh --host 127.0.0.1 --port 27018 --eval 'rs.initiate({_id:"nitoTestnetRs",members:[{_id:0,host:"127.0.0.1:27018"}]})'
```

Wait for `db.hello().isWritablePrimary` to become `true`. Connect explicitly to
port 27018 and create an administrator followed by the restricted application
user. Use `passwordPrompt()` and store the application password in a password
manager; never put either password in a command line or Git.

```javascript
// mongosh --host 127.0.0.1 --port 27018
use admin
db.createUser({
  user: 'nito_testnet_admin',
  pwd: passwordPrompt(),
  roles: [
    { role: 'userAdminAnyDatabase', db: 'admin' },
    { role: 'clusterAdmin', db: 'admin' }
  ]
})
db.auth('nito_testnet_admin', passwordPrompt())
use nito_explorer_testnet
db.createUser({
  user: 'nito_explorer_testnet',
  pwd: passwordPrompt(),
  roles: [{ role: 'readWrite', db: 'nito_explorer_testnet' }]
})
```

Stop only the new service, install the complete configuration with authentication,
then start and verify it:

```bash
sudo systemctl stop mongod-testnet-explorer.service
sudo install -o root -g mongodb -m 640 deployment/mongodb/mongod-testnet-explorer.conf.example /etc/mongod-testnet-explorer.conf
sudo systemctl start mongod-testnet-explorer.service
mongosh --host 127.0.0.1 --port 27018 --authenticationDatabase nito_explorer_testnet --username nito_explorer_testnet --password --eval 'db.getSiblingDB("nito_explorer_testnet").runCommand({ping:1})'
```

Confirm the application database is empty. Never restore a mainnet explorer dump
into it.

## 3. Install the isolated patched Node.js runtime

Do not replace the host's global Node.js when an existing explorer depends on it.
Install the required runtime in a separate directory and verify the official
archive checksum:

```bash
export NODE_VERSION=24.22.3
export NODE_ARCHIVE=node-v${NODE_VERSION}-linux-x64.tar.xz
export NODE_SHA256=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb
tmp_dir="$(mktemp -d)"
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
  -o "$tmp_dir/$NODE_ARCHIVE"
printf '%s  %s\n' "$NODE_SHA256" "$tmp_dir/$NODE_ARCHIVE" | sha256sum --check
tar -xJf "$tmp_dir/$NODE_ARCHIVE" -C "$tmp_dir"
sudo install -d -m 755 /opt/nito-explorer-runtime
sudo mv "$tmp_dir/node-v${NODE_VERSION}-linux-x64" /opt/nito-explorer-runtime/
sudo chown -R root:root /opt/nito-explorer-runtime/node-v${NODE_VERSION}-linux-x64
rm "$tmp_dir/$NODE_ARCHIVE"
rmdir "$tmp_dir"
export PATH=/opt/nito-explorer-runtime/node-v24.22.3-linux-x64/bin:$PATH
node --version
npm --version
```

The expected versions are Node.js `v24.22.3` and npm `11.19.1`. Reapply this
`PATH` for every install, test, and PM2 command. The dedicated systemd example
below pins the same absolute runtime. Do not run `npm update` on the server.

## 4. Install one audited explorer revision

Choose an audited commit and use that exact SHA for installation, validation,
and rollback records. Do not deploy a moving branch name.

```bash
export NITO_EXPLORER_SHA=CHANGE_ME_AUDITED_SHA
sudo install -d -o "$EXPLORER_USER" -g "$EXPLORER_GROUP" -m 750 /srv/nito-explorer-testnet
cd /srv/nito-explorer-testnet
git clone https://github.com/NitoNetwork/Elquidus-Nito-explorer.git .
git checkout --detach "$NITO_EXPLORER_SHA"
test "$(git rev-parse HEAD)" = "$NITO_EXPLORER_SHA"
npm ci
npm test
npm run test:v4
npm run validate:publication
npm audit --omit=dev
```

The checkout must be owned by `EXPLORER_USER`, because startup compiles CSS and
creates local PID files. Keep the existing mainnet checkout unchanged.

## 5. Generate and protect the testnet settings

The tested generator creates a complete profile and a non-secret checkout marker;
it refuses conflicting or overwritten files:

```bash
cd /srv/nito-explorer-testnet
npm run create-testnet-settings -- --output /tmp/nito-testnet-settings.json
sudo install -d -m 750 /etc/nito-explorer
sudo install -o "$EXPLORER_USER" -g "$EXPLORER_GROUP" -m 600 \
  /tmp/nito-testnet-settings.json /etc/nito-explorer/testnet.json
rm /tmp/nito-testnet-settings.json
sudoedit /etc/nito-explorer/testnet.json
ln -s /etc/nito-explorer/testnet.json /srv/nito-explorer-testnet/settings.json
```

Replace every `CHANGE_ME_TESTNET_*` value. Keep these isolation values unless the
local services deliberately use different ports:

- MongoDB `127.0.0.1:27018`, database and auth source
  `nito_explorer_testnet`;
- Core RPC `127.0.0.1:8845` with the dedicated `rpcauth` credentials;
- web bind `127.0.0.1`, port `3002`;
- network id `testnet`, chain `test`, and the testnet genesis above;
- public URL `https://testnet-explorer.nito.network`;
- process suffix `testnet`, one web worker, and one supervised indexer;
- market data disabled and robots `noindex,nofollow`;
- required synchronized indexes `txindex` and `coinstatsindex`;
- Orchard activation height zero and active-state requirement.

The ignored `.nito-instance` marker makes PM2 commands fail closed if the
protected settings symlink later becomes missing or unreadable. Credentials stay
outside Git.

## 6. Start only the testnet workers

Capture the existing mainnet PM2 process identity first. Then, from the testnet
checkout and under `EXPLORER_USER`:

```bash
cd /srv/nito-explorer-testnet
export NITO_SETTINGS_PATH=/etc/nito-explorer/testnet.json
export NITO_INSTANCE_ID=testnet
export NITO_WEB_INSTANCES=1
export NITO_SUPERVISE_INDEXER=1
export NITO_EXPLORER_REQUIRE_CLEAN_REVISION=1
npm run start-pm2
node scripts/pm2.js save
node scripts/pm2.js status
```

The only new names are `explorer-testnet`, `explorer-testnet-peers`, and
`explorer-testnet-indexer`. Stop if a legacy mainnet name would be reloaded.
Never start `npm run sync-blocks` or another loop while the supervised indexer is
online. The marker automatically selects
`/srv/nito-explorer-testnet/tmp/pm2-testnet`; verify the mainnet PM2 daemon and
PID did not change.

Install a separate reboot service from
`deployment/systemd/nito-explorer-testnet-pm2.service.example`. Replace its
`CHANGE_ME_EXPLORER_USER` and paths if the local layout differs. After saving the
testnet process list, hand the isolated daemon to systemd:

```bash
sudo install -m 644 deployment/systemd/nito-explorer-testnet-pm2.service.example \
  /etc/systemd/system/nito-explorer-testnet-pm2.service
sudoedit /etc/systemd/system/nito-explorer-testnet-pm2.service
node scripts/pm2.js kill
sudo systemctl daemon-reload
sudo systemctl enable --now nito-explorer-testnet-pm2.service
sudo systemctl status nito-explorer-testnet-pm2.service --no-pager
```

This controlled handoff restarts only the newly installed testnet workers. It
does not connect to or reload the mainnet PM2 daemon.

## 7. Add the independent Nginx vhost

Install the HTTP bootstrap at one path and enable it once:

```bash
sudo install -m 644 \
  deployment/nginx/testnet-explorer.nito.network.http-bootstrap.conf.example \
  /etc/nginx/sites-available/testnet-explorer.nito.network
sudo ln -s /etc/nginx/sites-available/testnet-explorer.nito.network \
  /etc/nginx/sites-enabled/testnet-explorer.nito.network
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --nginx -d testnet-explorer.nito.network
```

After certificate issuance, atomically replace that same available-site file
with the final vhost; do not enable a second file with the same `server_name`:

```bash
sudo install -m 644 deployment/nginx/testnet-explorer.nito.network.conf.example \
  /etc/nginx/sites-available/testnet-explorer.nito.network
sudo nginx -t
sudo systemctl reload nginx
```

The vhost proxies only to `127.0.0.1:3002`. Core RPC and both MongoDB ports stay
private.

## 8. Acceptance checks

Run these checks against the same SHA used above:

```bash
test "$(git rev-parse HEAD)" = "$NITO_EXPLORER_SHA"
node scripts/pm2.js status
ss -lntp | grep -E '127\.0\.0\.1:3002|127\.0\.0\.1:27018'
curl --fail --silent --show-error http://127.0.0.1:3002/ext/getorchardpools
curl --fail --silent --show-error http://127.0.0.1:3002/ext/getnetworkpeers
curl --fail --silent --show-error --head http://127.0.0.1:3002/ext/getorchardpools | tr -d '\r' | grep -i '^X-Nito-Network: testnet$'
curl --fail --silent --show-error --head https://testnet-explorer.nito.network/ | tr -d '\r' | grep -i '^X-Robots-Tag: noindex, nofollow$'
curl --fail --silent --show-error https://testnet-explorer.nito.network/ | grep -i 'noindex,nofollow'
```

Compare the recorded mainnet PM2 PID, Core service start time, local port 3001,
database and a known API response before and after installation. None should
change.

Verify in wide desktop and narrow mobile viewports:

- the exact green testnet logo, explicit `Testnet` identity, and root-only switch
  to mainnet;
- no horizontal overflow, menu/search operation, and visible keyboard focus;
- blocks, transactions, confirmations, transparent addresses and search use only
  testnet data;
- Orchard public metadata is visible from height zero without private address
  histories, UTXOs, balances, recipients, or rich-list entries;
- Total equals Transparent plus Orchard exactly in nitoshis from one Core tip;
- market prices remain unavailable rather than copied from mainnet;
- stopping and restarting each testnet worker leaves mainnet unchanged.

## Rollback

Rollback is independent of mainnet. From the testnet checkout and the same PM2
account, remove only the three exact testnet names and save the revised process
list so they cannot return after reboot:

```bash
node scripts/pm2.js delete explorer-testnet explorer-testnet-peers explorer-testnet-indexer
node scripts/pm2.js save
sudo systemctl disable --now nito-explorer-testnet-pm2.service
sudo rm /etc/nginx/sites-enabled/testnet-explorer.nito.network
sudo rm /etc/nginx/sites-available/testnet-explorer.nito.network
sudo nginx -t
sudo systemctl reload nginx
```

Retain the protected settings, checkout and dedicated testnet database for
diagnosis, or remove them later under a separate explicit decision. Confirm the
mainnet PM2 process, Core service, port 3001, database, and public URL were never
changed. Never use `pm2 delete all`, a broad database drop, or a recursive delete
as part of this rollback.
