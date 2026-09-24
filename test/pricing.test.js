const test = require('node:test');
const assert = require('node:assert/strict');
const { findPricing, estimateCost, MODEL_PRICING } = require('../lib/pricing');

test('pricing lookup is case insensitive and exact first', () => {
  assert.deepEqual(findPricing('GPT-4O-Mini'), MODEL_PRICING['gpt-4o-mini']);
  assert.deepEqual(findPricing('claude-sonnet-4-6'), MODEL_PRICING['claude-sonnet-4-6']);
});

test('pricing lookup prefers the longest matching model key', () => {
  // "claude-sonnet-4-6" must win over the shorter "claude-sonnet-4".
  assert.deepEqual(findPricing('claude-sonnet-4-6-20250219'), MODEL_PRICING['claude-sonnet-4-6']);
  assert.deepEqual(findPricing('gpt-5-mini-2026-01-01'), MODEL_PRICING['gpt-5-mini']);
  assert.deepEqual(findPricing('gpt-5-2026-01-01'), MODEL_PRICING['gpt-5']);
});

test('pricing lookup handles provider prefixes used by gateways', () => {
  assert.deepEqual(findPricing('anthropic/claude-haiku-4-5'), MODEL_PRICING['claude-haiku-4-5']);
});

test('pricing lookup returns null for unknown or missing models', () => {
  assert.equal(findPricing('my-local-llama'), null);
  assert.equal(findPricing(''), null);
  assert.equal(findPricing(null), null);
});

test('cost is estimated from tokens and per-million pricing', () => {
  const cost = estimateCost('claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 500 });
  assert.equal(cost, 0.0105);
});

test('cost estimation returns null when it cannot be known', () => {
  assert.equal(estimateCost('my-local-llama', { input_tokens: 1000, output_tokens: 500 }), null);
  assert.equal(estimateCost('gpt-4o', { input_tokens: 0, output_tokens: 0 }), null);
  assert.equal(estimateCost('gpt-4o', null), null);
});

test('cost treats a missing token side as zero', () => {
  assert.equal(estimateCost('gpt-4o-mini', { input_tokens: 0, output_tokens: 1e6 }), 0.6);
});
