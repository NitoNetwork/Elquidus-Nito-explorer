'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validInstanceId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (id && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id))
    throw new Error('Instance marker must be a lowercase identifier');
  return id;
}

function readInstanceMarker(root = path.resolve(__dirname, '..')) {
  const filename = path.join(root, '.nito-instance');
  if (!fs.existsSync(filename)) return '';
  const id = validInstanceId(fs.readFileSync(filename, 'utf8'));
  if (!id) throw new Error(`Instance marker ${filename} is empty`);
  return id;
}

function configurePm2Home(environment = process.env, root = path.resolve(__dirname, '..')) {
  const id = readInstanceMarker(root);
  if (!id) return environment.PM2_HOME || '';
  const expected = path.join(root, 'tmp', `pm2-${id}`);
  environment.PM2_HOME = expected;
  return expected;
}

module.exports = {configurePm2Home, readInstanceMarker, validInstanceId};
