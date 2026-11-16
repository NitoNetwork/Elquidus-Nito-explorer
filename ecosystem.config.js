'use strict';
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'explorer',
      cwd: __dirname,
      script: path.join(__dirname, 'bin/instance'),
      interpreter: process.execPath,
      exec_mode: 'cluster',
      instances: 'max',
      node_args: '--stack-size=10000',
      env: {NODE_ENV: 'development'},
      env_development: {NODE_ENV: 'development'},
      env_production: {NODE_ENV: 'production'}
    },
    {
      name: 'explorer-peers',
      cwd: __dirname,
      script: path.join(__dirname, 'scripts/peer_sync_loop.js'),
      interpreter: process.execPath,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 15000,
      env: {NODE_ENV: 'development'},
      env_development: {NODE_ENV: 'development'},
      env_production: {NODE_ENV: 'production'}
    }
  ]
};
