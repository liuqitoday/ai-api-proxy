const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createApp } = require('../lib/app');

const BASE_CONFIG = {
  host: '127.0.0.1',
  port: 0,
  apiKey: 'upstream-secret',
  proxyAccessToken: '',
  allowRemoteAccess: false,
  logFile: 'test-app.log',
  enableFileLogging: false,
  timeoutMs: 5000,
  bodyLimit: '16kb',
  ringBufferSize: 50,
  maxCaptureBytes: 1024 * 1024,
};

// A real upstream so the proxy path is exercised end to end, no fetch stubbing.
async function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body });

      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}

      if (parsed.stream) {
        res.setHeader('content-type', 'text/event-stream');
        for (const text of ['alpha ', 'beta ', 'gamma']) {
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl_1', model: 'gpt-4o-mini', choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
        }
        res.end();
        return;
      }

      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/v1/messages')) {
        res.end(JSON.stringify({
          id: 'msg_1',
          type: 'message',
          content: [{ type: 'text', text: 'message reply' }],
          usage: { input_tokens: 1000, output_tokens: 500 },
        }));
      } else {
        res.end(JSON.stringify({
          id: 'chatcmpl_1',
          object: 'chat.completion',
          model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'chat reply' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function startApp(t, overrides = {}) {
  const upstream = await startUpstream();
  const app = createApp({ ...BASE_CONFIG, apiBase: upstream.url, ...overrides }, { saveConfig: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await upstream.close();
  });
  return { base, upstream, app };
}

function postJSON(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const MESSAGES_REQUEST = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hello from the client' }],
};

test('replay re-uses the headers of the original request', async t => {
  const { base, upstream } = await startApp(t);

  await postJSON(`${base}/v1/messages`, MESSAGES_REQUEST, { 'anthropic-version': '2023-06-01' });
  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].headers['anthropic-version'], '2023-06-01');

  const [record] = await (await fetch(`${base}/__api/requests`)).json();
  upstream.seen.length = 0;

  const replay = await postJSON(`${base}/__api/replay`, { requestId: record.id });
  assert.equal(replay.status, 200);

  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(upstream.seen[0].headers.host, new URL(upstream.url).host);
});

test('replay never forwards masked credentials to the upstream', async t => {  const { base, upstream } = await startApp(t);

  await postJSON(`${base}/v1/messages`, MESSAGES_REQUEST, {
    authorization: 'Bearer client-supplied-key',
    'anthropic-version': '2023-06-01',
  });
  const [summary] = await (await fetch(`${base}/__api/requests`)).json();
  const record = await (await fetch(`${base}/__api/requests/${summary.id}`)).json();
  assert.equal(record.requestHeaders.authorization, '[redacted]');

  upstream.seen.length = 0;
  await postJSON(`${base}/__api/replay`, { requestId: record.id });

  assert.equal(upstream.seen[0].headers.authorization, 'Bearer upstream-secret');
  assert.doesNotMatch(JSON.stringify(upstream.seen[0].headers), /redacted/);
});

test('replay with an edited body still re-uses the original headers', async t => {
  const { base, upstream } = await startApp(t);

  await postJSON(`${base}/v1/messages`, MESSAGES_REQUEST, { 'anthropic-version': '2023-06-01' });
  const [record] = await (await fetch(`${base}/__api/requests`)).json();
  upstream.seen.length = 0;

  const replay = await postJSON(`${base}/__api/replay`, {
    requestId: record.id,
    requestBody: { ...MESSAGES_REQUEST, messages: [{ role: 'user', content: 'edited prompt' }] },
  });
  assert.equal(replay.status, 200);

  assert.equal(upstream.seen[0].headers['anthropic-version'], '2023-06-01');
  assert.match(upstream.seen[0].body, /edited prompt/);
  assert.doesNotMatch(upstream.seen[0].body, /hello from the client/);
});

test('a malformed JSON body is recorded and answered in the route protocol', async t => {
  const { base, upstream } = await startApp(t);

  const response = await postJSON(`${base}/v1/messages`, '{not json');
  assert.equal(response.status, 400);

  const payload = await response.json();
  assert.equal(payload.type, 'error');
  assert.match(payload.error.message, /not valid JSON/);
  assert.doesNotMatch(JSON.stringify(payload), /lib\/|\.js:\d|at JSON\.parse/);

  assert.equal(upstream.seen.length, 0);

  const [record] = await (await fetch(`${base}/__api/requests`)).json();
  assert.equal(record.route, '/v1/messages');
  assert.equal(record.responseStatus, 400);
  assert.match(record.error, /not valid JSON/);

  const stats = await (await fetch(`${base}/__api/stats`)).json();
  assert.equal(stats.errorRequests, 1);
  assert.equal(stats.pendingRequests, 0);
});

test('an oversized body is rejected as JSON and recorded', async t => {
  const { base } = await startApp(t);

  const response = await postJSON(`${base}/v1/chat/completions`, {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'y'.repeat(64 * 1024) }],
  });

  assert.equal(response.status, 413);
  const payload = await response.json();
  assert.match(payload.error.message, /exceeds/);

  const [record] = await (await fetch(`${base}/__api/requests`)).json();
  assert.equal(record.responseStatus, 413);
});

test('proxy credentials are checked before the body is parsed', async t => {
  const { base } = await startApp(t, { proxyAccessToken: 'secret-token' });

  const response = await postJSON(`${base}/v1/messages`, '{not json');
  assert.equal(response.status, 401);

  const unauthorized = await postJSON(`${base}/v1/messages`, MESSAGES_REQUEST);
  assert.equal(unauthorized.status, 401);

  const authorized = await postJSON(`${base}/v1/messages`, MESSAGES_REQUEST, { 'x-proxy-token': 'secret-token' });
  assert.equal(authorized.status, 200);

  const records = await (await fetch(`${base}/__api/requests`)).json();
  assert.equal(records.length, 1);
});

test('the request list carries previews and cost so cards survive a reload', async t => {
  const { base } = await startApp(t);

  await postJSON(`${base}/v1/chat/completions`, {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hello from the client' }],
  });

  const [record] = await (await fetch(`${base}/__api/requests`)).json();
  assert.equal(record.requestPreview, 'hello from the client');
  assert.equal(record.responsePreview, 'chat reply');
  assert.equal(record.costUsd, 0.00045);

  const stats = await (await fetch(`${base}/__api/stats`)).json();
  assert.equal(stats.totalCostUsd, 0.00045);
  assert.deepEqual(stats.costByModel, { 'gpt-4o-mini': 0.00045 });
});

test('streamed deltas reach the dashboard over the websocket', async t => {
  const { base } = await startApp(t);

  const socket = new WebSocket(base, { headers: { origin: base } });
  const received = [];
  socket.on('message', raw => received.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  t.after(() => socket.close());

  await postJSON(`${base}/v1/chat/completions`, {
    model: 'gpt-4o-mini',
    stream: true,
    messages: [{ role: 'user', content: 'stream please' }],
  });

  const streamFrames = received.filter(frame => frame.type === 'stream-chunk');
  assert.ok(streamFrames.length > 0, 'expected stream-chunk frames');

  const deltas = streamFrames.flatMap(frame => {
    assert.ok(Array.isArray(frame.data.chunks), 'chunks must be batched into an array');
    return frame.data.chunks;
  }).filter(chunk => chunk.type === 'text');

  assert.equal(deltas.map(chunk => chunk.content).join(''), 'alpha beta gamma');

  const details = received.filter(frame => frame.type === 'request-detail');
  assert.equal(details.length, 1);
  assert.deepEqual(details[0].data.responseBody.choices[0].message.content, 'alpha beta gamma');
});
