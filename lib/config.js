// Unified config loader/saver
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3000,
  apiBase: 'https://api.openai.com',
  apiKey: '',
  proxyAccessToken: '',
  allowRemoteAccess: false,
  organization: '',
  project: '',
  logFile: 'proxy.log',
  maxLogFileBytes: 50 * 1024 * 1024,
  timeoutMs: 300000,
  bodyLimit: '10mb',
  ringBufferSize: 500,
  maxCaptureBytes: 1024 * 1024,
  enableFileLogging: true,
};

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS));

function getConfigPath() {
  // Support config.openai.json as fallback for backward compatibility.
  const openaiConfigPath = path.join(PROJECT_ROOT, 'config.openai.json');
  if (fs.existsSync(openaiConfigPath)) return openaiConfigPath;
  return CONFIG_PATH;
}

function assertInteger(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
}

function assertString(name, value, maxLength = 4096) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`${name} must be a string no longer than ${maxLength} characters`);
  }
}

function normalizeConfig(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config must be a JSON object');
  }

  const normalized = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'upstream') continue;
    if (!CONFIG_KEYS.has(key)) {
      if (partial) throw new Error(`unknown config field: ${key}`);
      continue;
    }
    normalized[key] = value;
  }

  if (input.upstream && input.apiBase === undefined) {
    normalized.apiBase = input.upstream;
  }

  const candidate = partial ? normalized : { ...DEFAULTS, ...normalized };

  if ('host' in candidate) {
    assertString('host', candidate.host, 255);
    if (!candidate.host.trim()) throw new Error('host must not be empty');
    candidate.host = candidate.host.trim();
  }
  if ('port' in candidate) assertInteger('port', candidate.port, 1, 65535);
  if ('apiBase' in candidate) {
    assertString('apiBase', candidate.apiBase);
    let parsed;
    try {
      parsed = new URL(candidate.apiBase);
    } catch {
      throw new Error('apiBase must be a valid URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('apiBase must use http or https');
    }
    if (parsed.username || parsed.password) {
      throw new Error('apiBase must not contain credentials');
    }
    candidate.apiBase = candidate.apiBase.replace(/\/+$/, '');
  }

  for (const name of ['apiKey', 'proxyAccessToken', 'organization', 'project']) {
    if (name in candidate) assertString(name, candidate[name]);
  }
  for (const name of ['allowRemoteAccess', 'enableFileLogging']) {
    if (name in candidate && typeof candidate[name] !== 'boolean') {
      throw new Error(`${name} must be a boolean`);
    }
  }

  if ('timeoutMs' in candidate) assertInteger('timeoutMs', candidate.timeoutMs, 1000, 3600000);
  if ('ringBufferSize' in candidate) assertInteger('ringBufferSize', candidate.ringBufferSize, 1, 5000);
  if ('maxCaptureBytes' in candidate) assertInteger('maxCaptureBytes', candidate.maxCaptureBytes, 16384, 10 * 1024 * 1024);
  if ('maxLogFileBytes' in candidate) assertInteger('maxLogFileBytes', candidate.maxLogFileBytes, 1024 * 1024, 1024 * 1024 * 1024);

  if ('bodyLimit' in candidate) {
    assertString('bodyLimit', candidate.bodyLimit, 32);
    if (!/^\d+(?:b|kb|mb|gb)$/i.test(candidate.bodyLimit)) {
      throw new Error('bodyLimit must look like 10mb or 512kb');
    }
  }

  if ('logFile' in candidate) {
    assertString('logFile', candidate.logFile, 1024);
    const resolved = path.resolve(PROJECT_ROOT, candidate.logFile);
    const relative = path.relative(PROJECT_ROOT, resolved);
    if (!candidate.logFile || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('logFile must stay inside the project directory');
    }
    candidate.logFile = relative;
  }

  if (!partial && !isLoopbackHost(candidate.host) && (!candidate.allowRemoteAccess || !candidate.proxyAccessToken)) {
    throw new Error('remote host requires allowRemoteAccess=true and a non-empty proxyAccessToken');
  }

  return candidate;
}

function loadConfig() {
  const configPath = getConfigPath();
  let fileConfig = {};

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to load config file ${configPath}: ${err.message}`);
    }
  }

  return normalizeConfig(fileConfig);
}

function saveConfig(partial) {
  const configPath = getConfigPath();
  const changes = normalizeConfig(partial, { partial: true });
  let current = {};

  if (fs.existsSync(configPath)) {
    current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  delete current.upstream;
  const updated = normalizeConfig({ ...current, ...changes });
  const tempPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(updated, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, configPath);
  return updated;
}

function maskApiKey(config) {
  const safe = { ...config };
  safe.hasApiKey = Boolean(safe.apiKey);
  safe.hasProxyAccessToken = Boolean(safe.proxyAccessToken);
  safe.apiKey = '';
  delete safe.proxyAccessToken;
  return safe;
}

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase());
}

module.exports = {
  loadConfig,
  saveConfig,
  getConfigPath,
  normalizeConfig,
  isLoopbackHost,
  DEFAULTS,
  maskApiKey,
};
