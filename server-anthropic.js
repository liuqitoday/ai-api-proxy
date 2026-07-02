const express = require('express');
const fs = require('fs');
const config = require('./config.json');

const app = express();
app.use(express.json({ limit: '10mb' }));

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(config.logFile, line);
}

function assembleStreamToJSON(raw) {
  const message = {
    id: null,
    type: 'message',
    role: 'assistant',
    model: null,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  };

  const contentBlocks = {};
  let currentBlockIndex = -1;

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const json = line.slice(6).trim();
    if (!json || json === '[DONE]') continue;

    try {
      const event = JSON.parse(json);

      if (event.type === 'message_start') {
        const msg = event.message;
        message.id = msg.id;
        message.model = msg.model;
        message.role = msg.role;
        message.stop_reason = msg.stop_reason;
        message.stop_sequence = msg.stop_sequence;
        if (msg.usage) {
          message.usage.input_tokens = msg.usage.input_tokens || 0;
          message.usage.cache_creation_input_tokens = msg.usage.cache_creation_input_tokens || 0;
          message.usage.cache_read_input_tokens = msg.usage.cache_read_input_tokens || 0;
        }
      } else if (event.type === 'content_block_start') {
        currentBlockIndex = event.index;
        const block = event.content_block;
        contentBlocks[currentBlockIndex] = {
          type: block.type,
          text: block.text || '',
          thinking: block.thinking || '',
          signature: block.signature || '',
          id: block.id || null,
          name: block.name || null,
          input: block.input || {},
          partial_json: ''
        };
      } else if (event.type === 'content_block_delta') {
        const idx = event.index;
        const delta = event.delta;
        const block = contentBlocks[idx];
        if (!block) continue;

        if (delta.type === 'text_delta') {
          block.text += delta.text;
        } else if (delta.type === 'thinking_delta') {
          block.thinking += delta.thinking;
        } else if (delta.type === 'signature_delta') {
          block.signature += delta.signature;
        } else if (delta.type === 'input_json_delta') {
          block.partial_json += delta.partial_json;
        }
      } else if (event.type === 'content_block_stop') {
        const idx = event.index;
        const block = contentBlocks[idx];
        if (block && block.partial_json) {
          try {
            block.input = JSON.parse(block.partial_json);
          } catch {
            block.input = { raw: block.partial_json };
          }
          delete block.partial_json;
        }
      } else if (event.type === 'message_delta') {
        if (event.delta?.stop_reason) {
          message.stop_reason = event.delta.stop_reason;
        }
        if (event.usage) {
          message.usage.output_tokens = event.usage.output_tokens || 0;
          if (event.usage.cache_creation_input_tokens !== undefined) {
            message.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
          }
          if (event.usage.cache_read_input_tokens !== undefined) {
            message.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
          }
        }
      }
    } catch {}
  }

  // Build content array from content blocks
  for (const idx of Object.keys(contentBlocks).sort((a, b) => Number(a) - Number(b))) {
    const block = contentBlocks[idx];
    const contentItem = { type: block.type };

    if (block.type === 'text') {
      contentItem.text = block.text;
    } else if (block.type === 'thinking') {
      contentItem.thinking = block.thinking;
      if (block.signature) contentItem.signature = block.signature;
    } else if (block.type === 'tool_use') {
      contentItem.id = block.id;
      contentItem.name = block.name;
      contentItem.input = block.input;
    }

    message.content.push(contentItem);
  }

  return message;
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
      const assembledJSON = assembleStreamToJSON(raw);
      log(`<<< Response (stream assembled, status ${response.status}):\n${JSON.stringify(assembledJSON, null, 2)}`);
    } else {
      const responseBody = await response.text();
      try {
        const parsed = JSON.parse(responseBody);
        log(`<<< Response (non-stream, status ${response.status}):\n${JSON.stringify(parsed, null, 2)}`);
      } catch {
        log(`<<< Response (non-stream, status ${response.status}):\n${responseBody}`);
      }
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
