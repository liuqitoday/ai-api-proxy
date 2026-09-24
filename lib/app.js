// Unified application factory: proxy routes + Web Dashboard + WebSocket + management API.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { PROJECT_ROOT, saveConfig: persistConfig, maskApiKey, isLoopbackHost } = require('./config');
const { createStore } = require('./store');
const {
  createProxyMiddleware,
  buildUpstreamHeaders,
  buildReplayHeaders,
  maskAuthHeaders,
  performUpstreamRequest,
  summarizeCompletion,
  trimTrailingSlash,
  truncateBody,
} = require('./proxy');

const ROUTE_CONFIGS = [
  { route: '/v1/messages', label: 'Anthropic Messages' },
  { route: '/v1/responses', label: 'OpenAI Responses' },
  { route: '/v1/chat/completions', label: 'Chat Completions' },
];

const DASHBOARD_PATH = path.join(PROJECT_ROOT, 'public', 'dashboard.html');

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

function safeTokenEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serializeLogData(data, maxBytes) {
  if (data == null) return '';
  const value = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8') + `\n... [truncated, ${bytes.length} bytes total]`;
}

// Errors are shaped like the protocol of the route they came from so SDK clients
// can parse them the same way they parse upstream errors.
function protocolErrorBody(route, message) {
  if (route === '/v1/messages') {
    return { type: 'error', error: { type: 'invalid_request_error', message } };
  }
  return { error: { message, type: 'invalid_request_error', code: null } };
}

/**
 * createApp
 * @param {Object} initialConfig - normalized config object
 * @param {Object} [options]
 * @param {Function} [options.saveConfig] - persistence for config updates
 * @returns {{ app, server, store, wss, routes, getConfig, close }}
 */
function createApp(initialConfig, { saveConfig = persistConfig } = {}) {
  if (!initialConfig || typeof initialConfig !== 'object') {
    throw new Error('createApp requires a config object');
  }
  let config = initialConfig;
  if (!isLoopbackHost(config.host) && (!config.allowRemoteAccess || !config.proxyAccessToken)) {
    throw new Error('Remote binding requires allowRemoteAccess=true and a non-empty proxyAccessToken');
  }

  const store = createStore(config.ringBufferSize || 500);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.receivedAt = Date.now();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    next();
  });

  const server = http.createServer(app);

  // --- File logging ---
  let logQueue = Promise.resolve();

  function fileLog(message, data) {
    if (!config.enableFileLogging) return;
    const logFile = path.resolve(PROJECT_ROOT, config.logFile || 'proxy.log');
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

  // --- WebSocket ---
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set();

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

  function requireLocalManagement(req, res, next) {
    if (!isLocalRequest(req) || !hasLoopbackHostHeader(req)) {
      return res.status(403).json({ error: 'management API is only available from localhost' });
    }
    next();
  }

  function requireProxyAccess(req, res, next) {
    if (!config.proxyAccessToken || safeTokenEqual(req.get('x-proxy-token'), config.proxyAccessToken)) {
      return next();
    }
    return res.status(401).json({ error: 'invalid or missing x-proxy-token' });
  }

  // Proxy credentials are checked before the body parser, so unauthenticated
  // callers can never make the proxy buffer a request body.
  for (const rc of ROUTE_CONFIGS) {
    app.post(rc.route, requireProxyAccess);
  }
  app.use('/__api', requireLocalManagement);
  app.use(express.json({ limit: config.bodyLimit || '10mb' }));

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
      costUsd: r.costUsd,
      requestPreview: r.requestPreview,
      responsePreview: r.responsePreview,
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

  // --- Stats API ---
  app.get('/__api/stats', (_req, res) => {
    res.json(store.getStats());
  });

  // --- Replay API ---
  app.post('/__api/replay', async (req, res) => {
    let { requestBody, route } = req.body;
    let source = null;
    const editedBody = requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody);

    if (req.body.requestId) {
      source = store.getById(req.body.requestId);
      if (!source) return res.status(404).json({ error: 'source request not found' });
      if (source.requestBodyTruncated && !editedBody) {
        return res.status(409).json({ error: 'source request body was truncated and cannot be replayed' });
      }
      if (!editedBody) requestBody = source.requestBody;
      route = source.route;
    }

    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody) || !route) {
      return res.status(400).json({ error: 'requestBody object and route are required' });
    }

    const routeConfig = ROUTE_CONFIGS.find(rc => rc.route === route);
    if (!routeConfig) {
      return res.status(400).json({ error: 'unknown route: ' + route });
    }

    const startTime = Date.now();
    const apiBase = trimTrailingSlash(config.apiBase || 'https://api.openai.com');
    const maxCaptureBytes = config.maxCaptureBytes || 1024 * 1024;
    const headers = source
      ? buildReplayHeaders(source, config)
      : buildUpstreamHeaders({ 'content-type': 'application/json' }, config);
    const storedRequest = truncateBody(requestBody, maxCaptureBytes);
    const model = typeof requestBody.model === 'string' ? requestBody.model : null;

    try {
      const result = await performUpstreamRequest({
        url: `${apiBase}${route}`,
        headers,
        body: requestBody,
        route,
        timeoutMs: config.timeoutMs || 300000,
        maxCaptureBytes,
      });

      const record = store.add({
        timestamp: startTime,
        method: 'POST',
        route,
        requestBody: storedRequest.value,
        requestBodyTruncated: storedRequest.truncated,
        responseStatus: result.status,
        responseBody: result.responseBody,
        responseBodyTruncated: result.truncated,
        latencyMs: result.latencyMs,
        isStream: result.isStream,
        model,
        error: null,
        replayed: true,
        requestHeaders: source ? source.requestHeaders : maskAuthHeaders(headers),
        ...summarizeCompletion({
          requestBody,
          responseBody: result.responseBody,
          tokenUsage: result.tokenUsage,
          model,
        }),
      });

      fileLog(`<<< [Replay ${routeConfig.label}] Response (status ${result.status})`);
      broadcast('request-detail', record);

      res.json({
        id: record.id,
        responseStatus: result.status,
        responseBody: result.responseBody,
        tokenUsage: result.tokenUsage,
        latencyMs: result.latencyMs,
        isStream: result.isStream,
      });
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const details = err.message;

      fileLog(`!!! [Replay ${routeConfig.label}] Error: ${details}`);

      const record = store.add({
        timestamp: startTime,
        method: 'POST',
        route,
        requestBody: storedRequest.value,
        requestBodyTruncated: storedRequest.truncated,
        responseStatus: 502,
        responseBody: null,
        latencyMs,
        isStream: false,
        model,
        error: details,
        replayed: true,
        requestHeaders: source ? source.requestHeaders : maskAuthHeaders(headers),
        ...summarizeCompletion({ requestBody, responseBody: null, tokenUsage: null, model }),
      });

      broadcast('request-detail', record);
      res.status(502).json({ error: 'upstream request failed', details });
    }
  });

  // --- Dashboard ---
  app.get('/', requireLocalManagement, (_req, res) => {
    res.sendFile(DASHBOARD_PATH);
  });

  // --- Proxy Route Mounting ---
  for (const rc of ROUTE_CONFIGS) {
    app.post(rc.route, createProxyMiddleware({
      routeConfig: rc,
      getConfig: () => config,
      store,
      broadcast,
      log: fileLog,
    }));
  }

  // --- Error Handling ---
  // Body parsing failures never reach a route handler, so without this they
  // would be invisible in the dashboard and answered with an HTML stack trace.
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const routeConfig = ROUTE_CONFIGS.find(rc => rc.route === req.path);
    const bodyParseFailure = err.type === 'entity.parse.failed' || err.type === 'entity.too.large';

    if (!bodyParseFailure) {
      console.error('Request error:', err.message);
      if (res.headersSent) return res.end();
      return res.status(status).json({ error: 'internal error' });
    }

    const details = err.type === 'entity.too.large'
      ? `request body exceeds the ${config.bodyLimit} limit`
      : `request body is not valid JSON: ${err.message}`;

    const record = store.add({
      timestamp: req.receivedAt || Date.now(),
      method: req.method,
      route: routeConfig ? routeConfig.route : req.path,
      requestBody: null,
      requestBodyTruncated: false,
      responseStatus: status,
      responseBody: null,
      latencyMs: Math.max(0, Date.now() - (req.receivedAt || Date.now())),
      tokenUsage: null,
      costUsd: null,
      requestPreview: '',
      responsePreview: '',
      model: null,
      error: details,
      isStream: false,
      requestHeaders: maskAuthHeaders(req.headers),
    });

    const label = routeConfig ? routeConfig.label : req.path;
    fileLog(`!!! [${label}] Rejected: ${details}`);
    broadcast('request-detail', record);

    if (res.headersSent) return res.end();
    res.status(status).json(routeConfig ? protocolErrorBody(routeConfig.route, details) : { error: details });
  });

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const client of clients) client.terminate();
    clients.clear();
    await new Promise(resolve => wss.close(() => resolve()));
    if (server.listening) {
      await new Promise(resolve => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    }
    await logQueue;
  }

  return { app, server, store, wss, routes: ROUTE_CONFIGS, getConfig: () => config, close };
}

module.exports = { createApp, ROUTE_CONFIGS };
