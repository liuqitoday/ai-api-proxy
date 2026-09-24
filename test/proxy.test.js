const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProxyMiddleware, buildReplayHeaders, performUpstreamRequest } = require('../lib/proxy');
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

function makeMessagesMiddleware(store, config) {
  return createProxyMiddleware({
    routeConfig: { route: '/v1/messages', label: 'Messages' },
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

test('records carry the upstream headers, cost, and previews', async t => {
  let upstreamRequest;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, options) => {
    upstreamRequest = { url, options };
    return new Response(JSON.stringify({
      object: 'response',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer text' }] }],
      usage: { input_tokens: 1000, output_tokens: 500 },
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
  await middleware(makeRequest({ model: 'gpt-4o-mini', input: 'hello there' }), response);

  assert.equal(upstreamRequest.options.headers['x-proxy-token'], undefined);
  const record = store.getLatest(1)[0];
  assert.equal(record.requestHeaders.host, 'upstream.example');
  assert.equal(record.requestHeaders.authorization, '[redacted]');
  assert.equal(record.requestHeaders['x-proxy-token'], undefined);
  assert.equal(record.requestPreview, 'hello there');
  assert.equal(record.responsePreview, 'Answer text');
  assert.equal(record.costUsd, 0.00045);
});

test('protocol headers reach the upstream and are kept for replay', async t => {
  let upstreamRequest;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, options) => {
    upstreamRequest = { url, options };
    return new Response(JSON.stringify({
      id: 'msg_1',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const store = createStore(10);
  const middleware = makeMessagesMiddleware(store, {
    apiBase: 'https://upstream.example',
    apiKey: 'upstream-secret',
    timeoutMs: 2000,
    maxCaptureBytes: 16 * 1024,
  });
  const response = new FakeResponse();
  await middleware({
    body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
    originalUrl: '/v1/messages',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  }, response);

  assert.equal(upstreamRequest.options.headers['anthropic-version'], '2023-06-01');
  const record = store.getLatest(1)[0];
  assert.equal(record.requestHeaders['anthropic-version'], '2023-06-01');
});

test('replay headers keep protocol headers and never forward masked placeholders', () => {
  const headers = buildReplayHeaders({
    route: '/v1/messages',
    requestHeaders: {
      host: 'localhost:3000',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      authorization: '[redacted]',
      'x-api-key': '[redacted]',
      connection: 'keep-alive',
      'content-length': '118',
    },
  }, { apiBase: 'https://upstream.example/', apiKey: 'upstream-secret' });

  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers.authorization, 'Bearer upstream-secret');
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers.host, 'upstream.example');
  assert.equal(headers.connection, undefined);
  assert.equal(headers['content-length'], undefined);
});

test('replay headers fall back to the client protocol defaults', () => {
  const headers = buildReplayHeaders({ route: '/v1/chat/completions' }, { apiBase: 'https://upstream.example' });
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.host, 'upstream.example');
});

test('an upstream timeout is reported as such by the shared request path', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  await assert.rejects(
    performUpstreamRequest({
      url: 'https://upstream.example/v1/responses',
      headers: {},
      body: { model: 'gpt-test' },
      route: '/v1/responses',
      timeoutMs: 20,
      maxCaptureBytes: 1024,
    }),
    err => err.timedOut === true && /timed out after 20ms/.test(err.message),
  );
});

test('the shared request path assembles streams and reports the captured size', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const rawStream = [
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_9', usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } })}\n\n`,
  ].join('');
  global.fetch = async () => new Response(rawStream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  const seen = [];
  const result = await performUpstreamRequest({
    url: 'https://upstream.example/v1/responses',
    headers: {},
    body: { model: 'gpt-test', stream: true },
    route: '/v1/responses',
    timeoutMs: 2000,
    maxCaptureBytes: 4096,
    onChunk: value => { seen.push(Buffer.from(value).toString('utf8')); },
  });

  assert.equal(result.status, 200);
  assert.equal(result.isStream, true);
  assert.equal(result.truncated, false);
  assert.equal(result.responseBody.id, 'resp_9');
  assert.deepEqual(result.tokenUsage, { input_tokens: 3, output_tokens: 1, total_tokens: 4 });
  assert.equal(seen.join(''), rawStream);
});
