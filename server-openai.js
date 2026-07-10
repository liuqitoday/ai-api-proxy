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

function formatChatCompletionObject(payload) {
  if (!payload || typeof payload !== 'object') {
    return String(payload);
  }

  if (payload.object !== 'chat.completion') {
    return pretty(payload);
  }

  const lines = [];
  lines.push(`[completion_id: ${payload.id}] [model: ${payload.model}]`);

  for (const choice of payload.choices || []) {
    lines.push(`\n[Choice ${choice.index}] [finish_reason: ${choice.finish_reason}]`);

    const message = choice.message;
    if (!message) continue;

    if (message.content) {
      lines.push(`\n[Text]\n${message.content}`);
    }
    if (message.refusal) {
      lines.push(`\n[Refusal]\n${message.refusal}`);
    }
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        lines.push(`\n[Tool Call: ${tc.function?.name || 'unknown'} (${tc.id})]`);
        const args = tc.function?.arguments;
        if (args) {
          const parsed = tryParseJson(args);
          lines.push(parsed ? pretty(parsed) : args);
        }
      }
    }
  }

  if (payload.usage) {
    lines.push(
      `\n[Usage] prompt_tokens=${payload.usage.prompt_tokens}, completion_tokens=${payload.usage.completion_tokens}, total_tokens=${payload.usage.total_tokens}`
    );
  }

  return lines.join('\n');
}

function extractChatCompletionFromStream(raw) {
  const blocks = splitSSEBlocks(raw);
  const assembled = {};
  const choicesMap = {};

  for (const block of blocks) {
    if (!block.data || block.data === '[DONE]') continue;
    const payload = tryParseJson(block.data);
    if (!payload) continue;

    if (!assembled.id) {
      assembled.id = payload.id;
      assembled.model = payload.model;
      assembled.created = payload.created;
    }

    for (const choice of payload.choices || []) {
      const idx = choice.index;
      if (!choicesMap[idx]) {
        choicesMap[idx] = {
          index: idx,
          finish_reason: null,
          message: { role: 'assistant', content: '', tool_calls: [] },
        };
      }

      const delta = choice.delta || {};
      if (delta.role) choicesMap[idx].message.role = delta.role;
      if (delta.content) choicesMap[idx].message.content += delta.content;
      if (delta.refusal) {
        choicesMap[idx].message.refusal = (choicesMap[idx].message.refusal || '') + delta.refusal;
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tcIdx = tc.index;
          if (!choicesMap[idx].message.tool_calls[tcIdx]) {
            choicesMap[idx].message.tool_calls[tcIdx] = {
              id: tc.id || '',
              type: tc.type || 'function',
              function: { name: '', arguments: '' },
            };
          }
          if (tc.function?.name) choicesMap[idx].message.tool_calls[tcIdx].function.name += tc.function.name;
          if (tc.function?.arguments) choicesMap[idx].message.tool_calls[tcIdx].function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) choicesMap[idx].finish_reason = choice.finish_reason;
    }

    if (payload.usage) {
      assembled.usage = payload.usage;
    }
  }

  if (!assembled.id) return null;

  const choices = Object.values(choicesMap);
  for (const c of choices) {
    if (c.message.tool_calls.length === 0) delete c.message.tool_calls;
  }

  assembled.object = 'chat.completion';
  assembled.choices = choices;

  return assembled;
}

function extractResponseFromStream(raw) {
  const blocks = splitSSEBlocks(raw);

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block.data || block.data === '[DONE]') continue;

    const payload = tryParseJson(block.data);
    if (!payload) continue;

    const type = payload.type || block.event || 'unknown';

    if (type === 'response.completed' || type === 'response.failed') {
      return payload.response || null;
    }
  }

  return null;
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
      const completeResponse = extractResponseFromStream(raw);
      if (completeResponse) {
        log(`<<< Response (stream assembled, status ${response.status}):\n${pretty(completeResponse)}`);
      } else {
        log(`<<< Response (stream raw, status ${response.status}):\n${raw}`);
      }
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

app.post('/v1/chat/completions', async (req, res) => {
  log(`>>> [Chat Completions] Request Body:\n${pretty(req.body)}`);

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
      const assembled = extractChatCompletionFromStream(raw);
      if (assembled) {
        log(`<<< [Chat Completions] Response (stream assembled, status ${response.status}):\n${formatChatCompletionObject(assembled)}`);
      } else {
        log(`<<< [Chat Completions] Response (stream raw, status ${response.status}):\n${raw}`);
      }
      return;
    }

    const responseBody = await response.text();
    const parsedBody = tryParseJson(responseBody);
    const formattedBody = parsedBody ? formatChatCompletionObject(parsedBody) : responseBody;
    log(`<<< [Chat Completions] Response (status ${response.status}):\n${formattedBody}`);
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

app.listen(port, '127.0.0.1', () => {
  console.log(`OpenAI proxy listening on http://127.0.0.1:${port} -> ${apiBase}`);
  console.log(`  - POST /v1/responses`);
  console.log(`  - POST /v1/chat/completions`);
});
