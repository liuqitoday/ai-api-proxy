const test = require('node:test');
const assert = require('node:assert/strict');
const { assembleStreamToJSON, parseAnthropicStreamChunks } = require('../lib/sse');

function sse(events) {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

const MESSAGE_START = {
  event: 'message_start',
  data: {
    type: 'message_start',
    message: { id: 'msg_1', model: 'claude-sonnet-4-6', role: 'assistant', usage: { input_tokens: 900, output_tokens: 0 } },
  },
};

test('a message_start event produces a message', () => {
  const message = assembleStreamToJSON(sse([MESSAGE_START]));
  assert.equal(message.id, 'msg_1');
  assert.equal(message.model, 'claude-sonnet-4-6');
  assert.deepEqual(message.content, []);
});

test('a mid-stream error is kept next to the partial answer', () => {
  const message = assembleStreamToJSON(sse([
    MESSAGE_START,
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer' } } },
    { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
  ]));

  assert.equal(message.content[0].text, 'partial answer');
  assert.deepEqual(message.error, { type: 'overloaded_error', message: 'Overloaded' });
});

test('an error-only stream keeps the error instead of being discarded', () => {
  const message = assembleStreamToJSON(sse([
    { event: 'error', data: { type: 'error', error: { type: 'rate_limit_error', message: 'rate limit reached' } } },
  ]));

  assert.ok(message, 'an error must not fall back to the raw stream');
  assert.equal(message.error.message, 'rate limit reached');
});

test('tool arguments survive a stream that ends before the block closes', () => {
  const message = assembleStreamToJSON(sse([
    MESSAGE_START,
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search_repo', input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"half' } } },
  ]));

  const block = message.content[0];
  assert.equal(block.name, 'search_repo');
  assert.equal(block.partial_json, '{"query":"half');
});

test('a closed tool block is still parsed into input, not left partial', () => {
  const message = assembleStreamToJSON(sse([
    MESSAGE_START,
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search_repo', input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"websocket"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  ]));

  assert.deepEqual(message.content[0].input, { query: 'websocket' });
  assert.equal(message.content[0].partial_json, undefined);
});

test('a payload with no recognisable event yields nothing so the raw stream can be kept', () => {
  assert.equal(assembleStreamToJSON('this is not SSE formatted at all\njust lines\n'), null);
  assert.equal(assembleStreamToJSON(''), null);
  assert.equal(assembleStreamToJSON('event: ping\ndata: {"type":"ping"}\n\n'), null);
});

test('an anthropic error event is surfaced to the live panel', () => {
  const line = `data: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n`;
  assert.deepEqual([...parseAnthropicStreamChunks(line)], [{ type: 'error', error: 'overloaded_error: Overloaded' }]);
});

test('anthropic events without a message are still ignored', () => {
  assert.deepEqual([...parseAnthropicStreamChunks('data: {"type":"ping"}\n')], []);
  assert.deepEqual([...parseAnthropicStreamChunks('data: [DONE]\n')], []);
});
