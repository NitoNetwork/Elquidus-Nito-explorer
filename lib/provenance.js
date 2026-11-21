'use strict';

const path = require('node:path');
const {execFileSync} = require('node:child_process');

const REPOSITORY_URL = 'https://github.com/NitoNetwork/Elquidus-Nito-explorer';

function revision(value, name) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(`${name} must be a full 40-character hexadecimal Git revision`);
  return normalized;
}

function resolve(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const environment = options.environment || process.env;
  const run = options.execFileSync || execFileSync;
  let checkoutRevision = null;

  try {
    const output = run('git', ['rev-parse', '--verify', 'HEAD'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    checkoutRevision = revision(output, 'Git checkout revision');
  } catch (error) {
    if (/must be a full 40-character/.test(error.message)) throw error;
  }

  const suppliedRevision = environment.NITO_EXPLORER_REVISION == null || environment.NITO_EXPLORER_REVISION === ''
    ? null : revision(environment.NITO_EXPLORER_REVISION, 'NITO_EXPLORER_REVISION');
  if (checkoutRevision && suppliedRevision && checkoutRevision !== suppliedRevision)
    throw new Error('NITO_EXPLORER_REVISION does not match the checked-out Git revision');

  const requireClean = environment.NITO_EXPLORER_REQUIRE_CLEAN_REVISION === '1';
  if (environment.NITO_EXPLORER_REQUIRE_CLEAN_REVISION && !['0', '1'].includes(environment.NITO_EXPLORER_REQUIRE_CLEAN_REVISION))
    throw new Error('NITO_EXPLORER_REQUIRE_CLEAN_REVISION must be 0 or 1');
  if (requireClean && checkoutRevision) {
    const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    });
    if (String(status).trim()) throw new Error('Exact source attribution requires a clean Git checkout');
  }

  const fullRevision = checkoutRevision || suppliedRevision;
  if (requireClean && !fullRevision) throw new Error('Exact source attribution requires a verified Git revision');
  return {
    repositoryUrl: REPOSITORY_URL,
    revision: fullRevision || '',
    shortRevision: fullRevision ? fullRevision.slice(0, 7) : '',
    sourceUrl: fullRevision ? `${REPOSITORY_URL}/tree/${fullRevision}` : REPOSITORY_URL
  };
}

module.exports = {REPOSITORY_URL, revision, resolve};
