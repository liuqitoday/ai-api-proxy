const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProxyMiddleware } = require('../lib/proxy');
const { createStore } = require('../lib/store');

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.writableEnded = false;
    this.headersSent = false;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
    this.headersSent = true;
  }

  write(value) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(value));
    return true;
  }

  end(value) {
    if (value != null) this.write(value);
    this.writableEnded = true;
  }

  send(value) {
    this.end(value);
    return this;
  }

  json(value) {
    this.setHeader('content-type', 'application/json');
    return this.send(JSON.stringify(value));
  }

  get text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function makeRequest(body, originalUrl = '/v1/responses') {
  return {
    body,
    originalUrl,
    path: '/v1/responses',
    headers: {
      'content-type': 'application/json',
      'x-proxy-token': 'downstream-secret',
      connection: 'keep-alive',
    },
  };
}

function makeMiddleware(store, config) {
  return createProxyMiddleware({
    routeConfig: { route: '/v1/responses', label: 'Responses' },
    getConfig: () => config,
    store,
    broadcast: () => {},
    log: () => {},
  });
}

test('proxy preserves query parameters, strips proxy credentials, and records final stats', async t => {
  let upstreamRequest;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, options) => {
    upstreamRequest = { url, options };
    return new Response(JSON.stringify({
      id: 'resp_1',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const store = createStore(10);
  const middleware = makeMiddleware(store, {
    apiBase: 'https://upstream.example',
    apiKey: 'upstream-secret',
    timeoutMs: 2000,
    maxCaptureBytes: 16 * 1024,
  });
  const response = new FakeResponse();
  await middleware(makeRequest(
    { model: 'gpt-test', input: 'hello' },
    '/v1/responses?api-version=2026-01-01',
  ), response);

  assert.equal(response.statusCode, 200);
  assert.equal(upstreamRequest.url, 'https://upstream.example/v1/responses?api-version=2026-01-01');
  assert.equal(upstreamRequest.options.headers.authorization, 'Bearer upstream-secret');
  assert.equal(upstreamRequest.options.headers['x-proxy-token'], undefined);
  assert.equal(upstreamRequest.options.headers.connection, undefined);
  assert.equal(store.getStats().successfulRequests, 1);
  assert.deepEqual(store.getStats().totalTokens, { input: 7, output: 3, total: 10 });
});

test('stream capture is bounded without truncating the client response', async t => {
  const payload = 'x'.repeat(4096);
  const rawStream = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: payload })}\n\n`;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => new Response(rawStream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  const store = createStore(10);
  const middleware = makeMiddleware(store, {
    apiBase: 'https://upstream.example',
    timeoutMs: 2000,
    maxCaptureBytes: 512,
  });
  const response = new FakeResponse();
  await middleware(makeRequest({ model: 'gpt-test', stream: true }), response);

  assert.equal(response.text, rawStream);
  const record = store.getLatest(1)[0];
  assert.equal(record.responseBodyTruncated, true);
  assert.equal(record.responseBody._truncated, true);
  assert.ok(Buffer.byteLength(record.responseBody._raw_stream) <= 512);
});

test('bodyless upstream responses complete successfully', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => new Response(null, { status: 204 });

  const store = createStore(10);
  const middleware = makeMiddleware(store, {
    apiBase: 'https://upstream.example',
    timeoutMs: 2000,
    maxCaptureBytes: 1024,
  });
  const response = new FakeResponse();
  await middleware(makeRequest({ model: 'gpt-test' }), response);

  assert.equal(response.statusCode, 204);
  assert.equal(response.text, '');
  assert.equal(store.getStats().successfulRequests, 1);
});

test('timeout remains active while the response body is being read', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  const store = createStore(10);
  const middleware = makeMiddleware(store, {
    apiBase: 'https://upstream.example',
    timeoutMs: 25,
    maxCaptureBytes: 1024,
  });
  const response = new FakeResponse();
  await middleware(makeRequest({ model: 'gpt-test', stream: true }), response);

  const record = store.getLatest(1)[0];
  assert.equal(record.responseStatus, 502);
  assert.match(record.error, /timed out after 25ms/);
  assert.equal(store.getStats().errorRequests, 1);
  assert.equal(store.getStats().pendingRequests, 0);
});
