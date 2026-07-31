import { describe, it, expect } from 'vitest';
const { startRelay } = require('../../server/relay');
const Y = require('yjs');
const WS = require('ws');
const { WebsocketProvider } = require('y-websocket');

function client(url, room) {
  const doc = new Y.Doc();
  const prov = new WebsocketProvider(url, room, doc, { WebSocketPolyfill: WS });
  return { doc, prov };
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

describe('yjs relay', () => {
  it('two clients in the same room converge over the relay', async () => {
    const relay = await startRelay({ port: 0 });
    const url = 'ws://127.0.0.1:' + relay.port;
    const A = client(url, 'room1');
    const B = client(url, 'room1');
    try {
      await waitUntil(() => A.prov.wsconnected && B.prov.wsconnected);
      A.doc.getText('content').insert(0, 'hello from A');
      await waitUntil(() => B.doc.getText('content').toString() === 'hello from A');
      expect(B.doc.getText('content').toString()).toBe('hello from A');
      B.doc.getText('content').insert(B.doc.getText('content').length, ' + B');   // bidirectional
      await waitUntil(() => A.doc.getText('content').toString() === 'hello from A + B');
      expect(A.doc.getText('content').toString()).toBe('hello from A + B');
    } finally {
      A.prov.destroy();
      B.prov.destroy();
      await relay.close();
    }
  }, 20000);

  it('clients in different rooms are isolated', async () => {
    const relay = await startRelay({ port: 0 });
    const url = 'ws://127.0.0.1:' + relay.port;
    const A = client(url, 'r1');
    const B = client(url, 'r2');
    try {
      await waitUntil(() => A.prov.wsconnected && B.prov.wsconnected);
      A.doc.getText('content').insert(0, 'only in r1');
      await new Promise(r => setTimeout(r, 1000));                    // give it time to (not) propagate
      expect(B.doc.getText('content').toString()).toBe('');           // isolation: r2 sees nothing
    } finally {
      A.prov.destroy();
      B.prov.destroy();
      await relay.close();
    }
  }, 20000);
});
