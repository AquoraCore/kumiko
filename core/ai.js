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
  // thinking: true/false = explicit user choice; null = "use the provider/model default".
  const thinking = (c.thinking === true || c.thinking === false) ? c.thinking : null;
  // CLI (subscription) mode fields — which local CLI to spawn + its model (glm/opencode only).
  const cliEngine = (c.cliEngine === 'glm' || c.cliEngine === 'claude') ? c.cliEngine : 'claude';
  const cliModel = (typeof c.cliModel === 'string') ? c.cliModel : '';
  return { mode, provider, model, thinking, cliEngine, cliModel, hasKey: { anthropic: has('anthropic'), zai: has('zai') } };
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
// opts.thinking (bool) — turn the model's thinking/reasoning mode on/off. It's mapped to
// each provider's own shape: Anthropic extended thinking is opt-IN (add an `enabled` block +
// room in max_tokens); GLM reasoning is ON by default, so we only add a `disabled` block when
// the user turns it OFF. A missing/undefined thinking leaves each provider at its default.
function buildApiRequest(provider, model, prompt, key, opts){
  const thinking = (opts && typeof opts.thinking === 'boolean') ? opts.thinking : null;
  if (provider === 'anthropic') {
    const body = { model, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: prompt }] };
    if (thinking === true) { body.thinking = { type: 'enabled', budget_tokens: 2048 }; body.max_tokens = 8192; }  // max_tokens MUST exceed budget
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body,
    };
  }
  // GLM-5 reasoning streams `reasoning_content` (surfaced by parseSseDelta) BEFORE the final
  // `content`. ON by default; `thinking:{type:'disabled'}` forces a direct answer.
  if (provider === 'zai') {
    const body = { model, stream: true, messages: [{ role: 'user', content: prompt }] };
    if (thinking === false) body.thinking = { type: 'disabled' };
    return {
      url: 'https://api.z.ai/api/paas/v4/chat/completions',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
      body,
    };
  }
  // Z.ai CODING PLAN (subscription) — same OpenAI-compatible shape as zai, but the
  // coding endpoint (a pay-as-you-go zai key hits /paas/v4 and 1113s on no balance).
  if (provider === 'zai-coding') {
    const body = { model, stream: true, messages: [{ role: 'user', content: prompt }] };
    if (thinking === false) body.thinking = { type: 'disabled' };
    return {
      url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
      body,
    };
  }
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
    if (obj.type === 'content_block_delta' && obj.delta) {
      if (obj.delta.type === 'text_delta') return obj.delta.text || '';
      if (obj.delta.type === 'thinking_delta') return obj.delta.thinking || '';   // extended-thinking stream
    }
    return '';
  }
  // zai / openai-compatible. GLM-5 reasoning models stream `reasoning_content` (the thinking)
  // BEFORE the final `content` answer — surface both so thinking mode isn't a blank stream.
  const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
  if (d) return d.content || d.reasoning_content || '';
  return '';
}

// ---- Embedding request builders: PURE, side-effect-free ---------------------
// Mirrors buildApiRequest/parseSseDelta for the embeddings path. Only zai
// (OpenAI-compatible) is supported today; anthropic has no native embeddings
// API, and unknown providers return null = "semantic unsupported". main.js
// falls back to lexical-only when buildEmbedRequest yields null.
function buildEmbedRequest(provider, model, inputs, key){
  if (provider === 'zai') return {
    url: 'https://api.z.ai/api/paas/v4/embeddings',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
    body: { model, input: inputs },
  };
  return null;
}

// Parse the already-parsed embeddings JSON body into an array of vectors
// (one per input, in order). Never throws: malformed input -> [].
// zai/openai-compatible: obj.data is [{ embedding: number[] }] (optionally
// with an `index` field; sort by it so order matches the batched inputs).
function parseEmbedResponse(provider, obj){
  if (provider !== 'zai') return [];
  if (!obj || typeof obj !== 'object') return [];
  if (!Array.isArray(obj.data)) return [];
  const withIndex = obj.data.filter((e) => e && Array.isArray(e.embedding));
  if (withIndex.some((e) => typeof e.index === 'number')) {
    withIndex.sort((a, b) => a.index - b.index);
  }
  return withIndex.map((e) => e.embedding);
}

module.exports = {
  buildEngineInvocation, aiConfigView, setConfigKey,
  buildApiRequest, parseSseDelta,
  buildEmbedRequest, parseEmbedResponse,
  // capability table (models + thinking support) — re-exported for convenience
  ...require('./aicaps'),
};
