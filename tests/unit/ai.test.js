import { describe, it, expect } from 'vitest';
import {
  buildEngineInvocation, aiConfigView, setConfigKey,
  buildApiRequest, parseSseDelta,
  buildEmbedRequest, parseEmbedResponse,
} from '../../core/ai.js';

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

  it('appends --model for claude ONLY when a model alias is given (subscription model pick)', () => {
    expect(buildEngineInvocation('claude', 'opus', 'hi').args).toEqual(['-p', 'hi', '--permission-mode', 'acceptEdits', '--model', 'opus']);
    expect(buildEngineInvocation('claude', '', 'hi').args).not.toContain('--model');
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
    expect(v).toEqual({ mode: 'api', provider: 'zai', model: 'm', thinking: null, cliEngine: 'claude', cliModel: '', hasKey: { anthropic: true, zai: false } });
  });

  it('defaults to cli/anthropic/empty when given null (edge)', () => {
    expect(aiConfigView(null)).toEqual({
      mode: 'cli', provider: 'anthropic', model: '', thinking: null, cliEngine: 'claude', cliModel: '', hasKey: { anthropic: false, zai: false },
    });
  });

  it('defaults to cli/anthropic/empty when given an empty object (edge)', () => {
    expect(aiConfigView({})).toEqual({
      mode: 'cli', provider: 'anthropic', model: '', thinking: null, cliEngine: 'claude', cliModel: '', hasKey: { anthropic: false, zai: false },
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

  it('builds the zai-coding (Coding Plan) request against the coding endpoint (happy)', () => {
    const r = buildApiRequest('zai-coding', 'glm-5.2', 'hi', KEY);
    expect(r.url).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');   // NOT /paas/v4 (that 1113s on a coding-plan key)
    expect(r.headers.authorization).toBe('Bearer ' + KEY);
    expect(r.body.stream).toBe(true);
    // parseSseDelta treats any non-anthropic provider as OpenAI-compatible → zai-coding streams parse fine
    expect(parseSseDelta('zai-coding', JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }))).toBe('ok');
    // THINKING MODE: GLM-5 streams reasoning_content before the answer — it must be surfaced too
    expect(parseSseDelta('zai-coding', JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' } }] }))).toBe('hmm');
    expect(parseSseDelta('zai', JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }))).toBe('think');
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

describe('buildEmbedRequest', () => {
  it('builds the zai (openai-compatible) embeddings request (happy)', () => {
    const r = buildEmbedRequest('zai', 'embedding-3', ['a', 'b'], 'KEY');
    expect(r.url.endsWith('/embeddings')).toBe(true);
    expect(r.headers.authorization).toBe('Bearer KEY');
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.body.model).toBe('embedding-3');
    expect(r.body.input).toEqual(['a', 'b']);
  });

  it('returns null for anthropic (no native embeddings) (edge)', () => {
    expect(buildEmbedRequest('anthropic', 'm', ['a'], 'k')).toBeNull();
  });

  it('returns null for an unknown provider (edge)', () => {
    expect(buildEmbedRequest('nope', 'm', ['a'], 'k')).toBeNull();
  });
});

describe('parseEmbedResponse', () => {
  it('extracts vectors from a zai/openai body in order (happy)', () => {
    const obj = { data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3, 4] }] };
    expect(parseEmbedResponse('zai', obj)).toEqual([[1, 2], [3, 4]]);
  });

  it('sorts by index when entries are out of order (happy)', () => {
    const obj = { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] };
    expect(parseEmbedResponse('zai', obj)).toEqual([[1, 2], [3, 4]]);
  });

  it('returns [] for a body with no data array (edge)', () => {
    expect(parseEmbedResponse('zai', {})).toEqual([]);
  });

  it('returns [] for null (edge)', () => {
    expect(parseEmbedResponse('zai', null)).toEqual([]);
  });

  it('skips entries whose embedding is not an array (edge)', () => {
    const obj = { data: [{ embedding: 'nope' }, { embedding: [9] }] };
    expect(parseEmbedResponse('zai', obj)).toEqual([[9]]);
  });

  it('returns [] for anthropic (defensive) (edge)', () => {
    expect(parseEmbedResponse('anthropic', { data: [{ embedding: [1] }] })).toEqual([]);
  });
});
