const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__WASHI_TEST_COLLAB', !!process.env.WASHI_TEST_COLLAB);
// App semver for the desktop build (web gets it injected by the server as __APP_VERSION__).
try { contextBridge.exposeInMainWorld('KUMIKO_VERSION', require('./package.json').version || ''); } catch (_) {}
// relay URL override (test / future setting); empty string = use the renderer's default
const collabRelay = process.env.WASHI_COLLAB_RELAY || '';

contextBridge.exposeInMainWorld('api', {
  listNotes: () => ipcRenderer.invoke('note:list'),
  openNote: (name) => ipcRenderer.invoke('note:open', name),
  readNote: (name) => ipcRenderer.invoke('note:read', name),
  importPdf: () => ipcRenderer.invoke('pdf:import'),
  readPdf: (name) => ipcRenderer.invoke('pdf:read', name),
  renamePdf: (from, to) => ipcRenderer.invoke('pdf:rename', { from, to }),
  readAnnots: (name) => ipcRenderer.invoke('pdf:readAnnots', name),
  saveAnnots: (name, data) => ipcRenderer.invoke('pdf:saveAnnots', { name, data }),
  saveNote: (name, content) => ipcRenderer.invoke('note:save', { name, content }),
  onNoteChanged: (cb) => ipcRenderer.on('note:changed', (_e, d) => cb(d)),
  createNote: (name) => ipcRenderer.invoke('note:create', name),
  renameNote: (from, to) => ipcRenderer.invoke('note:rename', { from, to }),
  deleteNote: (name) => ipcRenderer.invoke('note:delete', name),
  searchNotes: (q) => ipcRenderer.invoke('note:search', q),
  backlinks: (name) => ipcRenderer.invoke('note:backlinks', name),
  crdtLoad: (name) => ipcRenderer.invoke('crdt:load', { name }),
  crdtSave: (name, data) => ipcRenderer.invoke('crdt:save', { name, data }),
  noteTable: () => ipcRenderer.invoke('note:table'),
  graphData: () => ipcRenderer.invoke('graph:data'),

  dbList: () => ipcRenderer.invoke('db:list'),
  dbRead: (id) => ipcRenderer.invoke('db:read', id),
  dbSave: (db) => ipcRenderer.invoke('db:save', db),
  dbCreate: (payload) => ipcRenderer.invoke('db:create', payload),
  dbDelete: (id) => ipcRenderer.invoke('db:delete', id),
  folderCreate: (name) => ipcRenderer.invoke('folder:create', name),
  folderRename: (from, to) => ipcRenderer.invoke('folder:rename', { from, to }),
  folderDelete: (name) => ipcRenderer.invoke('folder:delete', name),

  trashList: () => ipcRenderer.invoke('trash:list'),
  trashRestore: (id) => ipcRenderer.invoke('trash:restore', id),
  trashDeleteForever: (id) => ipcRenderer.invoke('trash:deleteForever', id),
  trashEmpty: () => ipcRenderer.invoke('trash:empty'),

  runEngine: (payload) => ipcRenderer.invoke('engine:run', payload),
  stopEngine: (runId) => ipcRenderer.invoke('engine:stop', { runId }),
  onEngineOutput: (cb) => ipcRenderer.on('engine:output', (_e, d) => cb(d)),
  onEngineDone: (cb) => ipcRenderer.on('engine:done', (_e, d) => cb(d)),

  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  vaultList: () => ipcRenderer.invoke('vault:list'),
  vaultSwitch: (path) => ipcRenderer.invoke('vault:switch', { path }),
  vaultOpen: () => ipcRenderer.invoke('vault:open'),
  vaultCreate: () => ipcRenderer.invoke('vault:create'),
  vaultConfigRead: (key) => ipcRenderer.invoke('vault:configRead', { key }),
  vaultConfigWrite: (key, data) => ipcRenderer.invoke('vault:configWrite', { key, data }),
  vaultStateReadSync: () => ipcRenderer.sendSync('vault:stateReadSync'),

  aiGetConfig: () => ipcRenderer.invoke('ai:getConfig'),
  aiSetConfig: (patch) => ipcRenderer.invoke('ai:setConfig', patch),
  aiSetKey: (provider, key) => ipcRenderer.invoke('ai:setKey', { provider, key }),
  aiTestConnection: () => ipcRenderer.invoke('ai:testConnection'),
  ragContext: (question) => ipcRenderer.invoke('rag:context', { question }),

  collabRelay,   // phase 6c-3a: point the collab editor at a specific y-websocket relay

  authSetToken: (token, email) => ipcRenderer.invoke('auth:setToken', { token, email }),   // phase 7b-4: encrypted collab auth token
  authGetToken: () => ipcRenderer.invoke('auth:getToken'),
  authClear: () => ipcRenderer.invoke('auth:clear'),
});
