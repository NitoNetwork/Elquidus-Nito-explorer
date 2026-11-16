'use strict';

const net = require('node:net');

const nonPublicIpv4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) nonPublicIpv4.addSubnet(address, prefix, 'ipv4');

const nonPublicIpv6 = new net.BlockList();
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['100::', 64],
  ['2001::', 23], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28],
  ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) nonPublicIpv6.addSubnet(address, prefix, 'ipv6');

const globalUnicastIpv6 = new net.BlockList();
globalUnicastIpv6.addSubnet('2000::', 3, 'ipv6');

function parsePeerAddress(value, reportedNetwork) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;

  let address = raw;
  let port = null;
  if (raw.startsWith('[')) {
    const closing = raw.indexOf(']');
    if (closing < 2) return null;
    address = raw.slice(1, closing);
    const suffix = raw.slice(closing + 1);
    if (suffix) {
      const match = /^:(\d{1,5})$/.exec(suffix);
      if (!match) return null;
      port = match[1];
    }
  } else if (net.isIP(raw) !== 6) {
    const separator = raw.lastIndexOf(':');
    if (separator > 0 && raw.indexOf(':') === separator) {
      const candidate = raw.slice(separator + 1);
      if (/^\d{1,5}$/.test(candidate)) {
        address = raw.slice(0, separator);
        port = candidate;
      }
    }
  }

  let network = typeof reportedNetwork === 'string' ? reportedNetwork.toLowerCase() : '';
  const portNumber = port == null ? null : Number(port);
  if (!address || (portNumber != null &&
      (portNumber > 65535 || portNumber < 0 || (portNumber === 0 && network !== 'i2p')))) return null;
  if (!network) {
    const family = net.isIP(address);
    if (family === 4) network = 'ipv4';
    else if (family === 6) network = 'ipv6';
    else if (address.endsWith('.onion')) network = 'onion';
    else if (address.endsWith('.i2p')) network = 'i2p';
    else network = 'not_publicly_routable';
  }
  if ((network === 'ipv4' && net.isIP(address) !== 4) ||
      (network === 'ipv6' && net.isIP(address) !== 6)) return null;
  return {address, port, network};
}

function isPublicIp(address, network) {
  const family = net.isIP(address);
  if (network === 'ipv4' && family === 4)
    return !nonPublicIpv4.check(address, 'ipv4');
  if (network === 'ipv6' && family === 6)
    return globalUnicastIpv6.check(address, 'ipv6') && !nonPublicIpv6.check(address, 'ipv6');
  return false;
}

function normalizePeer(peer) {
  if (!peer || typeof peer !== 'object' || Array.isArray(peer)) return null;
  const endpoint = parsePeerAddress(peer.addr, peer.network);
  if (!endpoint) return null;
  const protocol = Number.isSafeInteger(peer.version) ? String(peer.version) :
    (typeof peer.version === 'string' && /^\d+$/.test(peer.version) ? peer.version : '');
  const version = typeof peer.subver === 'string' ? peer.subver.replace(/^\/+|\/+$/g, '') : '';
  return {...endpoint, protocol, version};
}

function normalizeCountry(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.country !== 'string' || !/^[a-z]{2}$/i.test(body.country))
    return null;
  const countryCode = body.country.toUpperCase();
  let country = countryCode;
  try {
    country = new Intl.DisplayNames(['en'], {type: 'region', fallback: 'code'}).of(countryCode) || countryCode;
  } catch {}
  return {country, country_code: countryCode};
}

function geolocationConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    provider_url: config.provider_url || 'https://api.country.is/{ip}',
    timeout_ms: Number.isSafeInteger(config.timeout_ms) && config.timeout_ms >= 1000 ? config.timeout_ms : 5000,
    rate_limit_ms: Number.isSafeInteger(config.rate_limit_ms) && config.rate_limit_ms >= 100 ? config.rate_limit_ms : 250,
    max_failures_per_pass: Number.isSafeInteger(config.max_failures_per_pass) && config.max_failures_per_pass >= 1 && config.max_failures_per_pass <= 20 ? config.max_failures_per_pass : 3,
    retry_seconds: Number.isSafeInteger(config.retry_seconds) && config.retry_seconds >= 300 ? config.retry_seconds : 3600,
    refresh_seconds: Number.isSafeInteger(config.refresh_seconds) && config.refresh_seconds >= 86400 ? config.refresh_seconds : 2592000
  };
}

function createGeolocator(config, request = require('./http-client')) {
  const resolved = geolocationConfig(config);
  return async function geolocate(address, network) {
    if (!resolved.enabled || !isPublicIp(address, network)) return null;
    if (!resolved.provider_url.includes('{ip}'))
      throw new Error('Peer geolocation URL must contain the {ip} placeholder');
    const url = new URL(resolved.provider_url.replace('{ip}', encodeURIComponent(address)));
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Peer geolocation requires an HTTPS URL without embedded credentials');
    const body = await new Promise((resolve, reject) => {
      request({uri: url.toString(), json: true, timeout: resolved.timeout_ms}, (error, response, value) => {
        if (error) return reject(error);
        if (!response || response.statusCode < 200 || response.statusCode >= 300)
          return reject(new Error(`Peer geolocation returned HTTP ${response?.statusCode || 'unavailable'}`));
        return resolve(value);
      });
    });
    const country = normalizeCountry(body);
    if (!country) throw new Error('Peer geolocation returned no valid country');
    return country;
  };
}

function dateValue(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function needsGeolocation(record, existing, config, nowMs) {
  if (!config.enabled || !isPublicIp(record.address, record.network)) return false;
  const hasCountry = typeof existing?.country_code === 'string' && /^[a-z]{2}$/i.test(existing.country_code);
  const checked = dateValue(existing?.geo_checked_at);
  const attempted = dateValue(existing?.geo_attempted_at);
  if (hasCountry && checked && nowMs - checked < config.refresh_seconds * 1000) return false;
  if (attempted && attempted > checked && nowMs - attempted < config.retry_seconds * 1000) return false;
  const lastUnknownAttempt = attempted || checked;
  return hasCountry || !lastUnknownAttempt || nowMs - lastUnknownAttempt >= config.retry_seconds * 1000;
}

async function preparePeerRecords(peers, options = {}) {
  if (!Array.isArray(peers)) throw new TypeError('getpeerinfo must return an array');
  if (typeof options.findExisting !== 'function') throw new TypeError('findExisting is required');
  if (typeof options.geolocate !== 'function') throw new TypeError('geolocate is required');
  const config = geolocationConfig(options.config);
  const logger = options.logger || console;
  const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now instanceof Date ? options.now : new Date();
  const nowMs = now.getTime();
  const records = new Map();
  let skipped = 0;
  let lookupCount = 0;
  let lookupFailures = 0;

  for (const peer of peers) {
    if (options.shouldStop?.()) throw new Error('Peer sync stopped');
    const normalized = normalizePeer(peer);
    if (!normalized) {
      skipped++;
      logger.warn?.('Skipping malformed getpeerinfo record');
      continue;
    }
    const existing = await options.findExisting(normalized.address, normalized.port);
    let country = typeof existing?.country === 'string' ? existing.country : '';
    let countryCode = typeof existing?.country_code === 'string' ? existing.country_code : '';
    let geoCheckedAt = existing?.geo_checked_at || null;
    let geoAttemptedAt = existing?.geo_attempted_at || null;

    if (!config.enabled || !isPublicIp(normalized.address, normalized.network)) {
      country = '';
      countryCode = '';
      geoCheckedAt = null;
      geoAttemptedAt = null;
    } else if (needsGeolocation(normalized, existing, config, nowMs) && lookupFailures < config.max_failures_per_pass) {
      if (lookupCount++ > 0) await sleep(config.rate_limit_ms);
      try {
        const result = await options.geolocate(normalized.address, normalized.network);
        if (result) {
          country = result.country;
          countryCode = result.country_code;
          geoCheckedAt = now;
        }
      } catch (error) {
        lookupFailures++;
        logger.warn?.(`Country lookup unavailable for peer ${normalized.address}: ${error.message}`);
      }
      geoAttemptedAt = now;
    }

    if (options.shouldStop?.()) throw new Error('Peer sync stopped');

    const record = {
      ...normalized,
      country,
      country_code: countryCode,
      geo_checked_at: geoCheckedAt,
      geo_attempted_at: geoAttemptedAt,
      createdAt: now
    };
    records.set(`${record.address}\u0000${record.port || ''}`, record);
  }
  if (peers.length > 0 && records.size === 0)
    throw new Error('getpeerinfo returned no usable peer records');
  return {records: [...records.values()], skipped};
}

function peerDataStatus(lastUpdated, staleAfterSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  const updated = Number(lastUpdated);
  if (!Number.isFinite(updated) || updated <= 0) return 'unavailable';
  const threshold = Number.isSafeInteger(staleAfterSeconds) && staleAfterSeconds >= 300 ? staleAfterSeconds : 1200;
  return nowSeconds - updated > threshold ? 'stale' : 'current';
}

module.exports = {
  createGeolocator,
  geolocationConfig,
  isPublicIp,
  normalizeCountry,
  normalizePeer,
  parsePeerAddress,
  peerDataStatus,
  preparePeerRecords
};
