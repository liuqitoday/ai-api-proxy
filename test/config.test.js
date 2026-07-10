const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig, maskApiKey } = require('../lib/config');

test('config defaults to a loopback-only listener', () => {
  const config = normalizeConfig({ apiBase: 'https://example.com/' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.apiBase, 'https://example.com');
  assert.equal(config.allowRemoteAccess, false);
});

test('partial config rejects unknown and unsafe values', () => {
  assert.throws(() => normalizeConfig({ surprise: true }, { partial: true }), /unknown config field/);
  assert.throws(() => normalizeConfig({ apiBase: 'file:///etc/passwd' }, { partial: true }), /http or https/);
  assert.throws(() => normalizeConfig({ logFile: '../outside.log' }, { partial: true }), /project directory/);
  assert.throws(() => normalizeConfig({ ringBufferSize: '500' }, { partial: true }), /integer/);
  assert.throws(() => normalizeConfig({ host: '0.0.0.0' }), /remote host requires/);
});

test('public config never returns secret material', () => {
  const safe = maskApiKey({ apiKey: 'sk-secret-value', proxyAccessToken: 'proxy-secret' });
  assert.equal(safe.apiKey, '');
  assert.equal(safe.hasApiKey, true);
  assert.equal(safe.hasProxyAccessToken, true);
  assert.equal('proxyAccessToken' in safe, false);
  assert.doesNotMatch(JSON.stringify(safe), /secret/);
});
