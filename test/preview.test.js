const test = require('node:test');
const assert = require('node:assert/strict');
const { previewRequest, previewResponse, PREVIEW_CHARS } = require('../lib/preview');

test('request preview uses the last chat message', () => {
  const preview = previewRequest({
    model: 'gpt-5',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: '介绍一下这个项目' },
    ],
  });
  assert.equal(preview, '介绍一下这个项目');
});

test('request preview joins the text parts of a structured message', () => {
  const preview = previewRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        { type: 'text', text: 'second' },
      ],
    }],
  });
  assert.equal(preview, 'first second');
});

test('request preview falls back to the responses api input field', () => {
  assert.equal(previewRequest({ input: 'hello there' }), 'hello there');
  assert.equal(
    previewRequest({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'from item' }] }] }),
    'from item',
  );
});

test('request preview ignores bodies with nothing readable', () => {
  assert.equal(previewRequest(null), '');
  assert.equal(previewRequest('a string body'), '');
  assert.equal(previewRequest({ model: 'gpt-5' }), '');
  assert.equal(previewRequest({ messages: [] }), '');
  assert.equal(previewRequest({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }), '');
});

test('request preview is clipped to the preview width', () => {
  const preview = previewRequest({ input: 'x'.repeat(500) });
  assert.equal(preview.length, PREVIEW_CHARS);
});

test('response preview reads anthropic message content', () => {
  const preview = previewResponse({
    type: 'message',
    content: [{ type: 'text', text: 'Hello there' }],
  });
  assert.equal(preview, 'Hello there');
});

test('response preview reads responses api output items', () => {
  const preview = previewResponse({
    object: 'response',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: 'Answer text' }] },
    ],
  });
  assert.equal(preview, 'Answer text');
});

test('response preview reads chat completion choices', () => {
  assert.equal(
    previewResponse({ choices: [{ message: { role: 'assistant', content: 'Chat reply' } }] }),
    'Chat reply',
  );
  assert.equal(
    previewResponse({ choices: [{ message: { role: 'assistant', content: null, refusal: 'I cannot' } }] }),
    '[Refusal] I cannot',
  );
});

test('response preview describes errors and unparsed streams', () => {
  assert.equal(previewResponse({ error: { message: 'unknown model' } }), '[Error] {"message":"unknown model"}');
  assert.equal(previewResponse({ error: 'upstream exploded' }), '[Error] upstream exploded');
  assert.equal(previewResponse({ _raw_stream: 'data: {"a":1}\n\n' }), '[Raw Stream] data: {"a":1}\n\n');
});

test('response preview ignores bodies with nothing readable', () => {
  assert.equal(previewResponse(null), '');
  assert.equal(previewResponse({ content: [] }), '');
  assert.equal(previewResponse({ output: [{ type: 'message', content: [] }] }), '');
});
