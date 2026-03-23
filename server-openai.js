const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const config = loadConfig();

const apiBase = trimTrailingSlash(config.apiBase || config.upstream || 'https://api.openai.com');
const port = config.port || 3001;
const logFile = path.resolve(__dirname, config.logFile || 'proxy-openai.log');
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
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function splitSSEBlocks(raw) {
  const blocks = [];
  const lines = raw.split(/\r?\n/);
  let eventName = '';
  let dataLines = [];

  function flush() {
    if (!eventName && dataLines.length === 0) return;
    blocks.push({
      event: eventName || null,
      data: dataLines.join('\n'),
    });
    eventName = '';
    dataLines = [];
  }

  for (const line of lines) {
    if (line === '') {
      flush();
      continue;
    }

    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  flush();
  return blocks;
}

function isToolLikeItem(item) {
  const type = item?.type;
  return typeof type === 'string' && (
    type === 'function_call' ||
    type === 'custom_tool_call' ||
    type === 'mcp_call' ||
    type.endsWith('_call')
  );
}

function itemDisplayName(item) {
  if (!item) return 'unknown';
  return item.name || item.type || 'unknown';
}

function formatToolItem(item) {
  const lines = [];
  const identity = item.call_id || item.id || 'unknown';
  lines.push(`[Tool Call: ${itemDisplayName(item)} (${identity})]`);

  if (item.arguments) {
    const parsedArgs = typeof item.arguments === 'string' ? tryParseJson(item.arguments) : item.arguments;
    lines.push(parsedArgs ? pretty(parsedArgs) : String(item.arguments));
  } else {
    lines.push(pretty(item));
  }

  return lines.join('\n');
}

function formatOutputMessage(item) {
  const lines = [];

  for (const part of item.content || []) {
    if (part.type === 'output_text') {
      lines.push(`\n[Text]\n${part.text}`);
    } else if (part.type === 'refusal') {
      const refusalText = part.refusal || part.text || pretty(part);
      lines.push(`\n[Refusal]\n${refusalText}`);
    } else {
      lines.push(`\n[Content Part: ${part.type || 'unknown'}]\n${pretty(part)}`);
    }
  }

  return lines.join('\n');
}

function formatResponseObject(payload) {
  if (!payload || typeof payload !== 'object') {
    return String(payload);
  }

  if (payload.object !== 'response') {
    return pretty(payload);
  }

  const lines = [];
  lines.push(`[response_id: ${payload.id}] [model: ${payload.model}] [status: ${payload.status}]`);

  for (const item of payload.output || []) {
    if (item.type === 'message') {
      const formatted = formatOutputMessage(item);
      if (formatted) lines.push(formatted);
      continue;
    }

    if (item.type === 'reasoning') {
      const summaryText = (item.summary || [])
        .map((part) => part?.text)
        .filter(Boolean)
        .join('\n');
      if (summaryText) lines.push(`\n[Reasoning Summary]\n${summaryText}`);
      continue;
    }

    if (isToolLikeItem(item)) {
      lines.push(`\n${formatToolItem(item)}`);
      continue;
    }

    lines.push(`\n[Output Item: ${item.type || 'unknown'}]\n${pretty(item)}`);
  }

  if (payload.error) {
    lines.push(`\n[Error]\n${pretty(payload.error)}`);
  }

  if (payload.usage) {
    lines.push(
      `\n[Usage] input_tokens=${payload.usage.input_tokens}, output_tokens=${payload.usage.output_tokens}, total_tokens=${payload.usage.total_tokens}`
    );
  }

  return lines.join('\n');
}

function parseOpenAIResponseStream(raw) {
  const blocks = splitSSEBlocks(raw);
  const pieces = [];
  let text = '';
  let refusal = '';
  const argBuffers = new Map();

  function flushText() {
    if (!text) return;
    pieces.push(`\n[Text]\n${text}`);
    text = '';
  }

  function flushRefusal() {
    if (!refusal) return;
    pieces.push(`\n[Refusal]\n${refusal}`);
    refusal = '';
  }

  function flushArguments(itemId) {
    const entry = argBuffers.get(itemId);
    if (!entry || !entry.buffer) return;

    const parsedArgs = tryParseJson(entry.buffer);
    pieces.push(`\n[Tool Arguments: ${entry.name || itemId} (${itemId})]`);
    pieces.push(parsedArgs ? pretty(parsedArgs) : entry.buffer);
    argBuffers.delete(itemId);
  }

  function flushAllArguments() {
    for (const itemId of Array.from(argBuffers.keys())) {
      flushArguments(itemId);
    }
  }

  for (const block of blocks) {
    if (!block.data || block.data === '[DONE]') continue;

    const payload = tryParseJson(block.data);
    if (!payload) continue;

    const type = payload.type || block.event || 'unknown';

    if (type === 'response.created') {
      const response = payload.response || payload;
      pieces.push(`[response_id: ${response.id}] [model: ${response.model}] [status: ${response.status}]`);
      continue;
    }

    if (type === 'response.in_progress') {
      pieces.push(`[status: in_progress]`);
      continue;
    }

    if (type === 'response.output_text.delta') {
      text += payload.delta || '';
      continue;
    }

    if (type === 'response.output_text.done') {
      if (typeof payload.text === 'string' && !text) {
        text = payload.text;
      }
      flushText();
      continue;
    }

    if (type === 'response.refusal.delta') {
      refusal += payload.delta || '';
      continue;
    }

    if (type === 'response.refusal.done') {
      if (typeof payload.refusal === 'string' && !refusal) {
        refusal = payload.refusal;
      }
      flushRefusal();
      continue;
    }

    if (type === 'response.output_item.added') {
      const item = payload.item;
      if (isToolLikeItem(item)) {
        flushText();
        flushRefusal();
        pieces.push(`\n[Tool Start: ${itemDisplayName(item)} (${item.call_id || item.id || 'unknown'})]`);
      }
      continue;
    }

    if (type === 'response.function_call_arguments.delta') {
      const itemId = payload.item_id || 'unknown';
      const previous = argBuffers.get(itemId) || { name: payload.name || null, buffer: '' };
      previous.buffer += payload.delta || '';
      if (!previous.name && payload.name) previous.name = payload.name;
      argBuffers.set(itemId, previous);
      continue;
    }

    if (type === 'response.function_call_arguments.done') {
      const itemId = payload.item_id || 'unknown';
      const previous = argBuffers.get(itemId) || { name: payload.name || null, buffer: '' };
      if (typeof payload.arguments === 'string' && !previous.buffer) {
        previous.buffer = payload.arguments;
      }
      if (!previous.name && payload.name) previous.name = payload.name;
      argBuffers.set(itemId, previous);
      flushArguments(itemId);
      continue;
    }

    if (type === 'response.output_item.done') {
      const item = payload.item;
      if (isToolLikeItem(item)) {
        flushText();
        flushRefusal();
        flushArguments(item.id);
        pieces.push(`\n${formatToolItem(item)}`);
      }
      continue;
    }

    if (type === 'response.completed') {
      const response = payload.response || payload;
      flushText();
      flushRefusal();
      flushAllArguments();
      pieces.push(`\n[status: completed]`);
      if (response.usage) {
        pieces.push(
          `[Usage] input_tokens=${response.usage.input_tokens}, output_tokens=${response.usage.output_tokens}, total_tokens=${response.usage.total_tokens}`
        );
      }
      continue;
    }

    if (type === 'response.failed') {
      const response = payload.response || payload;
      flushText();
      flushRefusal();
      flushAllArguments();
      pieces.push(`\n[status: failed]`);
      if (response.error) {
        pieces.push(`[Error]\n${pretty(response.error)}`);
      }
      continue;
    }

    if (type === 'error') {
      flushText();
      flushRefusal();
      flushAllArguments();
      pieces.push(`\n[Error Event]\n${pretty(payload)}`);
      continue;
    }
  }

  flushText();
  flushRefusal();
  flushAllArguments();

  return pieces.join('\n') || raw;
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
  log(`>>> Request Body:\n${pretty(req.body)}`);

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
      const parsed = parseOpenAIResponseStream(raw);
      log(`<<< Response (stream, status ${response.status}):\n${parsed}`);
      return;
    }

    const responseBody = await response.text();
    const parsedBody = tryParseJson(responseBody);
    const formattedBody = parsedBody ? formatResponseObject(parsedBody) : responseBody;
    log(`<<< Response (status ${response.status}):\n${formattedBody}`);
    res.send(responseBody);
  } catch (err) {
    clearTimeout(timeoutHandle);

    const details = timedOut
      ? `upstream request timed out after ${timeoutMs}ms`
      : err.message;

    log(`!!! Error: ${details}`);

    if (res.headersSent) {
      res.end();
      return;
    }

    res.status(502).json({ error: 'upstream request failed', details });
  }
});

app.listen(port, () => {
  console.log(`OpenAI proxy listening on http://localhost:${port} -> ${apiBase}/v1/responses`);
});
