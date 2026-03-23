const express = require('express');
const fs = require('fs');
const config = require('./config.json');

const app = express();
app.use(express.json({ limit: '10mb' }));

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(config.logFile, line);
}

function parseSSEEvents(raw) {
  const pieces = [];
  let thinking = '';
  let toolInput = '';
  let textContent = '';

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const json = line.slice(6).trim();
    if (!json || json === '[DONE]') continue;

    try {
      const event = JSON.parse(json);

      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'thinking_delta') {
          thinking += delta.thinking;
        } else if (delta.type === 'text_delta') {
          textContent += delta.text;
        } else if (delta.type === 'input_json_delta') {
          toolInput += delta.partial_json;
        }
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          if (toolInput) pieces.push({ type: 'tool_input', content: toolInput });
          toolInput = '';
          pieces.push({ type: 'tool_use_start', name: block.name, id: block.id });
        }
      } else if (event.type === 'content_block_stop') {
        if (thinking) { pieces.push({ type: 'thinking', content: thinking }); thinking = ''; }
        if (textContent) { pieces.push({ type: 'text', content: textContent }); textContent = ''; }
        if (toolInput) { pieces.push({ type: 'tool_input', content: toolInput }); toolInput = ''; }
      } else if (event.type === 'message_start') {
        pieces.push({ type: 'message_start', model: event.message?.model, usage: event.message?.usage });
      } else if (event.type === 'message_delta') {
        pieces.push({ type: 'message_delta', stop_reason: event.delta?.stop_reason, usage: event.usage });
      }
    } catch {}
  }

  // flush remaining
  if (thinking) pieces.push({ type: 'thinking', content: thinking });
  if (textContent) pieces.push({ type: 'text', content: textContent });
  if (toolInput) pieces.push({ type: 'tool_input', content: toolInput });

  // format readable output
  const lines = [];
  for (const p of pieces) {
    if (p.type === 'message_start') {
      lines.push(`[model: ${p.model}] [input_tokens: ${p.usage?.input_tokens}, cache_creation: ${p.usage?.cache_creation_input_tokens}, cache_read: ${p.usage?.cache_read_input_tokens}]`);
    } else if (p.type === 'thinking') {
      lines.push(`\n[Thinking]\n${p.content}`);
    } else if (p.type === 'text') {
      lines.push(`\n[Text]\n${p.content}`);
    } else if (p.type === 'tool_use_start') {
      lines.push(`\n[Tool Use: ${p.name} (${p.id})]`);
    } else if (p.type === 'tool_input') {
      try { lines.push(JSON.stringify(JSON.parse(p.content), null, 2)); } catch { lines.push(p.content); }
    } else if (p.type === 'message_delta') {
      lines.push(`\n[stop_reason: ${p.stop_reason}] [output_tokens: ${p.usage?.output_tokens}]`);
    }
  }
  return lines.join('\n');
}

app.post('/v1/messages', async (req, res) => {
  log(`>>> Request Body:\n${JSON.stringify(req.body, null, 2)}`);

  try {
    const upstreamUrl = `${config.upstream}/v1/messages`;
    const headers = { ...req.headers, host: new URL(config.upstream).host };
    delete headers['content-length'];

    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });

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
      const parsed = parseSSEEvents(raw);
      log(`<<< Response (stream, status ${response.status}):\n${parsed}`);
    } else {
      const responseBody = await response.text();
      log(`<<< Response (status ${response.status}):\n${responseBody}`);
      res.send(responseBody);
    }
  } catch (err) {
    log(`!!! Error: ${err.message}`);
    res.status(502).json({ error: 'upstream request failed' });
  }
});

app.listen(config.port, () => {
  console.log(`Proxy listening on http://localhost:${config.port} -> ${config.upstream}`);
});
