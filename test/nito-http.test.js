'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const {gzipSync} = require('node:zlib');
const {Agent, EnvHttpProxyAgent} = require('undici');
const {createClient} = require('../lib/http-client');

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  instance.url = `http://127.0.0.1:${instance.address().port}`;
  return instance;
}
function client(t, options = {}) {
  const request = createClient({dispatcher: new Agent(), ...options});
  t.after(() => request.close());
  return request;
}
function get(request, uri, options = {}) {
  return new Promise(resolve => request({uri, json: true, ...options}, (error, response, body) => resolve({error, response, body})));
}

test('HTTP replacement preserves exact decimal strings, raw bodies, empty responses and HTTP errors', async t => {
  const request = client(t);
  const fixture = await server(t, (req, res) => {
    if (req.url === '/empty') { res.statusCode = 204; return res.end(); }
    if (req.url === '/failed') res.statusCode = 503;
    res.end('{"amount":"9007199254740993.00000001","chainValueNitoshi":"900719925474099300000001"}');
  });
  const good = await get(request, fixture.url);
  assert.equal(good.error, null);
  assert.equal(good.body.amount, '9007199254740993.00000001');
  assert.equal(good.body.chainValueNitoshi, '900719925474099300000001');
  assert.equal((await get(request, fixture.url, {json: false})).body,
    '{"amount":"9007199254740993.00000001","chainValueNitoshi":"900719925474099300000001"}');
  const unavailable = await get(request, fixture.url + '/failed');
  assert.equal(unavailable.error, null);
  assert.equal(unavailable.response.statusCode, 503);
  assert.equal((await get(request, fixture.url + '/empty')).body, '');
});

test('HTTP replacement decompresses gzip and bounds decoded bodies and invalid JSON', async t => {
  const request = client(t, {maxBytes: 100});
  const fixture = await server(t, (req, res) => {
    res.setHeader('content-encoding', 'gzip');
    res.end(gzipSync(req.url === '/large' ? 'x'.repeat(10000) : req.url === '/invalid' ? '{' : '{"ok":true}'));
  });
  assert.deepEqual((await get(request, fixture.url)).body, {ok: true});
  assert.equal((await get(request, fixture.url + '/invalid')).error.code, 'INVALID_JSON');
  assert.equal((await get(request, fixture.url + '/large')).error.code, 'RESPONSE_TOO_LARGE');
});

test('HTTP replacement follows ordinary redirects, honors disabled redirects and strips cross-origin credentials', async t => {
  const request = client(t);
  let receivedHeaders;
  const destination = await server(t, (req, res) => { receivedHeaders = req.headers; res.end('{"ok":true}'); });
  const redirect = await server(t, (_req, res) => { res.statusCode = 302; res.setHeader('location', destination.url); res.end(); });
  const manual = await get(request, redirect.url, {followRedirect: false});
  assert.equal(manual.response.statusCode, 302);
  assert.equal(receivedHeaders, undefined);
  assert.deepEqual((await get(request, redirect.url, {headers: {Authorization: 'test-only', Cookie: 'test-only=1'}})).body, {ok: true});
  assert.equal(receivedHeaders.authorization, undefined);
  assert.equal(receivedHeaders.cookie, undefined);
});

test('HTTP replacement deadlines cover streaming bodies and explicit abort calls back once', async t => {
  const request = client(t, {timeoutMs: 100});
  const fixture = await server(t, (_req, res) => {
    res.write(' ');
    const timer = setInterval(() => res.write(' '), 10);
    res.on('close', () => clearInterval(timer));
  });
  assert.equal((await get(request, fixture.url)).error.code, 'ETIMEDOUT');
  let calls = 0;
  const aborted = await new Promise(resolve => {
    const handle = request({uri: fixture.url}, error => { calls++; resolve(error); });
    handle.abort();
  });
  assert.equal(aborted.code, 'ECONNABORTED');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(calls, 1);
});

test('HTTP replacement reports resets and refuses unsupported options instead of silently ignoring them', async t => {
  const request = client(t);
  const fixture = await server(t, req => req.socket.destroy());
  assert.ok((await get(request, fixture.url)).error);
  assert.equal((await get(request, fixture.url, {qs: {unexpected: true}})).error.code, 'INVALID_OPTIONS');
  assert.equal((await get(request, fixture.url, {timeout: 0})).error.code, 'INVALID_TIMEOUT');
});

test('HTTP replacement supports environment proxy routing and no-proxy bypass', async t => {
  const destination = await server(t, (_req, res) => res.end('{"proxied":true}'));
  const proxy = await server(t, (_req, res) => { res.statusCode = 500; res.end(); });
  let tunnels = 0;
  const sockets = new Set();
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  proxy.on('connect', (req, socket, head) => {
    tunnels++;
    sockets.add(socket);
    const upstream = net.connect(destination.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  const routed = client(t, {dispatcher: new EnvHttpProxyAgent({httpProxy: proxy.url, httpsProxy: proxy.url, noProxy: ''})});
  assert.deepEqual((await get(routed, destination.url)).body, {proxied: true});
  assert.equal(tunnels, 1);
  const bypassed = client(t, {dispatcher: new EnvHttpProxyAgent({httpProxy: proxy.url, httpsProxy: proxy.url, noProxy: '127.0.0.1'})});
  assert.deepEqual((await get(bypassed, destination.url)).body, {proxied: true});
  assert.equal(tunnels, 1);
});
