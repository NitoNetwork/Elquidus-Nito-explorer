'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {gzipSync} = require('node:zlib');
const express = require('express');
const bodyParser = require('body-parser');

test('compressed request errors cannot terminate the HTTP parser or subsequent requests', async t => {
  const app = express();
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({extended: true}));
  app.post('/', (req, res) => res.json(req.body));
  app.use((err, req, res, next) => res.status(err.status || 500).json({error: err.type}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = (body, type) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: server.address().port, path: '/', method: 'POST',
      headers: {'Content-Type': type, 'Content-Encoding': 'gzip', 'Content-Length': body.length}}, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', part => { text += part; });
      res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(text)}));
    });
    req.on('error', reject);
    req.end(body);
  });
  for (const [type, text] of [['application/json', '{"probe":"ok"}'],
    ['application/x-www-form-urlencoded', 'probe=ok']]) {
    const compressed = gzipSync(text);
    const damaged = Buffer.concat([compressed, Buffer.from('invalid trailing frame')]);
    assert.equal((await send(damaged, type)).status, 400);
    assert.deepEqual(await send(compressed, type), {status: 200, body: {probe: 'ok'}});
  }
});

test('IPv4 clients do not inherit trust from malformed IPv6 proxy subnets', () => {
  const proxyaddr = require('proxy-addr');
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust('203.0.113.7'), false);
    assert.equal(proxyaddr({socket: {remoteAddress: '203.0.113.7'},
      headers: {'x-forwarded-for': '10.0.0.5'}}, trust), '203.0.113.7');
  }
  assert.equal(proxyaddr.compile('::ffff:10.0.0.0/104')('10.1.2.3'), true);
});
