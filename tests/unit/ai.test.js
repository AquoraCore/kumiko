import { describe, it, expect } from 'vitest';
import {
  buildEngineInvocation, aiConfigView, setConfigKey,
  shouldShowAiWizard, aiWizardPatch,
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

  it('builds the gemini invocation with a model, args in order (happy)', () => {
    expect(buildEngineInvocation('gemini', 'gemini-2.5-pro', 'P')).toEqual({
      cmd: 'gemini',
      args: ['--approval-mode', 'auto_edit', '-m', 'gemini-2.5-pro', '-p', 'P'],
      stdin: null,
      env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    });
  });

  it('builds the gemini invocation WITHOUT -m when no model — CLI default (happy)', () => {
    const inv = buildEngineInvocation('gemini', '', 'hi');
    expect(inv.args).toEqual(['--approval-mode', 'auto_edit', '-p', 'hi']);
    expect(inv.args).not.toContain('-m');
    expect(inv.stdin).toBeNull();
    expect(inv.env).toEqual({ GEMINI_CLI_TRUST_WORKSPACE: 'true' });
  });

  it('keeps the glm/claude shapes env-free (regression — no new fields on old engines)', () => {
    expect(buildEngineInvocation('glm', 'm', 'p')).not.toHaveProperty('env');
    expect(buildEngineInvocation('claude', '', 'p')).not.toHaveProperty('env');
  });
});

describe('aiConfigView', () => {
  it('maps a populated config to a safe view, hiding raw keys (happy)', () => {
    const v = aiConfigView({ mode: 'api', provider: 'zai', model: 'm', keys: { anthropic: 'x' } });
    expect(v).toEqual({ mode: 'api', provider: 'zai', model: 'm', thinking: null, configured: false, cliEngine: 'claude', cliModel: '', visionModel: '', autoVision: true, readNoteImages: true, hasKey: { anthropic: true, zai: false, 'zai-coding': false } });
  });

  it('defaults to cli/anthropic/empty when given null (edge)', () => {
    expect(aiConfigView(null)).toEqual({
      mode: 'cli', provider: 'anthropic', model: '', thinking: null, configured: false, cliEngine: 'claude', cliModel: '', visionModel: '', autoVision: true, readNoteImages: true, hasKey: { anthropic: false, zai: false, 'zai-coding': false },
    });
  });

  it('defaults to cli/anthropic/empty when given an empty object (edge)', () => {
    expect(aiConfigView({})).toEqual({
      mode: 'cli', provider: 'anthropic', model: '', thinking: null, configured: false, cliEngine: 'claude', cliModel: '', visionModel: '', autoVision: true, readNoteImages: true, hasKey: { anthropic: false, zai: false, 'zai-coding': false },
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
    expect(v.hasKey).toEqual({ anthropic: false, zai: false, 'zai-coding': false });
  });

  it('accepts gemini as a cliEngine (edge)', () => {
    expect(aiConfigView({ mode: 'cli', cliEngine: 'gemini', cliModel: 'gemini-2.5-pro' }).cliEngine).toBe('gemini');
  });

  it('still falls back to claude for junk cliEngine values (edge)', () => {
    expect(aiConfigView({ cliEngine: 'gpt' }).cliEngine).toBe('claude');
    expect(aiConfigView({}).cliEngine).toBe('claude');
    expect(aiConfigView(null).cliEngine).toBe('claude');
  });

  it('surfaces configured=true once the user saved/skipped AI setup (wizard gate)', () => {
    expect(aiConfigView({ configured: true }).configured).toBe(true);
    expect(aiConfigView({ configured: 'yes' }).configured).toBe(false);   // only strict true
    expect(aiConfigView({}).configured).toBe(false);
  });
});

describe('shouldShowAiWizard — pop the first-run AI wizard?', () => {
  it('pops for a completely untouched config (happy)', () => {
    expect(shouldShowAiWizard(aiConfigView({}))).toBe(true);
    expect(shouldShowAiWizard(aiConfigView(null))).toBe(true);
  });

  it('does NOT pop when a key is already saved (edge)', () => {
    expect(shouldShowAiWizard(aiConfigView({ keys: { anthropic: 'enc' } }))).toBe(false);
    expect(shouldShowAiWizard(aiConfigView({ keys: { zai: 'enc' } }))).toBe(false);
    expect(shouldShowAiWizard(aiConfigView({ keys: { 'zai-coding': 'enc' } }))).toBe(false);
  });

  it('does NOT pop once configured (saved settings or skipped wizard) (edge)', () => {
    expect(shouldShowAiWizard(aiConfigView({ configured: true }))).toBe(false);
  });

  it('never pops in web mode even with an untouched config (edge)', () => {
    expect(shouldShowAiWizard(aiConfigView({}), { web: true })).toBe(false);
  });

  it('no view → no wizard (defensive)', () => {
    expect(shouldShowAiWizard(null)).toBe(false);
  });
});

describe('aiWizardPatch — wizard choice → ai:setConfig patch', () => {
  it('claude → cli mode, claude engine, no model alias (happy)', () => {
    expect(aiWizardPatch('claude')).toEqual({ mode: 'cli', cliEngine: 'claude', cliModel: '', configured: true });
  });

  it('gemini → cli mode, gemini engine, free-text model; empty = CLI default (happy)', () => {
    expect(aiWizardPatch('gemini', 'gemini-2.5-pro')).toEqual({ mode: 'cli', cliEngine: 'gemini', cliModel: 'gemini-2.5-pro', configured: true });
    expect(aiWizardPatch('gemini', '  ')).toEqual({ mode: 'cli', cliEngine: 'gemini', cliModel: '', configured: true });
  });

  it('glm → cli mode with the Coding-Plan model default when left empty (happy)', () => {
    expect(aiWizardPatch('glm', '')).toEqual({ mode: 'cli', cliEngine: 'glm', cliModel: 'zai-coding-plan/glm-5.2', configured: true });
    expect(aiWizardPatch('glm', 'zai-coding-plan/glm-4.7')).toEqual({ mode: 'cli', cliEngine: 'glm', cliModel: 'zai-coding-plan/glm-4.7', configured: true });
  });

  it('skip → only marks configured so the wizard never auto-pops again (edge)', () => {
    expect(aiWizardPatch('skip')).toEqual({ configured: true });
  });

  it('apikey / unknown → null — no config write, the wizard opens Settings instead (edge)', () => {
    expect(aiWizardPatch('apikey')).toBeNull();
    expect(aiWizardPatch('nope')).toBeNull();
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

describe('parseSseEvent — reasoning kept apart from the answer', () => {
  const { parseSseEvent } = require('../../core/ai.js');
  it('zai/zai-coding: reasoning_content → reasoning, content → text; anthropic thinking_delta → reasoning', () => {
    expect(parseSseEvent('zai-coding', JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' } }] }))).toEqual({ text: '', reasoning: 'hmm' });
    expect(parseSseEvent('zai', JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }))).toEqual({ text: 'ok', reasoning: '' });
    expect(parseSseEvent('anthropic', JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'T' } }))).toEqual({ text: '', reasoning: 'T' });
    expect(parseSseEvent('anthropic', JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } }))).toEqual({ text: 'A', reasoning: '' });
    expect(parseSseEvent('zai', '[DONE]')).toEqual({ text: '', reasoning: '' });
    expect(parseSseEvent('zai', 'not json')).toEqual({ text: '', reasoning: '' });
  });
  it('runner emits reasoning on kind:"reasoning"; chat shows a collapsible block and keeps it out of the answer; side chat/autolink/server ignore it', () => {
    const fs = require('fs'), path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
    expect(read('main.js')).toMatch(/if \(ev\.reasoning\) emitReasoning\(ev\.reasoning\);/);
    expect(read('main.js')).toMatch(/kind: 'reasoning'/);
    const chat = read('renderer/chat.js');
    expect(chat).toMatch(/if \(payload\.kind === 'reasoning'\) \{[\s\S]{0,400}last\.think = /);
    expect(chat).toMatch(/function thinkBlockHtml\(m, open\)/);
    expect(chat).toMatch(/thinkBlockHtml\(m, running && !m\.text\) \+ _linkify/);
    expect(read('renderer/renderer.js')).toMatch(/p\.runId === 'autolink' && p\.kind !== 'reasoning'/);
    expect(read('renderer/renderer.js')).toMatch(/if \(!sc \|\| p\.kind === 'reasoning'\) return;/);
    expect(read('server/index.js')).toMatch(/const ev = aiCore\.parseSseEvent\(provider, m\[1\]\);\n        if \(ev\.text\) yield ev\.text;/);
  });
});
