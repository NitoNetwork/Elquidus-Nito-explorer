'use strict';
const Client = require('./node').Client;
const pools = require('./nito-pools');
const client = new Client(require('./settings').wallet);
function rpc(method, params = []) {
  return new Promise((resolve, reject) => client.cmd(method, ...params, (error, value) => error ? reject(error) : resolve(value)));
}
module.exports = {rpc, pools: pools.collector(rpc)};
