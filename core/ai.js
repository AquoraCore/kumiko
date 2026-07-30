// ---- AI engine invocation seam --------------------------------------------
// Pure, side-effect-free mapping: (engine, model, prompt) -> { cmd, args, stdin }.
// Captures EXACTLY how main.js spawns each engine today, so the spawn path can be
// unit-tested without touching child_process. Unknown engine -> null.
//   glm    = `opencode run -m <model>`, prompt on STDIN
//   claude = `claude -p <prompt> --permission-mode acceptEdits`, no STDIN
function buildEngineInvocation(engine, model, prompt){
  if (engine === 'glm') return { cmd: 'opencode', args: ['run', '-m', model], stdin: prompt };
  if (engine === 'claude') return { cmd: 'claude', args: ['-p', prompt, '--permission-mode', 'acceptEdits'], stdin: null };
  return null;
}

// ---- AI provider config: PURE, side-effect-free helpers ---------------------
// Safe view for the renderer — NEVER includes raw keys. Defaults fill missing
// fields so the renderer can rely on a stable shape regardless of file state.
function aiConfigView(cfg){
  const c = (cfg && typeof cfg === 'object') ? cfg : {};
  const mode = (typeof c.mode === 'string' && c.mode) ? c.mode : 'cli';
  const provider = (typeof c.provider === 'string' && c.provider) ? c.provider : 'anthropic';
  const model = (typeof c.model === 'string') ? c.model : '';
  const keys = (c.keys && typeof c.keys === 'object') ? c.keys : {};
  const has = (p) => !!(keys[p] && typeof keys[p] === 'string' && keys[p].length > 0);
  return { mode, provider, model, hasKey: { anthropic: has('anthropic'), zai: has('zai') } };
}

// Return a NEW config with keys[provider] set to `encrypted`, or DELETED when
// `encrypted` is null/''/undefined. Never mutates the input. Ignores unknown
// providers (returns cfg unchanged) so the surface stays {anthropic, zai}.
function setConfigKey(cfg, provider, encrypted){
  if (provider !== 'anthropic' && provider !== 'zai') return cfg;
  const c = (cfg && typeof cfg === 'object') ? cfg : {};
  const next = Object.assign({}, c, { keys: Object.assign({}, c.keys || {}) });
  if (encrypted === null || encrypted === undefined || encrypted === '') delete next.keys[provider];
  else next.keys[provider] = encrypted;
  return next;
}

// ---- API request builders: PURE, side-effect-free ---------------------------
// Maps (provider, model, prompt, key) -> { url, headers, body } for the HTTPS
// streaming call. `body` is a plain JS object; the caller JSON.stringifies.
// Unknown provider -> null (mirrors buildEngineInvocation). Kept pure so main.js
// stays free of network I/O and this is unit-testable in isolation.
function buildApiRequest(provider, model, prompt, key){
  if (provider === 'anthropic') return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: { model, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: prompt }] },
  };
  if (provider === 'zai') return {
    url: 'https://api.z.ai/api/paas/v4/chat/completions',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
    body: { model, stream: true, messages: [{ role: 'user', content: prompt }] },
  };
  return null;
}

// Parse ONE SSE `data:` payload (the string AFTER 'data: ') into a text delta.
// '' for [DONE], parse errors, or non-text events. PURE.
function parseSseDelta(provider, dataStr){
  const s = (typeof dataStr === 'string') ? dataStr : '';
  if (s.trim() === '[DONE]') return '';
  let obj;
  try { obj = JSON.parse(s); } catch (_) { return ''; }
  if (!obj || typeof obj !== 'object') return '';
  if (provider === 'anthropic') {
    if (obj.type === 'content_block_delta' && obj.delta && obj.delta.type === 'text_delta') return obj.delta.text || '';
    return '';
  }
  // zai / openai-compatible
  if (obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content) return obj.choices[0].delta.content;
  return '';
}

module.exports = { buildEngineInvocation, aiConfigView, setConfigKey, buildApiRequest, parseSseDelta };
