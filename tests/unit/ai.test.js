import { describe, it, expect } from 'vitest';
import { buildEngineInvocation, aiConfigView, setConfigKey, buildApiRequest, parseSseDelta } from '../../core/ai.js';

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

describe('buildApiRequest', () => {
  const KEY = 'TEST-KEY-123';

  it('builds the anthropic streaming request (happy)', () => {
    const r = buildApiRequest('anthropic', 'claude-sonnet-5', 'hello', KEY);
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.headers['x-api-key']).toBe(KEY);
    expect(r.headers['anthropic-version']).toBeTruthy();
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.body.stream).toBe(true);
    expect(r.body.max_tokens).toBe(4096);
    expect(r.body.messages[0].content).toBe('hello');
    expect(r.body.model).toBe('claude-sonnet-5');
  });

  it('builds the zai (openai-compatible) streaming request (happy)', () => {
    const r = buildApiRequest('zai', 'glm-5.2', 'hi', KEY);
    expect(r.url).toContain('/chat/completions');
    expect(r.headers.authorization).toBe('Bearer ' + KEY);
    expect(r.body.stream).toBe(true);
    expect(r.body.messages[0].content).toBe('hi');
  });

  it('returns null for an unknown provider (edge)', () => {
    expect(buildApiRequest('openai', 'm', 'p', KEY)).toBeNull();
  });
});

describe('parseSseDelta', () => {
  it('extracts text from an anthropic content_block_delta (happy)', () => {
    const data = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } });
    expect(parseSseDelta('anthropic', data)).toBe('Hello');
  });

  it('extracts content from a zai/openai delta (happy)', () => {
    const data = JSON.stringify({ choices: [{ delta: { content: 'World' } }] });
    expect(parseSseDelta('zai', data)).toBe('World');
  });

  it('returns "" for [DONE] (edge)', () => {
    expect(parseSseDelta('anthropic', '[DONE]')).toBe('');
    expect(parseSseDelta('zai', ' [DONE] ')).toBe('');
  });

  it('returns "" for malformed JSON (edge)', () => {
    expect(parseSseDelta('anthropic', 'not-json')).toBe('');
  });

  it('returns "" for an anthropic non-text event, e.g. message_start (edge)', () => {
    const data = JSON.stringify({ type: 'message_start', message: {} });
    expect(parseSseDelta('anthropic', data)).toBe('');
  });

  it('returns "" for a zai chunk with no delta.content (edge)', () => {
    const data = JSON.stringify({ choices: [{ delta: {} }] });
    expect(parseSseDelta('zai', data)).toBe('');
  });
});
