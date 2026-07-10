// Proxy middleware factory
// Creates an Express middleware that proxies requests to an upstream AI API
const {
  assembleStreamToJSON,
  extractChatCompletionFromStream,
  extractResponseFromStream,
  parseAnthropicStreamChunks,
  parseChatCompletionsStreamChunks,
  parseResponsesStreamChunks,
  tryExtractTokenUsage,
  tryParseJson,
} = require('./sse');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function buildUpstreamHeaders(req, config) {
  const apiBase = trimTrailingSlash(config.apiBase || 'https://api.openai.com');
  const headers = {
    ...req.headers,
    host: new URL(apiBase).host,
  };

  delete headers['content-length'];
  delete headers['x-proxy-token'];
  for (const name of HOP_BY_HOP_HEADERS) delete headers[name];

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

function maskAuthHeaders(headers) {
  const masked = { ...headers };
  for (const name of Object.keys(masked)) {
    if (/(authorization|api[-_]?key|token|secret|cookie)/i.test(name)) {
      masked[name] = '[redacted]';
    }
  }
  return masked;
}

function getStreamChunkParser(route) {
  if (route === '/v1/messages') {
    return parseAnthropicStreamChunks;
  } else if (route === '/v1/chat/completions') {
    return parseChatCompletionsStreamChunks;
  } else if (route === '/v1/responses') {
    return parseResponsesStreamChunks;
  }
  return null;
}

function getStreamAssembler(route) {
  if (route === '/v1/messages') {
    return assembleStreamToJSON;
  } else if (route === '/v1/chat/completions') {
    return extractChatCompletionFromStream;
  } else if (route === '/v1/responses') {
    return extractResponseFromStream;
  }
  return null;
}

function truncateBody(body, maxLength) {
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  if (!str || Buffer.byteLength(str, 'utf8') <= maxLength) {
    return { value: body, truncated: false };
  }

  const preview = Buffer.from(str, 'utf8').subarray(0, maxLength).toString('utf8');
  return {
    value: {
      _truncated: true,
      _originalSizeBytes: Buffer.byteLength(str, 'utf8'),
      preview: preview + '...',
    },
    truncated: true,
  };
}

function appendCapture(state, chunk, maxBytes) {
  const bytes = Buffer.from(chunk);
  state.totalBytes += bytes.length;
  if (state.capturedBytes >= maxBytes) {
    state.truncated = true;
    return;
  }

  const remaining = maxBytes - state.capturedBytes;
  const captured = bytes.subarray(0, remaining);
  state.chunks.push(captured);
  state.capturedBytes += captured.length;
  if (captured.length < bytes.length) state.truncated = true;
}

async function writeResponseChunk(res, value) {
  if (res.write(Buffer.from(value))) return;
  await new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('client disconnected'));
    };
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/**
 * createProxyMiddleware
 * @param {Object} options
 * @param {Object} options.routeConfig - { route: '/v1/...', label: '...' }
 * @param {Function} options.getConfig - () => current config object
 * @param {Object} options.store - the request store
 * @param {Function} options.broadcast - (type, data) => void, for WebSocket push
 * @param {Function} options.log - (message) => void, for file logging
 * @returns Express middleware (async (req, res) => void)
 */
function createProxyMiddleware({ routeConfig, getConfig, store, broadcast, log }) {
  const { route, label } = routeConfig;
  const streamAssembler = getStreamAssembler(route);
  const streamChunkParser = getStreamChunkParser(route);

  return async function proxyMiddleware(req, res) {
    const startTime = Date.now();
    const config = getConfig();
    const maxCaptureBytes = config.maxCaptureBytes || 1024 * 1024;

    log(`>>> [${label}] Request Body`, req.body);

    const apiBase = trimTrailingSlash(config.apiBase || 'https://api.openai.com');
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    const upstreamUrl = `${apiBase}${route}${query}`;
    const headers = buildUpstreamHeaders(req, config);
    const timeoutMs = config.timeoutMs || 300000;
    const storedRequest = truncateBody(req.body, maxCaptureBytes);

    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const handleClientClose = () => {
      if (!res.writableEnded) controller.abort(new Error('client disconnected'));
    };
    res.once('close', handleClientClose);

    const requestId = store.add({
      timestamp: startTime,
      method: 'POST',
      route,
      requestBody: storedRequest.value,
      requestBodyTruncated: storedRequest.truncated,
      responseStatus: null,
      responseBody: null,
      latencyMs: null,
      tokenUsage: null,
      model: req.body && typeof req.body.model === 'string' ? req.body.model : null,
      error: null,
      isStream: false,
      requestHeaders: maskAuthHeaders(req.headers),
    }).id;

    try {
      const response = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });

      const isStream = (response.headers.get('content-type') || '').includes('text/event-stream');

      res.status(response.status);
      response.headers.forEach((value, key) => {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && !['content-encoding', 'content-length'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });

      if (isStream) {
        const capture = { chunks: [], capturedBytes: 0, totalBytes: 0, truncated: false };
        const reader = response.body && response.body.getReader();
        const decoder = new TextDecoder();
        let streamBuffer = '';

        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          appendCapture(capture, value, maxCaptureBytes);
          await writeResponseChunk(res, value);

          // Parse live chunks for WebSocket streaming (with line buffering)
          if (broadcast && streamChunkParser) {
            streamBuffer += chunk;
            if (Buffer.byteLength(streamBuffer, 'utf8') > maxCaptureBytes) streamBuffer = '';
            const lines = streamBuffer.split('\n');
            // Keep the last (potentially incomplete) line in the buffer
            streamBuffer = lines.pop() || '';
            for (const line of lines) {
              if (line.trim() === '') continue;
              for (const parsed of streamChunkParser(line + '\n')) {
                broadcast('stream-chunk', {
                  id: requestId,
                  route,
                  label,
                  chunk: parsed,
                });
              }
            }
          }
        }
        res.end();

        const raw = Buffer.concat(capture.chunks).toString('utf8');
        const latencyMs = Date.now() - startTime;

        // Assemble the full response for storage
        let assembledBody = null;
        if (!capture.truncated && streamAssembler) {
          try {
            assembledBody = streamAssembler(raw);
          } catch {
            assembledBody = null;
          }
        }
        if (!assembledBody) {
          assembledBody = {
            _raw_stream: raw,
            ...(capture.truncated ? {
              _truncated: true,
              _originalSizeBytes: capture.totalBytes,
            } : {}),
          };
        }

        const tokenUsage = tryExtractTokenUsage(assembledBody);

        const record = store.complete(requestId, {
          responseStatus: response.status,
          responseBody: assembledBody,
          responseBodyTruncated: capture.truncated,
          latencyMs,
          tokenUsage,
          isStream: true,
        });

        log(`<<< [${label}] Response (stream assembled, status ${response.status})`, assembledBody);

        if (broadcast && record) {
          broadcast('request-detail', record);
        }
      } else {
        const capture = { chunks: [], capturedBytes: 0, totalBytes: 0, truncated: false };
        const reader = response.body && response.body.getReader();
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          appendCapture(capture, value, maxCaptureBytes);
          await writeResponseChunk(res, value);
        }
        res.end();

        const responseBody = Buffer.concat(capture.chunks).toString('utf8');
        const latencyMs = Date.now() - startTime;
        let parsedBody;

        if (capture.truncated) {
          parsedBody = {
            _truncated: true,
            _originalSizeBytes: capture.totalBytes,
            preview: responseBody + '...',
          };
        } else {
          try {
            parsedBody = JSON.parse(responseBody);
          } catch {
            parsedBody = responseBody;
          }
        }

        const tokenUsage = tryExtractTokenUsage(parsedBody);

        const record = store.complete(requestId, {
          responseStatus: response.status,
          responseBody: parsedBody,
          responseBodyTruncated: capture.truncated,
          latencyMs,
          tokenUsage,
          isStream: false,
        });

        log(`<<< [${label}] Response (status ${response.status})`, parsedBody);

        if (broadcast && record) {
          broadcast('request-detail', record);
        }
      }
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const details = timedOut
        ? `upstream request timed out after ${timeoutMs}ms`
        : err.message;

      log(`!!! [${label}] Error: ${details}`);

      const record = store.complete(requestId, {
        responseStatus: 502,
        error: details,
        latencyMs,
        isStream: false,
      });

      if (broadcast && record) {
        broadcast('request-detail', record);
      }

      if (res.headersSent) {
        res.end();
        return;
      }

      res.status(502).json({ error: 'upstream request failed', details });
    } finally {
      clearTimeout(timeoutHandle);
      res.off('close', handleClientClose);
    }
  };
}

module.exports = {
  createProxyMiddleware,
  buildUpstreamHeaders,
  trimTrailingSlash,
  getStreamAssembler,
  tryExtractTokenUsage,
  tryParseJson,
  truncateBody,
};
