// ---- CRDT foundation (Yjs wrapper) ------------------------------------------
// Pure, deterministic wrappers around Yjs. One note = one Y.Doc whose text
// content lives under the fixed key 'content'. No I/O, no network, no timers.
// Mutating fns (insert/del/applyUpdate) mutate the passed doc in place, which
// is inherent to Yjs; everything else is side-effect-free.
const Y = require('yjs');

const KEY = 'content';

// new Y.Doc whose Y.Text('content') holds initialText ('' by default).
function newDoc(initialText){
  const doc = new Y.Doc();
  const text = doc.getText(KEY);
  const s = typeof initialText === 'string' ? initialText : '';
  if (s) text.insert(0, s);
  return doc;
}

// Current content string. Coerce null/invalid doc -> ''.
function getText(doc){
  if (!doc || typeof doc.getText !== 'function') return '';
  try { return doc.getText(KEY).toString(); } catch (e) { return ''; }
}

// Insert str at index (clamped into [0, len]). Mutates doc.
function insert(doc, index, str){
  if (!doc || typeof str !== 'string' || !str) return;
  const text = doc.getText(KEY);
  const i = Math.max(0, Math.min(index, text.length));
  text.insert(i, str);
}

// Delete `length` chars at index, clamped to what's available. Mutates doc.
function del(doc, index, length){
  if (!doc) return;
  const text = doc.getText(KEY);
  const len = text.length;
  if (!len) return;
  const i = Math.max(0, Math.min(index, len));
  const n = Math.max(0, Math.min(length, len - i));
  if (n > 0) text.delete(i, n);
}

// Full persistable state (idempotent, order-independent, mergeable).
function encodeState(doc){
  return Y.encodeStateAsUpdate(doc);
}

// NEW doc loaded from a persisted blob. null/empty -> empty newDoc.
function fromUpdate(update){
  if (!update || update.length === 0) return newDoc('');
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

// Merge an incoming blob into an existing doc. No-op on null/empty.
function applyUpdate(doc, update){
  if (!doc || !update || update.length === 0) return;
  Y.applyUpdate(doc, update);
}

// What this doc already has; used to request a minimal delta.
function stateVector(doc){
  return Y.encodeStateVector(doc);
}

// Minimal delta a peer needs given what they already have. null SV -> full state.
function diffUpdate(doc, sinceStateVector){
  return Y.encodeStateAsUpdate(doc, sinceStateVector || undefined);
}

module.exports = {
  newDoc,
  getText,
  insert,
  del,
  encodeState,
  fromUpdate,
  applyUpdate,
  stateVector,
  diffUpdate,
};
