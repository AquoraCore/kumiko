// AI provider capabilities — the ONE source of truth for which models each provider
// offers and whether a model supports a "thinking"/reasoning mode. POC: a curated static
// table (no live API probing). UMD so the wiring (core/ai.js, Node) and the settings UI
// (renderer, browser) read the exact same data.
//
// Per model: `thinking` = does the model support an extended-thinking / reasoning mode.
// Per provider: `thinkingDefault` = whether that mode is ON unless the user turns it off
//   (Anthropic extended thinking is opt-IN; GLM-5 reasoning is ON by default).
const AI_CAPABILITIES = {
  anthropic: {
    label: 'Claude (Anthropic)',
    thinkingDefault: false,
    models: [
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', thinking: true, vision: true },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', thinking: true, vision: true },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', thinking: false, vision: true },
    ],
  },
  zai: {
    label: 'GLM (Z.ai)',
    thinkingDefault: true,
    models: [
      { id: 'glm-5.2', label: 'GLM-5.2 · reasoning', thinking: true },
      { id: 'glm-5.1', label: 'GLM-5.1 · reasoning', thinking: true },
      { id: 'glm-4.7', label: 'GLM-4.7', thinking: false },
      { id: 'glm-4.6v', label: 'GLM-4.6V · vision', thinking: true, vision: true },
      { id: 'glm-4.5v', label: 'GLM-4.5V · vision', thinking: true, vision: true },
    ],
    visionDefault: 'glm-4.6v',
  },
  'zai-coding': {
    label: 'GLM (Z.ai Coding Plan)',
    thinkingDefault: true,
    models: [
      { id: 'glm-5.2', label: 'GLM-5.2 · reasoning', thinking: true },
      { id: 'glm-5.1', label: 'GLM-5.1 · reasoning', thinking: true },
      { id: 'glm-4.6v', label: 'GLM-4.6V · vision', thinking: true, vision: true },
      { id: 'glm-4.5v', label: 'GLM-4.5V · vision', thinking: true, vision: true },
    ],
    visionDefault: 'glm-4.6v',
  },
  // gemini CLI (subscription mode) — thinking is NOT toggleable from Kumiko (the CLI decides),
  // hence thinking:false on every row. Free-text model; empty = the CLI's own default.
  gemini: {
    label: 'Gemini CLI (Google)',
    thinkingDefault: false,
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', thinking: false },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', thinking: false },
    ],
  },
};

function aiProviders(){ return Object.keys(AI_CAPABILITIES); }
function modelsForProvider(provider){ const p = AI_CAPABILITIES[provider]; return (p && p.models) || []; }
// vision: can (provider, model) accept image content? Anthropic — every Claude model can.
function modelSupportsVision(provider, modelId){
  const m = modelsForProvider(provider).find((x) => x.id === modelId);
  return !!(m && m.vision);
}
// The model a provider should SWITCH TO when a message carries images and the main model is
// text-only. null = no switch possible/needed (anthropic models all see; unknown provider can't).
function visionModelFor(provider, modelId){
  if (modelSupportsVision(provider, modelId)) return modelId;   // already vision-capable
  const p = AI_CAPABILITIES[provider];
  return (p && p.visionDefault) || null;
}
function modelSupportsThinking(provider, modelId){
  const m = modelsForProvider(provider).find((x) => x.id === modelId);
  return !!(m && m.thinking);
}
function thinkingDefault(provider){ const p = AI_CAPABILITIES[provider]; return !!(p && p.thinkingDefault); }
// Resolve the effective thinking flag: explicit user choice (bool) wins; otherwise the
// provider default — but never ON for a model that can't do it.
function resolveThinking(provider, modelId, userChoice){
  const supported = modelSupportsThinking(provider, modelId);
  if (!supported) return false;
  if (userChoice === true || userChoice === false) return userChoice;
  return thinkingDefault(provider);
}

// NOTE: browser loads core/*.js as plain (non-module) scripts sharing ONE global scope,
// so this top-level const MUST have a file-unique name (a bare `_api` collides with tags.js).
const _aicapsApi = { AI_CAPABILITIES, aiProviders, modelsForProvider, modelSupportsThinking, thinkingDefault, resolveThinking, modelSupportsVision, visionModelFor };
if (typeof module !== 'undefined' && module.exports) module.exports = _aicapsApi;
if (typeof window !== 'undefined') window.AICaps = _aicapsApi;
