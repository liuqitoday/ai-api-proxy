// Ring buffer request store + live stats
const crypto = require('crypto');

function createStore(maxSize) {
  let max = Math.max(1, maxSize || 500);
  const buffer = [];
  const byId = new Map();
  const bufferedIds = new Set();
  const completedRecords = new WeakSet();
  let startTime = Date.now();

  // Aggregated stats counters
  let totalRequests = 0;
  let successfulRequests = 0;
  let errorRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const requestsByModel = new Map();
  const requestsByRoute = new Map();
  let totalLatencyMs = 0;
  const recentLatencies = []; // last 20

  function generateId() {
    return crypto.randomUUID();
  }

  function aggregateCompletion(record) {
    if (completedRecords.has(record)) return record;
    if (record.responseStatus == null && !record.error) return record;

    completedRecords.add(record);
    if (record.responseStatus >= 200 && record.responseStatus < 400) {
      successfulRequests++;
    } else {
      errorRequests++;
    }

    if (record.tokenUsage) {
      totalInputTokens += record.tokenUsage.input_tokens || 0;
      totalOutputTokens += record.tokenUsage.output_tokens || 0;
    }

    if (typeof record.latencyMs === 'number') {
      totalLatencyMs += record.latencyMs;
      recentLatencies.push(record.latencyMs);
      if (recentLatencies.length > 20) recentLatencies.shift();
    }

    if (!bufferedIds.has(record.id)) byId.delete(record.id);

    return record;
  }

  function add(record) {
    if (!record.id) {
      record.id = generateId();
    }

    buffer.push(record);
    byId.set(record.id, record);
    bufferedIds.add(record.id);

    // Evict oldest if over capacity
    while (buffer.length > max) {
      const evicted = buffer.shift();
      bufferedIds.delete(evicted.id);
      if (completedRecords.has(evicted)) byId.delete(evicted.id);
    }

    // Count the request now; outcome metrics are recorded by complete().
    totalRequests++;

    if (record.model) {
      const count = requestsByModel.get(record.model) || 0;
      requestsByModel.set(record.model, count + 1);
    }

    if (record.route) {
      const count = requestsByRoute.get(record.route) || 0;
      requestsByRoute.set(record.route, count + 1);
    }

    return aggregateCompletion(record);
  }

  function complete(id, patch) {
    const record = byId.get(id);
    if (!record) return null;
    Object.assign(record, patch);
    return aggregateCompletion(record);
  }

  function getAll() {
    // Return newest first
    return [...buffer].reverse();
  }

  function getLatest(limit) {
    const result = [];
    for (let i = buffer.length - 1; i >= 0 && result.length < limit; i--) {
      result.push(buffer[i]);
    }
    return result;
  }

  function getById(id) {
    return byId.get(id) || null;
  }

  function getStats() {
    const completed = successfulRequests + errorRequests;
    const avgLatency = completed > 0 ? totalLatencyMs / completed : 0;
    const recentAvg = recentLatencies.length > 0
      ? recentLatencies.reduce((a, b) => a + b, 0) / recentLatencies.length
      : 0;
    const errorRate = completed > 0 ? errorRequests / completed : 0;

    return {
      totalRequests,
      successfulRequests,
      errorRequests,
      pendingRequests: Math.max(0, totalRequests - completed),
      totalTokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        total: totalInputTokens + totalOutputTokens,
      },
      requestsByModel: Object.fromEntries(requestsByModel),
      requestsByRoute: Object.fromEntries(requestsByRoute),
      averageLatencyMs: Math.round(avgLatency),
      recentLatencyMs: Math.round(recentAvg),
      errorRate: Math.round(errorRate * 10000) / 10000,
      uptimeMs: Date.now() - startTime,
      bufferSize: buffer.length,
      maxBufferSize: max,
    };
  }

  function clear() {
    buffer.length = 0;
    byId.clear();
    bufferedIds.clear();
    totalRequests = 0;
    successfulRequests = 0;
    errorRequests = 0;
    totalInputTokens = 0;
    totalOutputTokens = 0;
    requestsByModel.clear();
    requestsByRoute.clear();
    totalLatencyMs = 0;
    recentLatencies.length = 0;
    startTime = Date.now();
  }

  function resize(newSize) {
    max = Math.max(1, newSize);
    while (buffer.length > max) {
      const evicted = buffer.shift();
      bufferedIds.delete(evicted.id);
      if (completedRecords.has(evicted)) byId.delete(evicted.id);
    }
  }

  return { add, complete, getAll, getLatest, getById, getStats, clear, resize, get maxSize() { return max; }, get size() { return buffer.length; } };
}

module.exports = { createStore };
