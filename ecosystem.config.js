'use strict';
const path = require('node:path');

module.exports = {
  apps: [{
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
  }]
};
