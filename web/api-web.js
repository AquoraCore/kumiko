// Phase 7d-1: web window.api shim — storage half.
// Drop-in replacement for the Electron window.api that talks to the cloud
// backend (server/index.js /notes + /auth) over HTTP instead of Electron IPC.
// Dual-mode: Node require + browser global. No browser build yet (that's 7d-2).

function createWebApi(opts) {
  opts = opts || {};
  let baseUrl = opts.baseUrl || 'http://127.0.0.1:4321';
  if (baseUrl.length > 0 && baseUrl[baseUrl.length - 1] === '/') baseUrl = baseUrl.slice(0, -1);
  const getToken = opts.getToken || (() => null);

  function authHeaders(extra) {
    const token = getToken();
    return Object.assign(
      { 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {},
      extra || {}
    );
  }

  // Never throws — network failure resolves to null so each caller can pick
  // its own safe fallback (renderer expects resolved values, not rejections).
  async function req(method, pathAndQuery, body) {
    try {
      return await fetch(baseUrl + pathAndQuery, {
        method,
        headers: authHeaders(),
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch (_) {
      return null;
    }
  }

  async function listNotes() {
    try {
      const res = await req('GET', '/notes');
      if (!res || !res.ok) return { notes: [], folders: [], pdfs: [] };
      const data = await res.json();
      // folders/pdfs empty — web MVP is notes-only; keep the shape the renderer expects.
      return { notes: (data && data.notes) || [], folders: [], pdfs: [] };
    } catch (_) {
      return { notes: [], folders: [], pdfs: [] };
    }
  }

  async function readNote(name) {
    try {
      const res = await req('GET', '/notes/content?name=' + encodeURIComponent(name));
      if (!res || !res.ok) return '';
      const data = await res.json();
      return (data && data.content != null) ? data.content : '';
    } catch (_) {
      return '';
    }
  }

  // ponytail: openNote returns the content string; the Electron version returns
  // a richer object. The web renderer integration (7d-2) can enrich this later —
  // a plain string is enough for the MVP note editor to render.
  async function openNote(name) {
    return readNote(name);
  }

  async function saveNote(name, content) {
    try {
      const res = await req('PUT', '/notes', { name, content: String(content == null ? '' : content) });
      if (!res || !res.ok) return { ok: false };
      const data = await res.json();
      return { ok: !!(data && data.ok) };
    } catch (_) {
      return { ok: false };
    }
  }

  async function createNote(name) {
    try {
      const res = await req('PUT', '/notes', { name, content: '' });
      if (!res || !res.ok) return { ok: false };
      const data = await res.json();
      return { ok: !!(data && data.ok) };
    } catch (_) {
      return { ok: false };
    }
  }

  async function deleteNote(name) {
    try {
      const res = await req('DELETE', '/notes?name=' + encodeURIComponent(name));
      if (!res || !res.ok) return { ok: false };
      const data = await res.json();
      return { ok: !!(data && data.ok) };
    } catch (_) {
      return { ok: false };
    }
  }

  // ponytail: no backend rename endpoint; compose read+write+delete.
  // Add a server /notes/rename when atomicity matters — a crash between the
  // write and the delete currently orphans the old file under the old name.
  async function renameNote(from, to) {
    const c = await readNote(from);
    const w = await saveNote(to, c);
    if (!w || !w.ok) return { ok: false };
    await deleteNote(from);
    return { ok: true };
  }

  return { listNotes, openNote, readNote, saveNote, createNote, renameNote, deleteNote };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createWebApi };
if (typeof window !== 'undefined') window.createWebApi = createWebApi;
