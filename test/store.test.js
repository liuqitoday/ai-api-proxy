const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lib/store');

test('pending requests are aggregated exactly once when completed', () => {
  const store = createStore(5);
  const record = store.add({
    route: '/v1/responses',
    model: 'gpt-test',
    responseStatus: null,
    latencyMs: null,
    tokenUsage: null,
  });

  const pending = store.getStats();
  assert.equal(pending.totalRequests, 1);
  assert.equal(pending.successfulRequests, 0);
  assert.equal(pending.errorRequests, 0);
  assert.equal(pending.pendingRequests, 1);
  assert.deepEqual(pending.totalTokens, { input: 0, output: 0, total: 0 });

  store.complete(record.id, {
    responseStatus: 200,
    latencyMs: 125,
    tokenUsage: { input_tokens: 10, output_tokens: 5 },
  });
  store.complete(record.id, { latencyMs: 999 });

  const stats = store.getStats();
  assert.equal(stats.successfulRequests, 1);
  assert.equal(stats.errorRequests, 0);
  assert.equal(stats.pendingRequests, 0);
  assert.equal(stats.averageLatencyMs, 125);
  assert.deepEqual(stats.totalTokens, { input: 10, output: 5, total: 15 });
});

test('records added with a terminal status are completed immediately', () => {
  const store = createStore(2);
  store.add({ responseStatus: 502, latencyMs: 20, error: 'failed' });
  const stats = store.getStats();
  assert.equal(stats.totalRequests, 1);
  assert.equal(stats.errorRequests, 1);
  assert.equal(stats.pendingRequests, 0);
});

test('an in-flight record still completes after ring-buffer eviction', () => {
  const store = createStore(1);
  const first = store.add({ responseStatus: null, latencyMs: null });
  store.add({ responseStatus: 200, latencyMs: 5 });

  assert.equal(store.getById(first.id) !== null, true);
  store.complete(first.id, { responseStatus: 200, latencyMs: 10 });

  const stats = store.getStats();
  assert.equal(stats.totalRequests, 2);
  assert.equal(stats.successfulRequests, 2);
  assert.equal(stats.pendingRequests, 0);
  assert.equal(store.getById(first.id), null);
});
