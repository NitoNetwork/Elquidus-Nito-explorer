'use strict';
const {execFileSync} = require('node:child_process');

const foreverMessage = 'Forever is no longer supported because its dependency tree is unmaintained. Stop an existing Forever instance with its original installation, then use npm run start-pm2 with the lockfile-pinned local PM2. See README.md; no service was changed.';

function checkNodeVersion(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 3))
    throw new Error(`Unsupported Node.js ${version}. Install a patched Node.js 24 LTS release, at least 24.22.3 and below 25, then run npm ci.`);
}

function localCli() {
  try { return require.resolve('pm2/bin/pm2'); }
  catch { throw new Error('The lockfile-pinned local PM2 is missing. Run npm ci before starting the explorer. Startup does not install packages.'); }
}

function run(args, options = {}) {
  return execFileSync(process.execPath, [localCli(), ...args], {stdio: 'inherit', ...options});
}

module.exports = {checkNodeVersion, localCli, run, foreverMessage};
