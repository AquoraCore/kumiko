const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');

const messageSync = 0;
const messageAwareness = 1;
const rooms = new Map();   // roomName -> Room

let persistDir = process.env.ROOMS_DIR || null;   // null => in-memory only (7a default)
function setPersistDir(dir) { persistDir = dir || null; }
function roomFile(name) { return path.join(persistDir, encodeURIComponent(name) + '.ydoc'); }  // safe filename for arbitrary room names

function sendRaw(conn, msg) { try { if (conn.readyState === 1) conn.send(msg); } catch (_) {} }

class Room {
  constructor(name) {
    this.name = name;
    this.doc = new Y.Doc();
    this.conns = new Map();   // ws -> Set<awarenessClientID>
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    if (persistDir) {
      try {
        const f = roomFile(name);
        if (fs.existsSync(f)) Y.applyUpdate(this.doc, new Uint8Array(fs.readFileSync(f)), 'persist');
      } catch (_) {}
    }
    this._saveT = null;
    this.doc.on('update', (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageSync);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      this.conns.forEach((_ids, conn) => { if (conn !== origin) sendRaw(conn, msg); });
      if (persistDir) {
        clearTimeout(this._saveT);
        this._saveT = setTimeout(() => {
          try {
            fs.mkdirSync(persistDir, { recursive: true });
            fs.writeFileSync(roomFile(this.name), Buffer.from(Y.encodeStateAsUpdate(this.doc)));
          } catch (_) {}
        }, 400);
      }
    });
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      if (origin && this.conns.has(origin)) {
        const ids = this.conns.get(origin);
        added.forEach((id) => ids.add(id));
        removed.forEach((id) => ids.delete(id));
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageAwareness);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      this.conns.forEach((_ids, conn) => sendRaw(conn, msg));
    });
  }
}

function getRoom(name) { let r = rooms.get(name); if (!r) { r = new Room(name); rooms.set(name, r); } return r; }

function onMessage(conn, room, data) {
  try {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(decoder);
    if (type === messageSync) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageSync);
      // applies incoming sync/update to room.doc with origin=conn (so it won't echo to sender),
      // and writes any reply (e.g. SyncStep2) back into enc.
      syncProtocol.readSyncMessage(decoder, enc, room.doc, conn);
      if (encoding.length(enc) > 1) sendRaw(conn, encoding.toUint8Array(enc));
    } else if (type === messageAwareness) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
    }
  } catch (_) { /* ignore malformed frames */ }
}

function setupConn(conn, req) {
  conn.binaryType = 'arraybuffer';
  const name = ((req && req.url) || '/').slice(1).split('?')[0] || 'default';
  const room = getRoom(name);
  room.conns.set(conn, new Set());
  conn.on('message', (data) => onMessage(conn, room, data));
  conn.on('close', () => {
    const ids = room.conns.get(conn);
    room.conns.delete(conn);
    if (ids && ids.size) awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(ids), null);
  });
  // initial handshake: SyncStep1 + current awareness
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeSyncStep1(enc, room.doc);
  sendRaw(conn, encoding.toUint8Array(enc));
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const enc2 = encoding.createEncoder();
    encoding.writeVarUint(enc2, messageAwareness);
    encoding.writeVarUint8Array(enc2, awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys())));
    sendRaw(conn, encoding.toUint8Array(enc2));
  }
}

async function startRelay(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = (opts.port != null) ? opts.port : (Number(process.env.RELAY_PORT) || 1234);
  const wss = new WebSocketServer({ host, port });
  wss.on('connection', (conn, req) => setupConn(conn, req));
  await new Promise((res) => wss.on('listening', res));
  const realPort = wss.address().port;
  const close = () => new Promise((res) => { for (const c of wss.clients) { try { c.terminate(); } catch (_) {} } wss.close(res); });
  return { wss, port: realPort, host, close };
}

module.exports = { startRelay, setupConn, setPersistDir };

if (require.main === module) {
  startRelay().then(({ host, port }) => console.log('[relay] listening on ws://' + host + ':' + port))
              .catch((e) => { console.error('[relay] failed:', e); process.exit(1); });
}
