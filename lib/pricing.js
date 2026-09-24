// Model pricing table (USD per 1M tokens) and cost estimation.
// Model names are matched by longest key contained in the reported model id,
// so dated and provider-prefixed ids resolve to the same entry.
const MODEL_PRICING = {
  'claude-opus-4-8':   { input: 15.00, output: 75.00 },
  'claude-opus-4-1':   { input: 15.00, output: 75.00 },
  'claude-opus-4':     { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-sonnet-4':   { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':  { input: 0.80,  output: 4.00 },
  'claude-haiku-4':    { input: 0.80,  output: 4.00 },
  'claude-fable-5':    { input: 3.00,  output: 15.00 },
  'claude-3.5-sonnet': { input: 3.00,  output: 15.00 },
  'claude-3.5-haiku':  { input: 0.80,  output: 4.00 },
  'claude-3-opus':     { input: 15.00, output: 75.00 },
  'gpt-5':             { input: 1.25,  output: 10.00 },
  'gpt-5-mini':        { input: 0.15,  output: 0.60 },
  'gpt-5-nano':        { input: 0.075, output: 0.30 },
  'gpt-4.1':           { input: 2.00,  output: 8.00 },
  'gpt-4.1-mini':      { input: 0.40,  output: 1.60 },
  'gpt-4.1-nano':      { input: 0.10,  output: 0.40 },
  'gpt-4o':            { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':       { input: 0.15,  output: 0.60 },
  'o4-mini':           { input: 1.10,  output: 4.40 },
  'o3':                { input: 10.00, output: 40.00 },
  'gemini-2.5-pro':    { input: 1.25,  output: 10.00 },
  'gemini-2.5-flash':  { input: 0.15,  output: 0.60 },
};

const KEYS_BY_LENGTH = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);

function findPricing(model) {
  if (!model || typeof model !== 'string') return null;
  const name = model.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MODEL_PRICING, name)) return MODEL_PRICING[name];
  for (const key of KEYS_BY_LENGTH) {
    if (name.includes(key)) return MODEL_PRICING[key];
  }
  return null;
}

function estimateCost(model, tokenUsage) {
  if (!tokenUsage) return null;
  const pricing = findPricing(model);
  if (!pricing) return null;
  const input = tokenUsage.input_tokens || 0;
  const output = tokenUsage.output_tokens || 0;
  if (!input && !output) return null;
  const cost = (input / 1e6) * pricing.input + (output / 1e6) * pricing.output;
  // Keep stored costs readable: raw float math yields values like 0.010499999999999999.
  return Number(cost.toFixed(10));
}

module.exports = { findPricing, estimateCost, MODEL_PRICING };
