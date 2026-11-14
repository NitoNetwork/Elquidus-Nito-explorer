'use strict';

const {fetch, Headers, EnvHttpProxyAgent} = require('undici');

function failure(code, message) {
  return Object.assign(new Error(message), {code});
}

// These integrations only need callback-based GET requests, not the obsolete
// request package's signing, multipart, cookie-jar or query-string machinery.
function createClient({dispatcher = new EnvHttpProxyAgent(), timeoutMs = 30000,
                       maxBytes = 16 * 1024 * 1024} = {}) {
  function request(options, callback) {
    const controller = new AbortController();
    let timer;
    let response;
    const run = async () => {
      const supported = ['uri', 'url', 'json', 'timeout', 'headers', 'followRedirect'];
      if (!options || Object.keys(options).some(key => !supported.includes(key)))
        throw failure('INVALID_OPTIONS', 'Unsupported HTTP request options');
      const timeout = options.timeout ?? timeoutMs;
      if (!Number.isSafeInteger(timeout) || timeout <= 0)
        throw failure('INVALID_TIMEOUT', 'HTTP timeout must be a positive integer');
      const url = new URL(options.uri || options.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw failure('INVALID_URL', 'HTTP requests require an HTTP(S) URL without embedded credentials');
      const headers = new Headers(options.headers);
      if (options.json === true && !headers.has('accept')) headers.set('accept', 'application/json');
      timer = setTimeout(() => controller.abort(failure('ETIMEDOUT', 'HTTP request timed out')), timeout);
      const result = await fetch(url, {dispatcher, headers, signal: controller.signal,
        redirect: options.followRedirect === false ? 'manual' : 'follow'});
      response = {statusCode: result.status, headers: Object.fromEntries(result.headers)};
      let length = 0;
      const chunks = [];
      // The limit applies to decompressed bytes, including a continuously
      // streamed body; the deadline covers both headers and body consumption.
      for await (const chunk of result.body || []) {
        length += chunk.byteLength;
        if (length > maxBytes) {
          controller.abort();
          throw failure('RESPONSE_TOO_LARGE', 'HTTP response exceeds the size limit');
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks, length).toString('utf8');
      if (options.json !== true || !body) return body;
      try { return JSON.parse(body); }
      catch { throw failure('INVALID_JSON', 'HTTP response is not valid JSON'); }
    };
    run().then(body => {
      clearTimeout(timer);
      callback(null, response, body);
    }, error => {
      clearTimeout(timer);
      if (typeof error.code !== 'string' && typeof error.cause?.code === 'string') error.code = error.cause.code;
      callback(error, response, undefined);
    });
    return {abort() { controller.abort(failure('ECONNABORTED', 'HTTP request aborted')); }};
  }
  request.close = () => dispatcher.close();
  return request;
}

module.exports = createClient();
module.exports.createClient = createClient;
