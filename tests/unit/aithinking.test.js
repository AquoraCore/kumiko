import { describe, it, expect } from 'vitest';
const ai = require('../../core/ai');
const caps = require('../../core/aicaps');

describe('AI capability table (models + thinking support)', () => {
  it('lists models per provider and marks thinking support', () => {
    expect(caps.modelsForProvider('anthropic').map((m) => m.id)).toContain('claude-opus-4-8');
    expect(caps.modelSupportsThinking('anthropic', 'claude-opus-4-8')).toBe(true);
    expect(caps.modelSupportsThinking('anthropic', 'claude-haiku-4-5-20251001')).toBe(false);
    expect(caps.modelSupportsThinking('zai', 'glm-5.2')).toBe(true);
  });
  it('resolveThinking honours support, explicit choice, then provider default', () => {
    // anthropic extended thinking is opt-IN → default off
    expect(caps.resolveThinking('anthropic', 'claude-opus-4-8', null)).toBe(false);
    // GLM reasoning is ON by default
    expect(caps.resolveThinking('zai', 'glm-5.2', null)).toBe(true);
    // explicit choice wins
    expect(caps.resolveThinking('anthropic', 'claude-opus-4-8', true)).toBe(true);
    expect(caps.resolveThinking('zai', 'glm-5.2', false)).toBe(false);
    // never ON for an unsupported model, even if forced
    expect(caps.resolveThinking('anthropic', 'claude-haiku-4-5-20251001', true)).toBe(false);
  });
});

describe('buildApiRequest wires thinking into each provider shape', () => {
  const body = (prov, model, thinking) => ai.buildApiRequest(prov, model, 'hi', 'k', { thinking }).body;
  it('Anthropic: opt-in enabled block + room in max_tokens', () => {
    const on = body('anthropic', 'claude-opus-4-8', true);
    expect(on.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(on.max_tokens).toBeGreaterThan(2048);
    const off = body('anthropic', 'claude-opus-4-8', false);
    expect(off.thinking).toBeUndefined();
    expect(off.max_tokens).toBe(4096);
  });
  it('GLM (zai / zai-coding): ON by default, disabled block only when off', () => {
    expect(body('zai', 'glm-5.2', true).thinking).toBeUndefined();          // default ON → omit
    expect(body('zai', 'glm-5.2', false).thinking).toEqual({ type: 'disabled' });
    expect(body('zai-coding', 'glm-5.2', false).thinking).toEqual({ type: 'disabled' });
  });
  it('no opts → backward-compatible (no thinking field)', () => {
    expect(ai.buildApiRequest('anthropic', 'claude-opus-4-8', 'hi', 'k').body.thinking).toBeUndefined();
    expect(ai.buildApiRequest('zai', 'glm-5.2', 'hi', 'k').body.thinking).toBeUndefined();
  });
});

describe('parseSseDelta surfaces Anthropic extended-thinking stream', () => {
  it('yields thinking_delta and text_delta', () => {
    expect(ai.parseSseDelta('anthropic', JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'why' } }))).toBe('why');
    expect(ai.parseSseDelta('anthropic', JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ans' } }))).toBe('ans');
  });
});

describe('aiConfigView exposes the thinking setting', () => {
  it('passes through true/false and normalises anything else to null', () => {
    expect(ai.aiConfigView({ thinking: true }).thinking).toBe(true);
    expect(ai.aiConfigView({ thinking: false }).thinking).toBe(false);
    expect(ai.aiConfigView({}).thinking).toBe(null);
    expect(ai.aiConfigView({ thinking: 'yes' }).thinking).toBe(null);
  });
});
