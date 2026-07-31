import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const Y = require('yjs');
const WS = require('ws');
const { WebsocketProvider } = require('y-websocket');
const os = require('os');
const path = require('path');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-persist-' + counter + '-' + process.pid);
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

// signup+login against the running server to get a token (signup returns token on first run;
// after a restart the user already exists -> 409, so login instead).
async function getToken(base, email, password) {
  let r = await post(base, '/auth/signup', { email, password });
  if (r.status === 200) {
    const body = await r.json();
    return body.token;
  }
  r = await post(base, '/auth/login', { email, password });
  const body = await r.json();
  return body.token;
}

describe('durable relay persistence', () => {
  it('a room\'s content survives a server restart', async () => {
    const dataDir = tmpDir();   // same dataDir across both server lifetimes
    const email = 'p@t.com';
    const password = 'password123';

    // --- lifetime 1: write content ---
    const s1 = await startServer({ port: 0, dataDir });
    const base1 = 'http://127.0.0.1:' + s1.port;
    const wsBase1 = 'ws://127.0.0.1:' + s1.port;
    try {
      const token1 = await getToken(base1, email, password);
      const docA = new Y.Doc();
      const provA = new WebsocketProvider(wsBase1, 'r1', docA, { params: { token: token1 }, WebSocketPolyfill: WS, disableBc: true });
      try {
        await waitUntil(() => provA.wsconnected);
        docA.getText('t').insert(0, 'durable text');
        await new Promise((res) => setTimeout(res, 600));   // wait past the 400ms debounce so disk write happens
      } finally {
        provA.destroy();
      }
    } finally {
      await s1.close();   // room now empty + server stopped
    }

    // --- lifetime 2: fresh server, SAME dataDir -> reloads persisted rooms ---
    const s2 = await startServer({ port: 0, dataDir });
    const base2 = 'http://127.0.0.1:' + s2.port;
    const wsBase2 = 'ws://127.0.0.1:' + s2.port;
    try {
      const token2 = await getToken(base2, email, password);
      const docB = new Y.Doc();
      const provB = new WebsocketProvider(wsBase2, 'r1', docB, { params: { token: token2 }, WebSocketPolyfill: WS, disableBc: true });
      try {
        await waitUntil(() => provB.wsconnected);
        await waitUntil(() => docB.getText('t').toString() === 'durable text');
        expect(docB.getText('t').toString()).toBe('durable text');
      } finally {
        provB.destroy();
      }
    } finally {
      await s2.close();
    }
  }, 30000);

  it('a fresh room with no saved file starts empty', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const wsBase = 'ws://127.0.0.1:' + s.port;
    try {
      const r = await post(base, '/auth/signup', { email: 'e@t.com', password: 'password123' });
      const token = (await r.json()).token;
      const docX = new Y.Doc();
      const provX = new WebsocketProvider(wsBase, 'empty1', docX, { params: { token }, WebSocketPolyfill: WS, disableBc: true });
      try {
        await waitUntil(() => provX.wsconnected);
        await new Promise((res) => setTimeout(res, 500));
        expect(docX.getText('t').toString()).toBe('');
      } finally {
        provX.destroy();
      }
    } finally {
      await s.close();
    }
  }, 20000);
});
