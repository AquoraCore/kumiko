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

module.exports = { buildEngineInvocation, aiConfigView, setConfigKey };
