// AI API Proxy — unified entry point
// Serves all proxy routes + Web Dashboard + WebSocket real-time updates
const { loadConfig } = require('./lib/config');
const { createApp } = require('./lib/app');

const config = loadConfig();
const { server, routes, close } = createApp(config);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use.`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const INNER = 54;
  const row = text => `║${text.padEnd(INNER)}║`;
  const rule = (left, right) => `${left}${'═'.repeat(INNER)}${right}`;

  console.log('');
  console.log(rule('╔', '╗'));
  console.log(row('           AI API Proxy — Dashboard Ready'));
  console.log(rule('╠', '╣'));
  console.log(row(`  Dashboard : http://${config.host}:${config.port}`));
  console.log(row(`  Upstream  : ${config.apiBase || 'not set'}`));
  console.log(rule('╠', '╣'));
  for (const rc of routes) {
    console.log(row(`  POST ${rc.route}`));
  }
  console.log(rule('╚', '╝'));
  console.log('');
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  close().then(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
