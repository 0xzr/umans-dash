const assert = require('assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function waitForHealth(port, child, getLogs) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`proxy exited early: ${child.exitCode}\n${getLogs()}`);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { 'Authorization': 'Bearer proxy-key' },
      });
      if (resp.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`proxy did not become healthy\n${getLogs()}`);
}

(async () => {
  const seen = { messages: null };
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        'umans-glm-5.2': {
          display_name: 'Umans GLM 5.2',
          capabilities: {
            context_window: 405504,
            recommended_max_tokens: 131072,
            supports_tools: true,
            supports_vision: 'via-handoff',
            reasoning: { supported: true, can_disable: true, levels: ['low', 'medium', 'high', 'max'] },
          },
        },
        'umans-kimi-k2.7': {
          display_name: 'Umans Kimi K2.7',
          capabilities: {
            context_window: 262144,
            recommended_max_tokens: 32768,
            supports_tools: true,
            supports_vision: true,
            reasoning: { supported: true, can_disable: true, levels: ['low', 'medium', 'high'] },
          },
        },
        'umans-flash': {
          display_name: 'Umans Flash',
          capabilities: { context_window: 65536, recommended_max_tokens: 8192, supports_tools: true, supports_vision: false },
        },
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/usage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ usage: { concurrent_sessions: 0 }, limits: { concurrency: { limit: 10 } } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/messages') {
      const body = await readJson(req);
      seen.messages = { headers: req.headers, body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  const upstreamPort = await listen(upstream);
  const proxyServer = http.createServer();
  const proxyPort = await listen(proxyServer);
  await new Promise(resolve => proxyServer.close(resolve));

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'umans-dash-test-home-'));
  const settingsDir = path.join(tmpHome, 'gt-claude');
  const child = spawn(process.execPath, ['proxy.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      HOME: tmpHome,
      LISTEN_ADDR: `127.0.0.1:${proxyPort}`,
      UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      UMANS_API_KEY: 'upstream-key',
      API_KEYS: 'proxy-key',
      CLAUDE_CODE_SETTINGS_ENABLED: 'true',
      CLAUDE_CODE_SETTINGS_DIR: settingsDir,
      CACHE_ENABLED: 'false',
      SLEEV_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', c => { stdout += c.toString(); });
  child.stderr.on('data', c => { stderr += c.toString(); });

  try {
    await waitForHealth(proxyPort, child, () => `stdout:\n${stdout}\nstderr:\n${stderr}`);

    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer proxy-key',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'glm52',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    if (resp.status !== 200) {
      throw new Error(await resp.text());
    }
    const data = await resp.json();
    assert.strictEqual(data.model, 'umans-glm-5.2');
    assert.ok(seen.messages, 'mock upstream did not receive /v1/messages');
    assert.strictEqual(seen.messages.body.model, 'umans-glm-5.2');
    assert.strictEqual(seen.messages.headers['x-api-key'], 'upstream-key');
    assert.strictEqual(seen.messages.headers['anthropic-version'], '2023-06-01');

    const modelsResp = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      headers: { 'Authorization': 'Bearer proxy-key' },
    });
    if (modelsResp.status !== 200) {
      throw new Error(await modelsResp.text());
    }
    const models = await modelsResp.json();
    const ids = models.data.map(m => m.id);
    assert.ok(ids.includes('glm52'), 'glm52 alias missing from /v1/models');
    assert.ok(ids.includes('kimi27'), 'kimi27 alias missing from /v1/models');

    const setupResp = await fetch(`http://127.0.0.1:${proxyPort}/api/claude-code/setup`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer proxy-key' },
    });
    if (setupResp.status !== 200) {
      throw new Error(await setupResp.text());
    }
    const glmSettings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'glm52.settings.json'), 'utf8'));
    const gtGlmSettings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'umans-glm.settings.json'), 'utf8'));
    assert.strictEqual(glmSettings.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${proxyPort}`);
    assert.strictEqual(glmSettings.env.ANTHROPIC_AUTH_TOKEN, 'proxy-key');
    assert.strictEqual(glmSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm52');
    assert.strictEqual(glmSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'kimi27');
    assert.strictEqual(gtGlmSettings.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${proxyPort}`);
    assert.strictEqual(gtGlmSettings.env.ANTHROPIC_AUTH_TOKEN, 'proxy-key');
  } finally {
    child.kill('SIGTERM');
    upstream.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  if (child.exitCode && child.exitCode !== 0) {
    throw new Error(`proxy exited ${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  console.log('anthropic compatibility test passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
