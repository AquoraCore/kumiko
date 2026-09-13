// ---- AI engine invocation seam --------------------------------------------
// Pure, side-effect-free mapping: (engine, model, prompt) -> { cmd, args, stdin }.
// Captures EXACTLY how main.js spawns each engine today, so the spawn path can be
// unit-tested without touching child_process. Unknown engine -> null.
//   glm    = `opencode run -m <model>`, prompt on STDIN
//   claude = `claude -p <prompt> --permission-mode acceptEdits [--model <model>]`, no STDIN
// For claude, `model` is an OPTIONAL alias/id (opus|sonnet|haiku|full-id); empty = CLI default.
//   gemini = `gemini --approval-mode auto_edit [-m <model>] -p <prompt>`, no STDIN (verified on
//   gemini-cli 0.41.2: headless REQUIRES -p; auto_edit approves ONLY edit tools; the env var
//   below bypasses the trusted-directory gate). `model` empty = CLI default.
function buildEngineInvocation(engine, model, prompt){
  if (engine === 'glm') return { cmd: 'opencode', args: ['run', '-m', model], stdin: prompt };
  if (engine === 'claude') {
    const args = ['-p', prompt, '--permission-mode', 'acceptEdits'];
    if (model) args.push('--model', model);
    return { cmd: 'claude', args, stdin: null };
  }
  if (engine === 'gemini') {
    const args = ['--approval-mode', 'auto_edit'];
    if (model) args.push('-m', model);
    args.push('-p', prompt);
    return { cmd: 'gemini', args, stdin: null, env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' } };
  }
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
  // CLI (subscription) mode fields — which local CLI to spawn + its model (glm/opencode, claude, gemini).
  const cliEngine = (c.cliEngine === 'glm' || c.cliEngine === 'claude' || c.cliEngine === 'gemini') ? c.cliEngine : 'claude';
  const cliModel = (typeof c.cliModel === 'string') ? c.cliModel : '';
  // vision: which model handles image messages (Z.ai only — Claude models all see), whether to
  // auto-switch to it, and whether READ-NOTE attaches slide images from notes. Defaults ON.
  const visionModel = (typeof c.visionModel === 'string') ? c.visionModel : '';
  const autoVision = (c.autoVision === false) ? false : true;
  const readNoteImages = (c.readNoteImages === false) ? false : true;
  // configured: separates "the raw defaults" from "the user chose something" — set when the user
  // saves from the settings modal or the onboarding wizard (also on "ข้ามไปก่อน"/skip).
  const configured = !!(c.configured === true);
  // keyProviders: WHICH provider names hold a key (names only, never values) — hasKey
  // merges the two Z.ai flavors for the settings UI, but the per-tab engine picker
  // must offer the exact endpoint the key was saved for (coding-plan keys 1113 on /paas).
  const keyProviders = Object.keys(keys).filter((p) => has(p));
  return { mode, provider, model, thinking, configured, cliEngine, cliModel, visionModel, autoVision, readNoteImages, keyProviders, hasKey: { anthropic: has('anthropic'), zai: has('zai') || has('zai-coding'), 'zai-coding': has('zai-coding') || has('zai') } };   // both Z.ai endpoints share one key
}

// Return a NEW config with keys[provider] set to `encrypted`, or DELETED when
// `encrypted` is null/''/undefined. Never mutates the input. Ignores unknown
// providers (returns cfg unchanged) so the surface stays {anthropic, zai}.
function setConfigKey(cfg, provider, encrypted){
  if (provider !== 'anthropic' && provider !== 'zai' && provider !== 'zai-coding') return cfg;
  const c = (cfg && typeof cfg === 'object') ? cfg : {};
  const next = Object.assign({}, c, { keys: Object.assign({}, c.keys || {}) });
  if (encrypted === null || encrypted === undefined || encrypted === '') delete next.keys[provider];
  else next.keys[provider] = encrypted;
  return next;
}

// ---- Per-tab engine override (chat header): PURE helpers -----------------------
// The chat-header dropdown used to be decorative — engine:run followed Settings no
// matter what the tab said. Now a tab picks a REAL backend ('default' = follow
// Settings). Options come only from what actually works: installed CLIs (desktop)
// + providers with a saved key. Ids: 'default' | 'cli:claude' | 'cli:glm' |
// 'cli:gemini' | 'api:<provider>'.
function engineTabOptions(view, detect, opts){
  const out = [{ id: 'default' }];
  const web = !!(opts && opts.web);
  if (!web && detect && typeof detect === 'object'){
    if (detect.claude) out.push({ id: 'cli:claude' });
    if (detect.opencode) out.push({ id: 'cli:glm' });
    if (detect.gemini) out.push({ id: 'cli:gemini' });
  }
  const kp = (view && Array.isArray(view.keyProviders)) ? view.keyProviders : [];
  ['anthropic', 'zai', 'zai-coding'].forEach((p) => { if (kp.indexOf(p) >= 0) out.push({ id: 'api:' + p }); });
  return out;
}
// Second dropdown: model choices for a picked id ('' = that backend's own default).
// `modelsFor` = aicaps modelsForProvider (injected: Node re-exports it, the browser
// has it on window.AICaps — core files must not reach for either directly).
function modelChoicesFor(id, modelsFor){
  if (id === 'cli:claude') return ['', 'opus', 'sonnet', 'haiku'];
  if (id === 'cli:glm') return ['zai-coding-plan/glm-5.2', 'zai-coding-plan/glm-5.1', 'zai-coding-plan/glm-5-turbo', 'zai-coding-plan/glm-4.7', 'zai-coding-plan/glm-4.5-air'];
  if (id === 'cli:gemini') return ['', 'gemini-2.5-pro', 'gemini-2.5-flash'];
  if (typeof id === 'string' && id.indexOf('api:') === 0 && typeof modelsFor === 'function'){
    return modelsFor(id.slice(4)).map((m) => m.id);
  }
  return [];
}
// Dispatch descriptor for engine:run — null = follow Settings (also for junk input).
function resolveEngineOverride(sel, model){
  const m = (typeof model === 'string') ? model.trim() : '';
  if (sel === 'cli:claude') return { kind: 'cli', engine: 'claude', model: m };
  if (sel === 'cli:glm') return { kind: 'cli', engine: 'glm', model: m || 'zai-coding-plan/glm-5.2' };
  if (sel === 'cli:gemini') return { kind: 'cli', engine: 'gemini', model: m };
  if (typeof sel === 'string' && sel.indexOf('api:') === 0){
    const p = sel.slice(4);
    if (p === 'anthropic' || p === 'zai' || p === 'zai-coding') return { kind: 'api', provider: p, model: m };
  }
  return null;
}

// ---- AI onboarding wizard: PURE decision helpers ------------------------------
// shouldShowAiWizard: does the FIRST-open-of-AI-chat wizard pop? Takes the SAFE view from
// aiConfigView (never raw keys) + opts.web (renderer is the web build). Never at boot, never
// on web, never once the user has touched AI setup (a saved key or configured=true).
function shouldShowAiWizard(view, opts){
  if (!view) return false;
  if (opts && opts.web) return false;   // web has managed/API — no CLI wizard there
  if (view.configured) return false;
  if (view.hasKey && (view.hasKey.anthropic || view.hasKey.zai || view.hasKey['zai-coding'])) return false;
  return true;
}
// aiWizardPatch: wizard choice → ai:setConfig patch. 'skip' only marks configured so the
// wizard never auto-pops again; 'apikey' returns null (the wizard just opens Settings instead).
function aiWizardPatch(choice, model){
  const m = (typeof model === 'string') ? model.trim() : '';
  if (choice === 'claude') return { mode: 'cli', cliEngine: 'claude', cliModel: '', configured: true };
  if (choice === 'gemini') return { mode: 'cli', cliEngine: 'gemini', cliModel: m, configured: true };
  if (choice === 'glm') return { mode: 'cli', cliEngine: 'glm', cliModel: m || 'zai-coding-plan/glm-5.2', configured: true };
  if (choice === 'skip') return { configured: true };
  return null;
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
  // images: array of data URIs. Mapped to each provider's content-block shape; text-only
  // callers pass nothing and get the plain string content exactly as before.
  const images = (opts && Array.isArray(opts.images)) ? opts.images.filter((u) => /^data:image\//.test(String(u))).slice(0, 4) : [];
  const openaiContent = () => images.length
    ? images.map((u) => ({ type: 'image_url', image_url: { url: u } })).concat([{ type: 'text', text: prompt }])
    : prompt;
  if (provider === 'anthropic') {
    const anthContent = images.length
      ? images.map((u) => { const m = String(u).match(/^data:(image\/[a-z+.-]+);base64,(.*)$/s); return { type: 'image', source: { type: 'base64', media_type: m ? m[1] : 'image/jpeg', data: m ? m[2] : '' } }; })
          .concat([{ type: 'text', text: prompt }])
      : prompt;
    const body = { model, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: anthContent }] };
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
    const body = { model, stream: true, messages: [{ role: 'user', content: openaiContent() }] };
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
    const body = { model, stream: true, messages: [{ role: 'user', content: openaiContent() }] };
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

// Same as parseSseDelta but keeps the two streams APART: { text, reasoning }. The runner sends
// reasoning on its own channel (engine:output kind:'reasoning') so the chat can show it as a
// collapsible "thinking" block and it NEVER lands in the saved answer / note markers.
function parseSseEvent(provider, dataStr){
  const s = (typeof dataStr === 'string') ? dataStr : '';
  const out = { text: '', reasoning: '' };
  if (s.trim() === '[DONE]') return out;
  let obj;
  try { obj = JSON.parse(s); } catch (_) { return out; }
  if (!obj || typeof obj !== 'object') return out;
  if (provider === 'anthropic') {
    if (obj.type === 'content_block_delta' && obj.delta) {
      if (obj.delta.type === 'text_delta') out.text = obj.delta.text || '';
      else if (obj.delta.type === 'thinking_delta') out.reasoning = obj.delta.thinking || '';
    }
    return out;
  }
  const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
  if (d) { out.text = d.content || ''; out.reasoning = d.reasoning_content || ''; }
  return out;
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

// Browser (renderer loads this as a plain script): expose ONLY the pure helpers the wizard
// needs — the request builders stay Node-only (they never run in a browser anyway).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildEngineInvocation, aiConfigView, setConfigKey,
    shouldShowAiWizard, aiWizardPatch,
    engineTabOptions, modelChoicesFor, resolveEngineOverride,
    buildApiRequest, parseSseDelta, parseSseEvent,
    buildEmbedRequest, parseEmbedResponse,
    // capability table (models + thinking support) — re-exported for convenience
    ...require('./aicaps'),
  };
}
if (typeof window !== 'undefined') window.CoreAi = { shouldShowAiWizard, aiWizardPatch, engineTabOptions, modelChoicesFor, resolveEngineOverride };
