'use strict';
const path = require('node:path');
const settings = require('./lib/settings');
const instanceRuntime = require('./lib/instance-runtime');

function instanceSuffix(value) {
  const suffix = String(value || '').toLowerCase();
  if (suffix && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(suffix))
    throw new Error('NITO_INSTANCE_ID must be a lowercase identifier');
  return suffix ? `-${suffix}` : '';
}

function webInstances(value) {
  if (value == null || value === '' || value === 'max') return 'max';
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 64)
    throw new Error('NITO_WEB_INSTANCES must be max or an integer between 1 and 64');
  return parsed;
}

function forwardedEnvironment(environment) {
  const forwarded = {};
  for (const name of ['NITO_SETTINGS_PATH', 'NITO_INSTANCE_ID', 'NITO_INDEX_SYNC_INTERVAL', 'NITO_INDEX_SYNC_ERROR_INTERVAL']) {
    if (environment[name] != null && environment[name] !== '') forwarded[name] = String(environment[name]);
  }
  return forwarded;
}

function instanceMarker(filename = path.join(__dirname, '.nito-instance')) {
  if (filename !== path.join(__dirname, '.nito-instance')) {
    const fs = require('node:fs');
    if (!fs.existsSync(filename)) return '';
    const value = instanceRuntime.validInstanceId(fs.readFileSync(filename, 'utf8'));
    if (!value) throw new Error(`Instance marker ${filename} is empty`);
    return value;
  }
  return instanceRuntime.readInstanceMarker(__dirname);
}

function configuredInstanceId(environment, network = settings.network, marker = instanceMarker()) {
  const configured = String(network && network.process_suffix || '').toLowerCase();
  instanceSuffix(configured);
  const requested = String(environment.NITO_INSTANCE_ID || '').toLowerCase();
  instanceSuffix(requested);
  if (marker && marker !== configured)
    throw new Error(`Instance marker ${marker} does not match network.process_suffix ${configured || '(empty)'}`);
  if (requested && requested !== configured)
    throw new Error(`NITO_INSTANCE_ID ${requested} does not match network.process_suffix ${configured || '(empty)'}`);
  if (requested && marker && requested !== marker)
    throw new Error(`NITO_INSTANCE_ID ${requested} does not match instance marker ${marker}`);
  return requested || marker || configured;
}

function binaryFlag(value, name, fallback) {
  if (value == null || value === '') return fallback;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${name} must be 0 or 1`);
}

function buildApps(environment = process.env, network = settings.network, marker = instanceMarker()) {
  const instanceId = configuredInstanceId(environment, network, marker);
  const suffix = instanceSuffix(instanceId);
  const forwarded = forwardedEnvironment(environment);
  if (instanceId) forwarded.NITO_INSTANCE_ID = instanceId;
  const applicationEnvironment = nodeEnvironment => ({...forwarded, NODE_ENV: nodeEnvironment});
  const apps = [
    {
      name: `explorer${suffix}`,
      cwd: __dirname,
      script: path.join(__dirname, 'bin/instance'),
      interpreter: process.execPath,
      exec_mode: 'cluster',
      instances: webInstances(environment.NITO_WEB_INSTANCES == null || environment.NITO_WEB_INSTANCES === '' ? network.web_instances : environment.NITO_WEB_INSTANCES),
      node_args: '--stack-size=10000',
      env: applicationEnvironment('development'),
      env_development: applicationEnvironment('development'),
      env_production: applicationEnvironment('production')
    },
    {
      name: `explorer${suffix}-peers`,
      cwd: __dirname,
      script: path.join(__dirname, 'scripts/peer_sync_loop.js'),
      interpreter: process.execPath,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 15000,
      env: applicationEnvironment('development'),
      env_development: applicationEnvironment('development'),
      env_production: applicationEnvironment('production')
    }
  ];

  const superviseIndexer = binaryFlag(environment.NITO_SUPERVISE_INDEXER, 'NITO_SUPERVISE_INDEXER', network.supervise_indexer === true);
  if (superviseIndexer) {
    apps.push({
      name: `explorer${suffix}-indexer`,
      cwd: __dirname,
      script: path.join(__dirname, 'scripts/index_sync_loop.js'),
      interpreter: process.execPath,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 30000,
      env: applicationEnvironment('development'),
      env_development: applicationEnvironment('development'),
      env_production: applicationEnvironment('production')
    });
  }

  return apps;
}

module.exports = {apps: buildApps(), binaryFlag, buildApps, configuredInstanceId, instanceMarker, instanceSuffix, webInstances};
