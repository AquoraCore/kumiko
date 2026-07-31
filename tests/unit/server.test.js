import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const Y = require('yjs');
const WS = require('ws');
const { WebsocketProvider } = require('y-websocket');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-srv-' + counter + '-' + process.pid);
}

function waitUntil(fn, ms = 6000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (fn()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start >= ms) return reject(new Error('waitUntil timed out after ' + ms + 'ms'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function post(base, route, body) {
  return fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('auth server', () => {
  it('AUTH (happy + edge): signup, duplicate, login, /auth/me', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      // signup (happy)
      let r = await post(base, '/auth/signup', { email: 'a@b.com', password: 'password123' });
      expect(r.status).toBe(200);
      let body = await r.json();
      expect(typeof body.token).toBe('string');
      expect(body.email).toBe('a@b.com');

      // duplicate signup -> 409
      r = await post(base, '/auth/signup', { email: 'a@b.com', password: 'password123' });
      expect(r.status).toBe(409);

      // login wrong password -> 401
      r = await post(base, '/auth/login', { email: 'a@b.com', password: 'wrongpassword' });
      expect(r.status).toBe(401);

      // login correct -> 200 + token
      r = await post(base, '/auth/login', { email: 'a@b.com', password: 'password123' });
      expect(r.status).toBe(200);
      body = await r.json();
      expect(typeof body.token).toBe('string');
      const token = body.token;

      // /auth/me with valid token -> 200 + email
      r = await fetch(base + '/auth/me', { headers: { Authorization: 'Bearer ' + token } });
      expect(r.status).toBe(200);
      body = await r.json();
      expect(body.email).toBe('a@b.com');

      // /auth/me with bad token -> 401
      r = await fetch(base + '/auth/me', { headers: { Authorization: 'Bearer garbage.token.here' } });
      expect(r.status).toBe(401);
    } finally {
      await s.close();
    }
  }, 20000);

  it('RELAY GATING: authorized clients sync; an unauthorized client never joins the room', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const wsBase = 'ws://127.0.0.1:' + s.port;
    try {
      // get a valid token
      const r = await post(base, '/auth/signup', { email: 'sync@b.com', password: 'password123' });
      const body = await r.json();
      const token = body.token;

      // two authorized clients in room1
      const docA = new Y.Doc();
      // disableBc: same-room providers share a global BroadcastChannel in one node process,
      // bypassing the WS relay + auth gate. Force the WS path so the gate is actually exercised.
      const provA = new WebsocketProvider(wsBase, 'room1', docA, { params: { token }, WebSocketPolyfill: WS, disableBc: true });
      const docB = new Y.Doc();
      const provB = new WebsocketProvider(wsBase, 'room1', docB, { params: { token }, WebSocketPolyfill: WS, disableBc: true });

      await waitUntil(() => provA.wsconnected && provB.wsconnected);

      docA.getText('t').insert(0, 'authorized sync');
      await waitUntil(() => docB.getText('t').toString() === 'authorized sync');
      expect(docB.getText('t').toString()).toBe('authorized sync');

      // EDGE: an unauthorized client (garbage token) must NOT sync.
      const docBad = new Y.Doc();
      const provBad = new WebsocketProvider(wsBase, 'room1', docBad, { params: { token: 'garbage' }, WebSocketPolyfill: WS, disableBc: true });

      // edit a separate value via an authorized client and let authorized peers converge
      docA.getText('secret').insert(0, 'should-not-leak');
      await waitUntil(() => docB.getText('secret').toString() === 'should-not-leak');
      // give the rejected client time to (not) sync
      await new Promise((res) => setTimeout(res, 1500));
      expect(docBad.getText('t').toString()).toBe('');
      expect(docBad.getText('secret').toString()).toBe('');

      provA.destroy();
      provB.destroy();
      provBad.destroy();
    } finally {
      await s.close();
    }
  }, 30000);
});
