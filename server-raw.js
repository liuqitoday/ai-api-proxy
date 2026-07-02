const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const config = loadConfig();

const apiBase = trimTrailingSlash(config.apiBase || config.upstream || 'https://api.openai.com');
const port = config.port || 3001;
const logFile = path.resolve(__dirname, config.logFile || 'proxy-raw.log');
const bodyLimit = config.bodyLimit || '10mb';
const timeoutMs = config.timeoutMs || 300000;

app.use(express.json({ limit: bodyLimit }));

function loadConfig() {
  const preferredPath = path.join(__dirname, 'config.openai.json');
  const fallbackPath = path.join(__dirname, 'config.json');
  const configPath = fs.existsSync(preferredPath) ? preferredPath : fallbackPath;
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(logFile, line);
  console.log(line);
}

function buildUpstreamHeaders(req) {
  const headers = {
    ...req.headers,
    host: new URL(apiBase).host,
  };

  delete headers['content-length'];

  if (!headers.authorization && config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  if (!headers['openai-organization'] && config.organization) {
    headers['openai-organization'] = config.organization;
  }

  if (!headers['openai-project'] && config.project) {
    headers['openai-project'] = config.project;
  }

  if (!headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  return headers;
}

app.post('/v1/responses', async (req, res) => {
  log(`>>> [Responses] Request Body:\n${JSON.stringify(req.body, null, 2)}`);

  const upstreamUrl = `${apiBase}/v1/responses`;
  const headers = buildUpstreamHeaders(req);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    clearTimeout(timeoutHandle);

    const isStream = (response.headers.get('content-type') || '').includes('text/event-stream');

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    if (isStream) {
      const chunks = [];
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
        res.write(chunk);
      }

      res.end();

      const raw = chunks.join('');
      log(`<<< [Responses] Response (stream raw, status ${response.status}):\n${raw}`);
      return;
    }

    const responseBody = await response.text();
    log(`<<< [Responses] Response (raw, status ${response.status}):\n${responseBody}`);
    res.send(responseBody);
  } catch (err) {
    clearTimeout(timeoutHandle);

    const details = timedOut
      ? `upstream request timed out after ${timeoutMs}ms`
      : err.message;

    log(`!!! [Responses] Error: ${details}`);

    if (res.headersSent) {
      res.end();
      return;
    }

    res.status(502).json({ error: 'upstream request failed', details });
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  log(`>>> [Chat Completions] Request Body:\n${JSON.stringify(req.body, null, 2)}`);

  const upstreamUrl = `${apiBase}/v1/chat/completions`;
  const headers = buildUpstreamHeaders(req);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    clearTimeout(timeoutHandle);

    const isStream = (response.headers.get('content-type') || '').includes('text/event-stream');

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    if (isStream) {
      const chunks = [];
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
        res.write(chunk);
      }

      res.end();

      const raw = chunks.join('');
      log(`<<< [Chat Completions] Response (stream raw, status ${response.status}):\n${raw}`);
      return;
    }

    const responseBody = await response.text();
    log(`<<< [Chat Completions] Response (raw, status ${response.status}):\n${responseBody}`);
    res.send(responseBody);
  } catch (err) {
    clearTimeout(timeoutHandle);

    const details = timedOut
      ? `upstream request timed out after ${timeoutMs}ms`
      : err.message;

    log(`!!! [Chat Completions] Error: ${details}`);

    if (res.headersSent) {
      res.end();
      return;
    }

    res.status(502).json({ error: 'upstream request failed', details });
  }
});

app.post('/v1/messages', async (req, res) => {
  log(`>>> [Anthropic Messages] Request Body:\n${JSON.stringify(req.body, null, 2)}`);

  const upstreamUrl = `${apiBase}/v1/messages`;
  const headers = buildUpstreamHeaders(req);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    clearTimeout(timeoutHandle);

    const isStream = (response.headers.get('content-type') || '').includes('text/event-stream');

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    if (isStream) {
      const chunks = [];
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
        res.write(chunk);
      }

      res.end();

      const raw = chunks.join('');
      log(`<<< [Anthropic Messages] Response (stream raw, status ${response.status}):\n${raw}`);
      return;
    }

    const responseBody = await response.text();
    log(`<<< [Anthropic Messages] Response (raw, status ${response.status}):\n${responseBody}`);
    res.send(responseBody);
  } catch (err) {
    clearTimeout(timeoutHandle);

    const details = timedOut
      ? `upstream request timed out after ${timeoutMs}ms`
      : err.message;

    log(`!!! [Anthropic Messages] Error: ${details}`);

    if (res.headersSent) {
      res.end();
      return;
    }

    res.status(502).json({ error: 'upstream request failed', details });
  }
});

app.listen(port, () => {
  console.log(`Raw proxy listening on http://localhost:${port} -> ${apiBase}`);
  console.log(`  - POST /v1/responses`);
  console.log(`  - POST /v1/chat/completions`);
  console.log(`  - POST /v1/messages`);
});