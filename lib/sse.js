// SSE parsing utilities extracted from server-openai.js and server-anthropic.js

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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

// --- Shared helpers for stream chunk parsers ---

function tryParseStreamLine(line) {
  if (!line.startsWith('data: ')) return null;
  const json = line.slice(6).trim();
  if (!json || json === '[DONE]') return null;
  try { return JSON.parse(json); } catch { return null; }
}

function* parseStreamLine(line, onParsed) {
  const payload = tryParseStreamLine(line);
  if (payload) yield* onParsed(payload);
}

// --- Anthropic Messages stream assembly ---

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
        if (event.delta && event.delta.stop_reason) {
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

// --- OpenAI Chat Completions stream assembly ---

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
          if (tc.function && tc.function.name) choicesMap[idx].message.tool_calls[tcIdx].function.name += tc.function.name;
          if (tc.function && tc.function.arguments) choicesMap[idx].message.tool_calls[tcIdx].function.arguments += tc.function.arguments;
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

// --- OpenAI Responses stream assembly ---

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

// --- Parse Anthropic stream chunks for live display ---

function* parseAnthropicStreamChunks(line) {
  yield* parseStreamLine(line, function* (event) {
    if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta.type === 'text_delta') {
        yield { type: 'text', content: delta.text };
      } else if (delta.type === 'input_json_delta') {
        yield { type: 'tool_args', content: delta.partial_json };
      }
    } else if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block.type === 'tool_use') {
        yield { type: 'tool_start', name: block.name, id: block.id };
      } else if (block.type === 'thinking') {
        yield { type: 'thinking', content: block.thinking || '' };
      }
    } else if (event.type === 'message_delta') {
      if (event.usage) {
        yield { type: 'usage', usage: event.usage };
      }
    }
  });
}

// --- Parse OpenAI Chat Completions stream chunks for live display ---

function* parseChatCompletionsStreamChunks(line) {
  yield* parseStreamLine(line, function* (payload) {
    for (const choice of payload.choices || []) {
      const delta = choice.delta || {};
      if (delta.content) {
        yield { type: 'text', content: delta.content };
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function && tc.function.name) {
            yield { type: 'tool_start', name: tc.function.name, id: tc.id };
          }
          if (tc.function && tc.function.arguments) {
            yield { type: 'tool_args', content: tc.function.arguments };
          }
        }
      }
      if (choice.finish_reason) {
        yield { type: 'done', finish_reason: choice.finish_reason };
      }
    }
  });
}

// --- Parse OpenAI Responses stream chunks for live display ---

function* parseResponsesStreamChunks(line) {
  yield* parseStreamLine(line, function* (payload) {
    const type = payload.type || '';
    if (type === 'response.output_text.delta') {
      yield { type: 'text', content: payload.delta || '' };
    } else if (type === 'response.output_item.added') {
      if (payload.item) {
        yield { type: 'item_added', item: payload.item };
      }
    } else if (type === 'response.output_item.done') {
      if (payload.item) {
        yield { type: 'item_done', item: payload.item };
      }
    } else if (type === 'response.completed') {
      if (payload.response && payload.response.usage) {
        yield { type: 'usage', usage: payload.response.usage };
      }
    } else if (type === 'response.failed') {
      yield { type: 'error', error: 'response failed' };
    }
  });
}

// --- Token usage extraction ---

function tryExtractTokenUsage(body) {
  if (!body || typeof body !== 'object') return null;

  // OpenAI Chat Completions (most specific: uses prompt_tokens / completion_tokens)
  if (body.usage && body.usage.prompt_tokens !== undefined) {
    return {
      input_tokens: body.usage.prompt_tokens || 0,
      output_tokens: body.usage.completion_tokens || 0,
      total_tokens: body.usage.total_tokens || 0,
    };
  }

  // Anthropic Messages API (has input_tokens but no total_tokens)
  if (body.usage && typeof body.usage.input_tokens === 'number' && body.usage.total_tokens === undefined) {
    return {
      input_tokens: body.usage.input_tokens || 0,
      output_tokens: body.usage.output_tokens || 0,
      total_tokens: (body.usage.input_tokens || 0) + (body.usage.output_tokens || 0),
    };
  }

  // OpenAI Responses API (fallback for any other usage shape)
  if (body.usage) {
    return {
      input_tokens: body.usage.input_tokens || 0,
      output_tokens: body.usage.output_tokens || 0,
      total_tokens: body.usage.total_tokens || 0,
    };
  }

  return null;
}

module.exports = {
  tryParseJson,
  splitSSEBlocks,
  assembleStreamToJSON,
  extractChatCompletionFromStream,
  extractResponseFromStream,
  parseAnthropicStreamChunks,
  parseChatCompletionsStreamChunks,
  parseResponsesStreamChunks,
  tryExtractTokenUsage,
};
