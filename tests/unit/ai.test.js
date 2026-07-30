import { describe, it, expect } from 'vitest';
import { buildEngineInvocation, aiConfigView, setConfigKey } from '../../core/ai.js';

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

describe('aiConfigView', () => {
  it('maps a populated config to a safe view, hiding raw keys (happy)', () => {
    const v = aiConfigView({ mode: 'api', provider: 'zai', model: 'm', keys: { anthropic: 'x' } });
    expect(v).toEqual({ mode: 'api', provider: 'zai', model: 'm', hasKey: { anthropic: true, zai: false } });
  });

  it('defaults to cli/anthropic/empty when given null (edge)', () => {
    expect(aiConfigView(null)).toEqual({
      mode: 'cli', provider: 'anthropic', model: '', hasKey: { anthropic: false, zai: false },
    });
  });

  it('defaults to cli/anthropic/empty when given an empty object (edge)', () => {
    expect(aiConfigView({})).toEqual({
      mode: 'cli', provider: 'anthropic', model: '', hasKey: { anthropic: false, zai: false },
    });
  });

  it('NEVER leaks raw keys to the renderer (no keys field, no raw string)', () => {
    const v = aiConfigView({ mode: 'api', keys: { anthropic: 'SECRET', zai: 'ALSO-SECRET' } });
    expect(v).not.toHaveProperty('keys');
    expect(JSON.stringify(v)).not.toContain('SECRET');
    expect(JSON.stringify(v)).not.toContain('ALSO-SECRET');
  });

  it('treats a non-string / empty key as absent (edge)', () => {
    const v = aiConfigView({ keys: { anthropic: '', zai: 123, x: 'y' } });
    expect(v.hasKey).toEqual({ anthropic: false, zai: false });
  });
});

describe('setConfigKey', () => {
  it('sets an encrypted key without mutating the input (happy)', () => {
    const cfg = { keys: {} };
    const next = setConfigKey(cfg, 'anthropic', 'ENC');
    expect(next.keys.anthropic).toBe('ENC');
    expect(cfg.keys.anthropic).toBeUndefined();   // input untouched
  });

  it('clears the key when encrypted is null (edge)', () => {
    const next = setConfigKey({ keys: { anthropic: 'x' } }, 'anthropic', null);
    expect(next.keys.anthropic).toBeUndefined();
  });

  it('clears the key when encrypted is empty string (edge)', () => {
    const next = setConfigKey({ keys: { anthropic: 'x' } }, 'anthropic', '');
    expect(next.keys.anthropic).toBeUndefined();
  });

  it('returns the config unchanged for an unsupported provider (edge)', () => {
    const cfg = { keys: { anthropic: 'x' } };
    expect(setConfigKey(cfg, 'openai', 'x')).toBe(cfg);
  });

  it('preserves other keys and top-level fields when setting one (edge)', () => {
    const next = setConfigKey({ mode: 'api', keys: { anthropic: 'a' } }, 'zai', 'b');
    expect(next.mode).toBe('api');
    expect(next.keys).toEqual({ anthropic: 'a', zai: 'b' });
  });
});
