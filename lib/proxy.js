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
} = require('./sse');
const { previewRequest, previewResponse } = require('./preview');
const { estimateCost } = require('./pricing');

const MASKED_HEADER_VALUE = '[redacted]';

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

function buildUpstreamHeaders(clientHeaders, config) {
  const apiBase = trimTrailingSlash(config.apiBase || 'https://api.openai.com');
  const headers = {
    ...clientHeaders,
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

// Rebuild the headers for a replayed request from the record stored when the
// original request was forwarded. Credentials are stored masked, so they are
// dropped here and re-injected from config by buildUpstreamHeaders.
function buildReplayHeaders(record, config) {
  const headers = {};
  for (const [name, value] of Object.entries(record.requestHeaders || {})) {
    if (value === MASKED_HEADER_VALUE) continue;
    headers[name] = value;
  }
  return buildUpstreamHeaders(headers, config);
}

function maskAuthHeaders(headers) {
  const masked = { ...headers };
  for (const name of Object.keys(masked)) {
    if (/(authorization|api[-_]?key|token|secret|cookie)/i.test(name)) {
      masked[name] = MASKED_HEADER_VALUE;
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
 * Sends one request upstream and returns the assembled result.
 *
 * The response is always fully consumed; streaming bodies are captured up to
 * maxCaptureBytes, handed to onChunk as they arrive, and assembled into a
 * single JSON document afterwards.
 *
 * @param {Object} options
 * @param {string} options.url - absolute upstream URL
 * @param {Object} options.headers - headers to send upstream
 * @param {Object} options.body - request body, serialized as JSON
 * @param {string} options.route - proxy route, selects the stream assembler
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxCaptureBytes]
 * @param {AbortSignal} [options.signal] - external abort (e.g. client disconnect)
 * @param {Function} [options.onResponse] - (response, isStream) => void, called once headers arrive
 * @param {Function} [options.onChunk] - async (value) => void, called per upstream chunk; awaiting it applies backpressure
 * @returns {Promise<{status, headers, isStream, responseBody, truncated, totalBytes, tokenUsage, latencyMs}>}
 */
async function performUpstreamRequest({
  url,
  headers,
  body,
  route,
  timeoutMs = 300000,
  maxCaptureBytes = 1024 * 1024,
  signal,
  onResponse,
  onChunk,
}) {
  const startTime = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const forwardAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const isStream = (response.headers.get('content-type') || '').includes('text/event-stream');
    if (onResponse) onResponse(response, isStream);

    const capture = { chunks: [], capturedBytes: 0, totalBytes: 0, truncated: false };
    const reader = response.body && response.body.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      appendCapture(capture, value, maxCaptureBytes);
      if (onChunk) await onChunk(value);
    }

    const raw = Buffer.concat(capture.chunks).toString('utf8');
    let responseBody;

    if (isStream) {
      const assembler = getStreamAssembler(route);
      responseBody = (!capture.truncated && assembler) ? assembler(raw) : null;
      if (!responseBody) {
        responseBody = {
          _raw_stream: raw,
          ...(capture.truncated ? {
            _truncated: true,
            _originalSizeBytes: capture.totalBytes,
          } : {}),
        };
      }
    } else if (capture.truncated) {
      responseBody = {
        _truncated: true,
        _originalSizeBytes: capture.totalBytes,
        preview: raw + '...',
      };
    } else {
      try {
        responseBody = JSON.parse(raw);
      } catch {
        responseBody = raw;
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      isStream,
      responseBody,
      truncated: capture.truncated,
      totalBytes: capture.totalBytes,
      tokenUsage: tryExtractTokenUsage(responseBody),
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    if (timedOut) {
      const timeoutError = new Error(`upstream request timed out after ${timeoutMs}ms`);
      timeoutError.timedOut = true;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener('abort', forwardAbort);
  }
}

// Everything both the proxy and replay need to describe a completed exchange.
function summarizeCompletion({ requestBody, responseBody, tokenUsage, model }) {
  return {
    requestPreview: previewRequest(requestBody),
    responsePreview: previewResponse(responseBody),
    tokenUsage,
    costUsd: estimateCost(model, tokenUsage),
  };
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
    const headers = buildUpstreamHeaders(req.headers, config);
    const model = req.body && typeof req.body.model === 'string' ? req.body.model : null;
    const storedRequest = truncateBody(req.body, maxCaptureBytes);

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
      costUsd: null,
      requestPreview: previewRequest(req.body),
      responsePreview: '',
      model,
      error: null,
      isStream: false,
      requestHeaders: maskAuthHeaders(headers),
    }).id;

    const clientAbort = new AbortController();
    const handleClientClose = () => {
      if (!res.writableEnded) clientAbort.abort(new Error('client disconnected'));
    };
    res.once('close', handleClientClose);

    let isStream = false;
    const decoder = new TextDecoder();
    let streamBuffer = '';
    const pendingChunks = [];

    function flushStreamChunks() {
      if (pendingChunks.length === 0) return;
      broadcast('stream-chunk', {
        id: requestId,
        route,
        label,
        chunks: pendingChunks.splice(0, pendingChunks.length),
      });
    }

    try {
      const result = await performUpstreamRequest({
        url: upstreamUrl,
        headers,
        body: req.body,
        route,
        timeoutMs: config.timeoutMs || 300000,
        maxCaptureBytes,
        signal: clientAbort.signal,
        onResponse: (response, stream) => {
          isStream = stream;
          res.status(response.status);
          response.headers.forEach((value, key) => {
            if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && !['content-encoding', 'content-length'].includes(key.toLowerCase())) {
              res.setHeader(key, value);
            }
          });
        },
        onChunk: async (value) => {
          await writeResponseChunk(res, value);

          if (!broadcast || !streamChunkParser || !isStream) return;
          streamBuffer += decoder.decode(value, { stream: true });
          if (Buffer.byteLength(streamBuffer, 'utf8') > maxCaptureBytes) streamBuffer = '';
          const lines = streamBuffer.split('\n');
          // Keep the last (potentially incomplete) line in the buffer
          streamBuffer = lines.pop() || '';
          for (const line of lines) {
            if (line.trim() === '') continue;
            for (const parsed of streamChunkParser(line + '\n')) {
              pendingChunks.push(parsed);
            }
          }
          flushStreamChunks();
        },
      });

      res.end();

      const record = store.complete(requestId, {
        responseStatus: result.status,
        responseBody: result.responseBody,
        responseBodyTruncated: result.truncated,
        latencyMs: result.latencyMs,
        isStream: result.isStream,
        ...summarizeCompletion({
          requestBody: req.body,
          responseBody: result.responseBody,
          tokenUsage: result.tokenUsage,
          model,
        }),
      });

      const kind = result.isStream ? 'stream assembled' : 'response';
      log(`<<< [${label}] Response (${kind}, status ${result.status})`, result.responseBody);

      if (broadcast && record) {
        broadcast('request-detail', record);
      }
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const details = err.message;

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
      res.off('close', handleClientClose);
    }
  };
}

module.exports = {
  createProxyMiddleware,
  buildUpstreamHeaders,
  buildReplayHeaders,
  maskAuthHeaders,
  performUpstreamRequest,
  summarizeCompletion,
  trimTrailingSlash,
  truncateBody,
};
