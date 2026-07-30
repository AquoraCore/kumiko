import { describe, it, expect } from 'vitest';
import { buildEngineInvocation } from '../../core/ai.js';

describe('buildEngineInvocation', () => {
  it('builds the glm invocation (opencode run -m <model>, prompt on stdin) (happy)', () => {
    expect(buildEngineInvocation('glm', 'glm-5.2', 'P')).toEqual({
      cmd: 'opencode',
      args: ['run', '-m', 'glm-5.2'],
      stdin: 'P',
    });
  });

  it('builds the claude invocation (-p <prompt> --permission-mode acceptEdits, null stdin) (happy)', () => {
    expect(buildEngineInvocation('claude', '', 'hello')).toEqual({
      cmd: 'claude',
      args: ['-p', 'hello', '--permission-mode', 'acceptEdits'],
      stdin: null,
    });
  });

  it('returns null for an unknown engine (edge)', () => {
    expect(buildEngineInvocation('foo', 'm', 'p')).toBeNull();
  });

  it('still builds args with an empty model for glm (edge)', () => {
    expect(buildEngineInvocation('glm', '', 'p')).toEqual({
      cmd: 'opencode',
      args: ['run', '-m', ''],
      stdin: 'p',
    });
  });
});
