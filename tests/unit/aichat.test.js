import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-aichat-' + counter + '-' + process.pid);
}

async function signup(base, email) {
  const r = await fetch(base + '/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  expect(r.status).toBe(200);
  return (await r.json()).token;
}

// Injectable LLM stub — no real provider/key/round-trip.
const stubStream = async function* (prompt) {
  yield 'Hello, ';
  yield 'you said: ';
  yield prompt;
};

describe('managed AI chat proxy', () => {
  it('authed /ai/chat streams the (stubbed) reply', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir(), streamChat: stubStream });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const token = await signup(base, 'ai@b.com');
      const r = await fetch(base + '/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ prompt: 'hi' }),
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('Hello, you said: hi');

      const cfg = await (await fetch(base + '/ai/config')).json();
      expect(cfg).toEqual({ available: true });
    } finally {
      await s.close();
    }
  }, 20000);

  it('unauthed -> 401; unconfigured -> 501', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir(), streamChat: stubStream });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      // no token -> requireAuth rejects before the handler runs
      const noAuth = await fetch(base + '/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      });
      expect(noAuth.status).toBe(401);
    } finally {
      await s.close();
    }

    // SECOND server: no streamChat, no provider/key -> unconfigured
    const s2 = await startServer({ port: 0, dataDir: tmpDir() });
    const base2 = 'http://127.0.0.1:' + s2.port;
    try {
      const token = await signup(base2, 'unconfigured@b.com');
      const r = await fetch(base2 + '/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ prompt: 'hi' }),
      });
      expect(r.status).toBe(501);

      const cfg = await (await fetch(base2 + '/ai/config')).json();
      expect(cfg).toEqual({ available: false });
    } finally {
      await s2.close();
    }
  }, 20000);

  it('client-provided key is forwarded to streamChat (wins over managed)', async () => {
    let seen = null;
    const s = await startServer({
      port: 0, dataDir: tmpDir(),
      streamChat: async function* (prompt, creds) { seen = creds; yield 'ok'; },
    });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const token = await signup(base, 'client@b.com');
      const r = await fetch(base + '/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ prompt: 'hi', provider: 'zai', key: 'sk-client', model: 'glm-5.2' }),
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('ok');
      expect(seen).toEqual({ images: [], provider: 'zai', key: 'sk-client', model: 'glm-5.2', thinking: null });
    } finally {
      await s.close();
    }
  }, 20000);
});
