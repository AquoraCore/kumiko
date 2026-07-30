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

module.exports = { buildEngineInvocation };
