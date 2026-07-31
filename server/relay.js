const { WebSocketServer } = require('ws');

async function startRelay(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = (opts.port != null) ? opts.port : (Number(process.env.RELAY_PORT) || 1234);
  const { setupWSConnection } = await import('@y/websocket-server/utils');
  const wss = new WebSocketServer({ host, port });
  wss.on('connection', (conn, req) => setupWSConnection(conn, req));
  await new Promise((res) => wss.on('listening', res));           // wait until actually listening
  const realPort = wss.address().port;                            // real port (handles port:0 ephemeral)
  const close = () => new Promise((res) => {
    for (const c of wss.clients) { try { c.terminate(); } catch (_) {} }
    wss.close(res);
  });
  return { wss, port: realPort, host, close };
}

module.exports = { startRelay };

if (require.main === module) {
  startRelay().then(({ host, port }) => console.log('[relay] listening on ws://' + host + ':' + port))
              .catch((e) => { console.error('[relay] failed:', e); process.exit(1); });
}
