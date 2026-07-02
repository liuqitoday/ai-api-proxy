// Unified config loader/saver
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  port: 3000,
  apiBase: 'https://api.openai.com',
  apiKey: '',
  organization: '',
  project: '',
  logFile: 'proxy.log',
  timeoutMs: 300000,
  bodyLimit: '10mb',
  ringBufferSize: 500,
  enableFileLogging: true,
};

function getConfigPath() {
  // Support config.openai.json as fallback for backward compatibility
  const openaiConfigPath = path.join(__dirname, '..', 'config.openai.json');
  if (fs.existsSync(openaiConfigPath)) {
    return openaiConfigPath;
  }
  return CONFIG_PATH;
}

function loadConfig() {
  const configPath = getConfigPath();
  let fileConfig = {};

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      console.error(`Failed to parse config file: ${configPath}, using defaults`);
    }
  }

  // Merge with defaults, file values take precedence
  const config = { ...DEFAULTS, ...fileConfig };

  // Support 'upstream' as alias for 'apiBase' — if file provides 'upstream' but no 'apiBase',
  // the upstream value should override the default apiBase
  if (fileConfig.upstream && !fileConfig.apiBase) {
    config.apiBase = fileConfig.upstream;
  }

  return config;
}

function saveConfig(partial) {
  const configPath = getConfigPath();

  // Read current file config
  let current = {};
  if (fs.existsSync(configPath)) {
    try {
      current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // If file is corrupted, start fresh
    }
  }

  // Merge partial update
  const updated = { ...current, ...partial };

  // Normalize: if upstream is provided but not apiBase, use it
  if (updated.upstream && !updated.apiBase) {
    updated.apiBase = updated.upstream;
  }
  // Remove deprecated 'upstream' key if apiBase is present
  if (updated.apiBase) {
    delete updated.upstream;
  }

  // Write back
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');

  // Return full config with defaults applied
  const result = { ...DEFAULTS, ...updated };
  // Ensure apiBase from upstream fallback is reflected
  if (result.upstream && !result.apiBase) {
    result.apiBase = result.upstream;
  }
  delete result.upstream;
  return result;
}

function maskApiKey(config) {
  const safe = { ...config };
  if (safe.apiKey && safe.apiKey.length > 8) {
    safe.apiKey = safe.apiKey.slice(0, 8) + '...';
  }
  return safe;
}

module.exports = { loadConfig, saveConfig, getConfigPath, DEFAULTS, maskApiKey };
