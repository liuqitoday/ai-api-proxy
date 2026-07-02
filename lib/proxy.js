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
  if (masked.authorization) {
    masked.authorization = masked.authorization.slice(0, 16) + '...';
  }
  if (masked['x-api-key']) {
    masked['x-api-key'] = masked['x-api-key'].slice(0, 8) + '...';
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
  if (typeof body === 'string' && body.length > maxLength) {
    return body.slice(0, maxLength) + `... [truncated, ${body.length} total chars]`;
  }
  const str = JSON.stringify(body, null, 2);
  if (str && str.length > maxLength) {
    return JSON.stringify({ _truncated: true, _originalSize: str.length, preview: str.slice(0, maxLength) + '...' }, null, 2);
  }
  return body;
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

    log(`>>> [${label}] Request Body`, req.body);

    const apiBase = trimTrailingSlash(config.apiBase || 'https://api.openai.com');
    const upstreamUrl = `${apiBase}${route}`;
    const headers = buildUpstreamHeaders(req, config);
    const timeoutMs = config.timeoutMs || 300000;

    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const requestId = store.add({
      timestamp: startTime,
      method: 'POST',
      route,
      requestBody: req.body,
      responseStatus: null,
      responseBody: null,
      latencyMs: 0,
      tokenUsage: null,
      model: req.body && req.body.model || null,
      error: null,
      isStream: false,
      requestHeaders: maskAuthHeaders(req.headers),
    }).id;

    try {
      // Note: Client disconnect detection is disabled to prevent premature aborts
      // The upstream request will complete even if the client disconnects
      // This is useful when the client has aggressive timeout settings

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
        let streamBuffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          chunks.push(chunk);
          res.write(chunk);

          // Parse live chunks for WebSocket streaming (with line buffering)
          if (broadcast && streamChunkParser) {
            streamBuffer += chunk;
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

        const raw = chunks.join('');
        const latencyMs = Date.now() - startTime;

        // Assemble the full response for storage
        let assembledBody = null;
        if (streamAssembler) {
          try {
            assembledBody = streamAssembler(raw);
          } catch {
            assembledBody = null;
          }
        }
        if (!assembledBody) {
          assembledBody = { _raw_stream: raw };
        }

        const tokenUsage = tryExtractTokenUsage(assembledBody);

        // Update the store record with complete info
        const record = store.getById(requestId);
        if (record) {
          record.responseStatus = response.status;
          record.responseBody = assembledBody;
          record.latencyMs = latencyMs;
          record.tokenUsage = tokenUsage;
          record.isStream = true;
        }

        log(`<<< [${label}] Response (stream assembled, status ${response.status})`, assembledBody);

        if (broadcast && record) {
          broadcast('request-detail', record);
        }
      } else {
        const responseBody = await response.text();
        const latencyMs = Date.now() - startTime;
        let parsedBody;

        try {
          parsedBody = JSON.parse(responseBody);
        } catch {
          parsedBody = responseBody;
        }

        const tokenUsage = tryExtractTokenUsage(parsedBody);

        // Update the store record
        const record = store.getById(requestId);
        if (record) {
          record.responseStatus = response.status;
          record.responseBody = parsedBody;
          record.latencyMs = latencyMs;
          record.tokenUsage = tokenUsage;
          record.isStream = false;
        }

        log(`<<< [${label}] Response (status ${response.status})`, parsedBody);

        if (broadcast && record) {
          broadcast('request-detail', record);
        }

        res.send(responseBody);
      }
    } catch (err) {
      clearTimeout(timeoutHandle);

      const latencyMs = Date.now() - startTime;
      const details = timedOut
        ? `upstream request timed out after ${timeoutMs}ms`
        : err.message;

      log(`!!! [${label}] Error: ${details}`);

      // Update the store record
      const record = store.getById(requestId);
      if (record) {
        record.responseStatus = 502;
        record.error = details;
        record.latencyMs = latencyMs;
        record.isStream = false;
      }

      if (broadcast && record) {
        broadcast('request-detail', record);
      }

      if (res.headersSent) {
        res.end();
        return;
      }

      res.status(502).json({ error: 'upstream request failed', details });
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
};
