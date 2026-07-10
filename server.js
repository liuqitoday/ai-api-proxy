// AI API Proxy — unified entry point
// Serves all proxy routes + Web Dashboard + WebSocket real-time updates
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadConfig, saveConfig, maskApiKey, isLoopbackHost } = require('./lib/config');
const { createStore } = require('./lib/store');
const { createProxyMiddleware, truncateBody } = require('./lib/proxy');

// --- Init ---
let config = loadConfig();
if (!isLoopbackHost(config.host) && (!config.allowRemoteAccess || !config.proxyAccessToken)) {
  throw new Error('Remote binding requires allowRemoteAccess=true and a non-empty proxyAccessToken');
}
const store = createStore(config.ringBufferSize || 500);

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
});
app.use(express.json({ limit: config.bodyLimit || '10mb' }));

const server = http.createServer(app);

// --- WebSocket ---
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const clients = new Set();

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLocalRequest(req) {
  return isLoopbackAddress(req.socket && req.socket.remoteAddress);
}

function hasLoopbackHostHeader(req) {
  try {
    const hostname = new URL(`http://${req.headers.host}`).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function requireLocalManagement(req, res, next) {
  if (!isLocalRequest(req) || !hasLoopbackHostHeader(req)) {
    return res.status(403).json({ error: 'management API is only available from localhost' });
  }
  next();
}

function safeTokenEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireProxyAccess(req, res, next) {
  if (!config.proxyAccessToken || safeTokenEqual(req.get('x-proxy-token'), config.proxyAccessToken)) {
    return next();
  }
  return res.status(401).json({ error: 'invalid or missing x-proxy-token' });
}

server.on('upgrade', (req, socket, head) => {
  let sameOrigin = false;
  try {
    const origin = new URL(req.headers.origin || '');
    sameOrigin = ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
  } catch {}

  if (!isLocalRequest(req) || !hasLoopbackHostHeader(req) || req.url !== '/' || !sameOrigin) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of clients) {
    if (ws.readyState === 1) {
      if (ws.bufferedAmount > 1024 * 1024) {
        ws.terminate();
        continue;
      }
      try { ws.send(msg); } catch { ws.terminate(); }
    }
  }
}

// --- File logging ---
let logQueue = Promise.resolve();

function serializeLogData(data, maxBytes) {
  if (data == null) return '';
  const value = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8') + `\n... [truncated, ${bytes.length} bytes total]`;
}

function fileLog(message, data) {
  if (!config.enableFileLogging) return;
  const logFile = path.resolve(__dirname, config.logFile || 'proxy.log');
  const body = data ? '\n' + serializeLogData(data, config.maxCaptureBytes || 1024 * 1024) : '';
  const line = `[${new Date().toISOString()}] ${message}${body}\n`;

  logQueue = logQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
    let size = 0;
    try { size = (await fs.promises.stat(logFile)).size; } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const maxBytes = config.maxLogFileBytes || 50 * 1024 * 1024;
    if (size + Buffer.byteLength(line) > maxBytes) {
      const rotated = `${logFile}.1`;
      await fs.promises.rm(rotated, { force: true });
      await fs.promises.rename(logFile, rotated).catch(err => {
        if (err.code !== 'ENOENT') throw err;
      });
    }
    await fs.promises.appendFile(logFile, line, 'utf8');
  }).catch(err => console.error('File logging error:', err.message));
}

app.use('/__api', requireLocalManagement);

// --- Config API ---
app.get('/__api/config', (_req, res) => {
  res.json(maskApiKey(config));
});

app.put('/__api/config', async (req, res) => {
  try {
    const changes = { ...req.body };
    // Empty password fields mean "keep the current secret".
    const clearApiKey = changes.clearApiKey === true;
    const clearProxyAccessToken = changes.clearProxyAccessToken === true;
    delete changes.clearApiKey;
    delete changes.clearProxyAccessToken;
    if (clearApiKey) changes.apiKey = '';
    else if (changes.apiKey === '') delete changes.apiKey;
    if (clearProxyAccessToken) changes.proxyAccessToken = '';
    else if (changes.proxyAccessToken === '') delete changes.proxyAccessToken;
    const updated = saveConfig(changes);
    // Update in-memory config (saveConfig already applies defaults & normalizes)
    config = updated;
    // Resize store if ring buffer size changed
    if (updated.ringBufferSize) {
      store.resize(updated.ringBufferSize);
    }
    broadcast('config-updated', { config: maskApiKey(config) });
    res.json({ ok: true, config: maskApiKey(config) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Request History API ---
app.get('/__api/requests', (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 100, 1000));
  const result = store.getLatest(limit).map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    route: r.route,
    model: r.model,
    responseStatus: r.responseStatus,
    latencyMs: r.latencyMs,
    tokenUsage: r.tokenUsage,
    isStream: r.isStream,
    error: r.error,
    replayed: r.replayed,
    requestBodyTruncated: r.requestBodyTruncated,
    responseBodyTruncated: r.responseBodyTruncated,
    _hasDetail: true,
  }));
  res.json(result);
});

app.get('/__api/requests/:id', (req, res) => {
  const record = store.getById(req.params.id);
  if (!record) return res.status(404).json({ error: 'not found' });

  // Return a bounded detail payload. The original record remains in the store.
  const result = { ...record };
  const maxBodySize = 100 * 1024; // 100KB
  for (const field of ['requestBody', 'responseBody']) {
    if (result[field] == null) continue;
    if (result[`${field}Truncated`] && result[field]._truncated) {
      result[`${field}Preview`] = result[field].preview || result[field]._raw_stream || JSON.stringify(result[field]);
      delete result[field];
      continue;
    }
    const serialized = typeof result[field] === 'string' ? result[field] : JSON.stringify(result[field]);
    const bytes = Buffer.from(serialized, 'utf8');
    if (bytes.length > maxBodySize) {
      result[`${field}DetailTruncated`] = true;
      result[`${field}Preview`] = bytes.subarray(0, maxBodySize).toString('utf8') + '...';
      delete result[field];
    }
  }

  res.json(result);
});

app.delete('/__api/requests', (_req, res) => {
  store.clear();
  broadcast('requests-cleared', {});
  res.json({ ok: true });
});

// --- Proxy Routes ---
const routeConfigs = [
  { route: '/v1/messages', label: 'Anthropic Messages' },
  { route: '/v1/responses', label: 'OpenAI Responses' },
  { route: '/v1/chat/completions', label: 'Chat Completions' },
];

// --- Stats API ---
app.get('/__api/stats', (_req, res) => {
  res.json(store.getStats());
});

// --- Replay API ---
const { buildUpstreamHeaders, trimTrailingSlash, getStreamAssembler, tryExtractTokenUsage } = require('./lib/proxy');

async function readBodyLimited(response, maxBytes) {
  if (!response.body) return { text: '', truncated: false, totalBytes: 0 };
  const reader = response.body.getReader();
  const chunks = [];
  let capturedBytes = 0;
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (capturedBytes < maxBytes) {
      const part = Buffer.from(value).subarray(0, maxBytes - capturedBytes);
      chunks.push(part);
      capturedBytes += part.length;
    }
  }

  return {
    text: Buffer.concat(chunks).toString('utf8'),
    truncated: totalBytes > capturedBytes,
    totalBytes,
  };
}

app.post('/__api/replay', async (req, res) => {
  let { requestBody, route } = req.body;
  if (req.body.requestId) {
    const source = store.getById(req.body.requestId);
    if (!source) return res.status(404).json({ error: 'source request not found' });
    if (source.requestBodyTruncated) {
      return res.status(409).json({ error: 'source request body was truncated and cannot be replayed' });
    }
    requestBody = source.requestBody;
    route = source.route;
  }

  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody) || !route) {
    return res.status(400).json({ error: 'requestBody object and route are required' });
  }

  const routeConfig = routeConfigs.find(rc => rc.route === route);
  if (!routeConfig) {
    return res.status(400).json({ error: 'unknown route: ' + route });
  }

  const startTime = Date.now();
  const apiBase = trimTrailingSlash(config.apiBase || 'https://api.openai.com');
  const upstreamUrl = `${apiBase}${route}`;
  const headers = buildUpstreamHeaders({
    headers: { 'content-type': 'application/json' },
    path: route,
  }, config);
  const streamAssembler = getStreamAssembler(route);
  const maxCaptureBytes = config.maxCaptureBytes || 1024 * 1024;
  const storedRequest = truncateBody(requestBody, maxCaptureBytes);

  const controller = new AbortController();
  const timeoutMs = config.timeoutMs || 300000;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const isStream = (response.headers.get('content-type') || '').includes('text/event-stream');
    const captured = await readBodyLimited(response, maxCaptureBytes);

    if (isStream) {
      const raw = captured.text;
      let assembledBody = !captured.truncated && streamAssembler ? streamAssembler(raw) : null;
      if (!assembledBody) {
        assembledBody = {
          _raw_stream: raw,
          ...(captured.truncated ? {
            _truncated: true,
            _originalSizeBytes: captured.totalBytes,
          } : {}),
        };
      }

      const latencyMs = Date.now() - startTime;
      const tokenUsage = tryExtractTokenUsage(assembledBody);
      const model = typeof requestBody.model === 'string' ? requestBody.model : null;

      const record = store.add({
        timestamp: startTime,
        method: 'POST',
        route,
        requestBody: storedRequest.value,
        requestBodyTruncated: storedRequest.truncated,
        responseStatus: response.status,
        responseBody: assembledBody,
        responseBodyTruncated: captured.truncated,
        latencyMs,
        tokenUsage,
        model,
        error: null,
        isStream: true,
        replayed: true,
      });
      broadcast('request-detail', record);
      res.json({ id: record.id, responseStatus: response.status, responseBody: assembledBody, tokenUsage, latencyMs, isStream: true });
    } else {
      const responseBodyText = captured.text;
      let parsedBody;
      if (captured.truncated) {
        parsedBody = {
          _truncated: true,
          _originalSizeBytes: captured.totalBytes,
          preview: responseBodyText + '...',
        };
      } else {
        try { parsedBody = JSON.parse(responseBodyText); } catch { parsedBody = responseBodyText; }
      }

      const latencyMs = Date.now() - startTime;
      const tokenUsage = tryExtractTokenUsage(parsedBody);
      const model = typeof requestBody.model === 'string' ? requestBody.model : null;

      const record = store.add({
        timestamp: startTime,
        method: 'POST',
        route,
        requestBody: storedRequest.value,
        requestBodyTruncated: storedRequest.truncated,
        responseStatus: response.status,
        responseBody: parsedBody,
        responseBodyTruncated: captured.truncated,
        latencyMs,
        tokenUsage,
        model,
        error: null,
        isStream: false,
        replayed: true,
      });
      broadcast('request-detail', record);
      res.json({ id: record.id, responseStatus: response.status, responseBody: parsedBody, tokenUsage, latencyMs, isStream: false });
    }
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const details = timedOut ? `upstream request timed out after ${timeoutMs}ms` : err.message;

    const record = store.add({
      timestamp: startTime,
      method: 'POST',
      route,
      requestBody: storedRequest.value,
      requestBodyTruncated: storedRequest.truncated,
      responseStatus: 502,
      responseBody: null,
      latencyMs,
      tokenUsage: null,
      model: typeof requestBody.model === 'string' ? requestBody.model : null,
      error: details,
      isStream: false,
      replayed: true,
    });
    broadcast('request-detail', record);
    res.status(502).json({ error: 'upstream request failed', details });
  } finally {
    clearTimeout(timeoutHandle);
  }
});

// --- Dashboard ---
app.get('/', requireLocalManagement, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- Proxy Route Mounting ---
for (const rc of routeConfigs) {
  app.post(rc.route, requireProxyAccess, createProxyMiddleware({
    routeConfig: rc,
    getConfig: () => config,
    store,
    broadcast,
    log: fileLog,
  }));
}

// --- Start ---
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use.`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║           AI API Proxy — Dashboard Ready             ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Dashboard : http://${config.host}:${config.port}`.padEnd(55) + '║');
  console.log('║  Upstream  : ' + (config.apiBase || 'not set').padEnd(36) + '║');
  console.log('╠══════════════════════════════════════════════════════╣');
  for (const rc of routeConfigs) {
    console.log(`║  POST ${rc.route.padEnd(31)}║`.replace(/\s+║$/, ' ║'));
  }
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  wss.close();
  server.close(async () => {
    await logQueue;
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
