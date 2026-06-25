const http = require('http');

const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 8084;
const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = 3456;
const PROXY_TOKEN = process.env.UMANS_PROXY_TOKEN || 'umans-proxy';

function forward(req, res) {
  const headers = { ...req.headers };
  headers.host = `${TARGET_HOST}:${TARGET_PORT}`;
  headers.authorization = `Bearer ${PROXY_TOKEN}`;
  delete headers['x-api-key'];

  const upstream = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers,
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on('error', err => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'proxy_error', message: err.message },
    }));
  });

  req.pipe(upstream);
}

http.createServer(forward).listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`UMANS compatibility forwarder on http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT}`);
});
