// AI API Proxy — unified entry point
// Serves all proxy routes + Web Dashboard + WebSocket real-time updates
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig, maskApiKey } = require('./lib/config');
const { createStore } = require('./lib/store');
const { createProxyMiddleware } = require('./lib/proxy');

// --- Init ---
let config = loadConfig();
const store = createStore(config.ringBufferSize || 500);

const app = express();
app.use(express.json({ limit: config.bodyLimit || '10mb' }));

const server = http.createServer(app);

// --- WebSocket ---
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

// --- File logging ---
function fileLog(message, data) {
  if (!config.enableFileLogging) return;
  const logFile = path.resolve(__dirname, config.logFile || 'proxy.log');
  const body = data ? '\n' + (typeof data === 'string' ? data : JSON.stringify(data, null, 2)) : '';
  const line = `[${new Date().toISOString()}] ${message}${body}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch (err) {
    console.error('File logging error:', err.message);
  }
}

// --- Config API ---
app.get('/__api/config', (_req, res) => {
  res.json(maskApiKey(config));
});

app.put('/__api/config', async (req, res) => {
  try {
    const updated = saveConfig(req.body);
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
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
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
    _hasDetail: true,
  }));
  res.json(result);
});

app.get('/__api/requests/:id', (req, res) => {
  const record = store.getById(req.params.id);
  if (!record) return res.status(404).json({ error: 'not found' });

  // Return full record with truncated large bodies
  const result = { ...record };
  const maxBodySize = 100 * 1024; // 100KB
  if (result.requestBody) {
    const str = JSON.stringify(result.requestBody);
    if (str.length > maxBodySize) {
      result.requestBodyTruncated = true;
      result.requestBodyPreview = str.slice(0, maxBodySize) + '...';
    }
  }
  if (result.responseBody && typeof result.responseBody === 'object') {
    const str = JSON.stringify(result.responseBody);
    if (str.length > maxBodySize) {
      result.responseBodyTruncated = true;
      result.responseBodyPreview = str.slice(0, maxBodySize) + '...';
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

app.post('/__api/replay', async (req, res) => {
  const { requestBody, route } = req.body;
  if (!requestBody || !route) {
    return res.status(400).json({ error: 'requestBody and route are required' });
  }

  const routeConfig = routeConfigs.find(rc => rc.route === route);
  if (!routeConfig) {
    return res.status(400).json({ error: 'unknown route: ' + route });
  }

  const startTime = Date.now();
  const apiBase = trimTrailingSlash(config.apiBase || 'https://api.openai.com');
  const upstreamUrl = `${apiBase}${route}`;
  const headers = buildUpstreamHeaders({ headers: { 'content-type': 'application/json' }, ...req }, config);
  const streamAssembler = getStreamAssembler(route);

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

    clearTimeout(timeoutHandle);

    const isStream = (response.headers.get('content-type') || '').includes('text/event-stream');

    if (isStream) {
      const chunks = [];
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
      }

      const raw = chunks.join('');
      let assembledBody = streamAssembler ? streamAssembler(raw) : null;
      if (!assembledBody) assembledBody = { _raw_stream: raw };

      const latencyMs = Date.now() - startTime;
      const tokenUsage = tryExtractTokenUsage(assembledBody);
      const model = requestBody.model || null;

      const record = store.add({
        timestamp: startTime,
        method: 'POST',
        route,
        requestBody,
        responseStatus: response.status,
        responseBody: assembledBody,
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
      const responseBodyText = await response.text();
      let parsedBody;
      try { parsedBody = JSON.parse(responseBodyText); } catch { parsedBody = responseBodyText; }

      const latencyMs = Date.now() - startTime;
      const tokenUsage = tryExtractTokenUsage(parsedBody);
      const model = requestBody.model || null;

      const record = store.add({
        timestamp: startTime,
        method: 'POST',
        route,
        requestBody,
        responseStatus: response.status,
        responseBody: parsedBody,
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
    clearTimeout(timeoutHandle);
    const latencyMs = Date.now() - startTime;
    const details = timedOut ? `upstream request timed out after ${timeoutMs}ms` : err.message;

    const record = store.add({
      timestamp: startTime,
      method: 'POST',
      route,
      requestBody,
      responseStatus: 502,
      responseBody: null,
      latencyMs,
      tokenUsage: null,
      model: requestBody.model || null,
      error: details,
      isStream: false,
      replayed: true,
    });
    broadcast('request-detail', record);
    res.status(502).json({ error: 'upstream request failed', details });
  }
});

// --- Dashboard ---
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- Proxy Route Mounting ---
for (const rc of routeConfigs) {
  app.post(rc.route, createProxyMiddleware({
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

server.listen(config.port, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║           AI API Proxy — Dashboard Ready             ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Dashboard : http://localhost:${config.port}                  ║`);
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
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
