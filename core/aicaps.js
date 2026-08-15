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
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', thinking: true },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', thinking: true },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', thinking: false },
    ],
  },
  zai: {
    label: 'GLM (Z.ai)',
    thinkingDefault: true,
    models: [
      { id: 'glm-5.2', label: 'GLM-5.2 · reasoning', thinking: true },
      { id: 'glm-5.1', label: 'GLM-5.1 · reasoning', thinking: true },
      { id: 'glm-4.7', label: 'GLM-4.7', thinking: false },
    ],
  },
  'zai-coding': {
    label: 'GLM (Z.ai Coding Plan)',
    thinkingDefault: true,
    models: [
      { id: 'glm-5.2', label: 'GLM-5.2 · reasoning', thinking: true },
      { id: 'glm-5.1', label: 'GLM-5.1 · reasoning', thinking: true },
    ],
  },
};

function aiProviders(){ return Object.keys(AI_CAPABILITIES); }
function modelsForProvider(provider){ const p = AI_CAPABILITIES[provider]; return (p && p.models) || []; }
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

const _api = { AI_CAPABILITIES, aiProviders, modelsForProvider, modelSupportsThinking, thinkingDefault, resolveThinking };
if (typeof module !== 'undefined' && module.exports) module.exports = _api;
if (typeof window !== 'undefined') window.AICaps = _api;
