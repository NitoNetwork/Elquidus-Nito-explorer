'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const peerSync = require('../lib/peer-sync');

test('peer endpoints use Core network metadata and parse IPv4, IPv6 and no-port forms', () => {
  assert.deepEqual(peerSync.normalizePeer({addr: '8.8.8.8:9100', network: 'ipv4', version: 70017, subver: '/Nito:4.0.0/'}), {
    address: '8.8.8.8', port: '9100', network: 'ipv4', protocol: '70017', version: 'Nito:4.0.0'
  });
  assert.deepEqual(peerSync.parsePeerAddress('[2606:4700:4700::1111]:9100', 'ipv6'), {
    address: '2606:4700:4700::1111', port: '9100', network: 'ipv6'
  });
  assert.deepEqual(peerSync.parsePeerAddress('exampleaddress.onion:9100', 'onion'), {
    address: 'exampleaddress.onion', port: '9100', network: 'onion'
  });
  assert.deepEqual(peerSync.parsePeerAddress('example.b32.i2p:0', 'i2p'), {
    address: 'example.b32.i2p', port: '0', network: 'i2p'
  });
  assert.deepEqual(peerSync.parsePeerAddress('1.1.1.1', 'ipv4'), {
    address: '1.1.1.1', port: null, network: 'ipv4'
  });
  assert.equal(peerSync.parsePeerAddress('[broken', 'ipv6'), null);
  assert.equal(peerSync.parsePeerAddress('8.8.8.8:0', 'ipv4'), null);
  assert.equal(peerSync.parsePeerAddress('not-an-ip:9100', 'ipv4'), null);
  assert.equal(peerSync.normalizePeer(null), null);
});

test('only publicly routable IPv4 and IPv6 peers are eligible for country lookup', () => {
  for (const [address, network] of [['8.8.8.8', 'ipv4'], ['2606:4700:4700::1111', 'ipv6']])
    assert.equal(peerSync.isPublicIp(address, network), true, address);
  for (const [address, network] of [
    ['127.0.0.1', 'ipv4'], ['10.1.2.3', 'ipv4'], ['192.0.2.1', 'ipv4'],
    ['::1', 'ipv6'], ['fc00::1', 'ipv6'], ['4000::1', 'ipv6'], ['2002::1', 'ipv6'],
    ['3fff::1', 'ipv6'], ['example.onion', 'onion'],
    ['example.b32.i2p', 'i2p'], ['fc00::2', 'cjdns']
  ]) assert.equal(peerSync.isPublicIp(address, network), false, address);
});

test('country lookup requires credential-free HTTPS and validates the provider response', async () => {
  let requested;
  const request = (options, callback) => {
    requested = options;
    queueMicrotask(() => callback(null, {statusCode: 200}, {ip: '8.8.8.8', country: 'US'}));
  };
  const lookup = peerSync.createGeolocator({provider_url: 'https://api.country.is/{ip}', timeout_ms: 2500}, request);
  assert.deepEqual(await lookup('8.8.8.8', 'ipv4'), {country: 'United States', country_code: 'US'});
  assert.equal(requested.uri, 'https://api.country.is/8.8.8.8');
  assert.equal(requested.timeout, 2500);
  assert.equal(await lookup('127.0.0.1', 'ipv4'), null);

  await assert.rejects(peerSync.createGeolocator({provider_url: 'http://example.test/{ip}'}, request)('8.8.8.8', 'ipv4'), /HTTPS/);
  await assert.rejects(peerSync.createGeolocator({provider_url: 'https://example.test/static'}, request)('8.8.8.8', 'ipv4'), /placeholder/);
  const unavailable = peerSync.createGeolocator({}, (_options, callback) =>
    queueMicrotask(() => callback(null, {statusCode: 503}, {country: 'US'})));
  await assert.rejects(unavailable('8.8.8.8', 'ipv4'), /HTTP 503/);
  const malformed = peerSync.createGeolocator({}, (_options, callback) =>
    queueMicrotask(() => callback(null, {statusCode: 200}, {country: 'unknown'})));
  await assert.rejects(malformed('8.8.8.8', 'ipv4'), /valid country/);
});

test('peer preparation persists peers when geolocation fails and never submits non-public networks', async () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const lookups = [];
  const warnings = [];
  const existing = new Map([
    ['1.1.1.1\u00009100', {country: 'Australia', country_code: 'AU', geo_checked_at: now}],
    ['9.9.9.9\u00009100', {country: '', country_code: '', geo_checked_at: new Date(now.getTime() - 7200000)}]
  ]);
  const input = [
    {addr: '8.8.8.8:9100', network: 'ipv4', version: 70017, subver: '/Nito:4.0.0/'},
    {addr: '1.1.1.1:9100', network: 'ipv4', version: 70018, subver: '/Nito:4.0.1/'},
    {addr: '9.9.9.9:9100', network: 'ipv4', version: 70017, subver: '/Nito:4.0.0/'},
    {addr: '127.0.0.1:9100', network: 'ipv4', version: 70017, subver: '/Nito:4.0.0/'},
    {addr: 'example.onion:9100', network: 'onion', version: 70017, subver: '/Nito:4.0.0/'},
    {addr: 'example.b32.i2p:0', network: 'i2p', version: 70017, subver: '/Nito:4.0.0/'},
    {addr: '', network: 'ipv4', version: 70017, subver: '/Nito:4.0.0/'}
  ];
  const result = await peerSync.preparePeerRecords(input, {
    now,
    config: {rate_limit_ms: 100, retry_seconds: 300, refresh_seconds: 86400},
    findExisting: async (address, port) => existing.get(`${address}\u0000${port || ''}`) || null,
    geolocate: async address => {
      lookups.push(address);
      if (address === '8.8.8.8') throw new Error('provider unavailable');
      return {country: 'United States', country_code: 'US'};
    },
    sleep: async () => {},
    logger: {warn: message => warnings.push(message)}
  });
  assert.equal(result.skipped, 1);
  assert.equal(result.records.length, 6);
  assert.deepEqual(lookups, ['8.8.8.8', '9.9.9.9']);
  assert.equal(result.records.find(peer => peer.address === '8.8.8.8').country, '');
  assert.equal(result.records.find(peer => peer.address === '1.1.1.1').country_code, 'AU');
  assert.equal(result.records.find(peer => peer.address === '9.9.9.9').country_code, 'US');
  assert.equal(result.records.find(peer => peer.address === '127.0.0.1').geo_checked_at, null);
  assert.equal(result.records.find(peer => peer.address === '8.8.8.8').geo_checked_at, null);
  assert.equal(result.records.find(peer => peer.address === '8.8.8.8').geo_attempted_at, now);
  assert.equal(result.records.find(peer => peer.network === 'onion').country, '');
  assert.equal(result.records.find(peer => peer.network === 'i2p').port, '0');
  assert.equal(result.records.find(peer => peer.address === '1.1.1.1').protocol, '70018');
  assert.ok(warnings.some(message => message.includes('provider unavailable')));
});

test('failed country refresh preserves known data and retries on the failure cadence', async () => {
  const checked = new Date('2026-10-01T00:00:00Z');
  const firstAttempt = new Date('2026-11-16T12:00:00Z');
  let calls = 0;
  const existing = {country: 'Australia', country_code: 'AU', geo_checked_at: checked};
  const prepare = now => peerSync.preparePeerRecords([
    {addr: '1.1.1.1:9100', network: 'ipv4', version: 70017, subver: '/Nito:4.0.0/'}
  ], {
    now, config: {retry_seconds: 3600, refresh_seconds: 86400},
    findExisting: async () => existing,
    geolocate: async () => { calls++; throw new Error('temporary failure'); },
    logger: {warn() {}}
  });
  const failed = (await prepare(firstAttempt)).records[0];
  assert.equal(failed.country_code, 'AU');
  assert.equal(failed.geo_checked_at, checked);
  assert.equal(failed.geo_attempted_at, firstAttempt);
  Object.assign(existing, failed);
  await prepare(new Date(firstAttempt.getTime() + 1800000));
  assert.equal(calls, 1);
  await prepare(new Date(firstAttempt.getTime() + 3600000));
  assert.equal(calls, 2);
});

test('peer preparation accepts an empty live set but rejects wholly malformed RPC data', async () => {
  const options = {findExisting: async () => null, geolocate: async () => null, logger: {warn() {}}};
  assert.deepEqual(await peerSync.preparePeerRecords([], options), {records: [], skipped: 0});
  await assert.rejects(peerSync.preparePeerRecords([{addr: ''}], options), /no usable peer/);
  await assert.rejects(peerSync.preparePeerRecords({}, options), /must return an array/);
});

test('country lookup circuit breaker never prevents peer persistence', async () => {
  let calls = 0;
  const peers = ['8.8.8.8', '1.1.1.1', '9.9.9.9', '208.67.222.222'].map(address => ({
    addr: `${address}:9100`, network: 'ipv4', version: 70017, subver: '/Nito:4.0.0/'
  }));
  const result = await peerSync.preparePeerRecords(peers, {
    config: {max_failures_per_pass: 2},
    findExisting: async () => null,
    geolocate: async () => { calls++; throw new Error('provider unavailable'); },
    sleep: async () => {},
    logger: {warn() {}}
  });
  assert.equal(calls, 2);
  assert.equal(result.records.length, peers.length);
});

test('network page state distinguishes current, stale and unavailable observations', () => {
  assert.equal(peerSync.peerDataStatus(0, 900, 2000), 'unavailable');
  assert.equal(peerSync.peerDataStatus(1500, 900, 2000), 'current');
  assert.equal(peerSync.peerDataStatus(1000, 900, 2000), 'stale');
});

test('network tables render peer-controlled values as text', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../views/network.pug'), 'utf8');
  assert.match(source, /dataTable\.render\.text\(\)/);
  assert.doesNotMatch(source, /\.html\(data\[/);
  assert.doesNotMatch(source, /\$\{data\.nodes\}/);
  assert.match(source, /\.text\(data\.nodes \|\| ''\)/);
});
