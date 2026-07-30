import { describe, it, expect } from 'vitest';
import { parseFrontmatter, serializeFrontmatter } from '../../core/frontmatter.js';

describe('parseFrontmatter (happy)', () => {
  it('splits attrs and body from a flat frontmatter block', () => {
    const { attrs, body } = parseFrontmatter('---\nstatus: new\ntags: a, b\n---\n\nbody');
    expect(attrs).toEqual({ status: 'new', tags: 'a, b' });
    expect(body).toBe('body');
  });
});

describe('parseFrontmatter (edge)', () => {
  it('returns empty attrs + unchanged body when text does not start with ---', () => {
    const text = 'hello world';
    expect(parseFrontmatter(text)).toEqual({ attrs: {}, body: text });
  });

  it('returns empty attrs + unchanged body when opening --- has no closing ---', () => {
    const text = '---\nstatus: new\nbody without close';
    expect(parseFrontmatter(text)).toEqual({ attrs: {}, body: text });
  });

  it('ignores attribute lines that have no colon', () => {
    const { attrs } = parseFrontmatter('---\nstatus: new\nnoColonLine\ntags: x\n---\n\nb');
    expect(attrs).toEqual({ status: 'new', tags: 'x' });
  });
});

describe('serializeFrontmatter (happy)', () => {
  it('emits a frontmatter block around the body', () => {
    expect(serializeFrontmatter({ status: 'new' }, 'body')).toBe('---\nstatus: new\n---\n\nbody');
  });
});

describe('serializeFrontmatter (edge)', () => {
  it('returns just the body when attrs is empty', () => {
    expect(serializeFrontmatter({}, 'body')).toBe('body');
  });

  it('filters out "" and null attribute values', () => {
    expect(serializeFrontmatter({ status: '', tags: null, keep: 'y' }, 'b')).toBe('---\nkeep: y\n---\n\nb');
  });

  it('round-trips: parse(serialize(attrs, body)) yields the same attrs and body', () => {
    const { attrs, body } = parseFrontmatter(serializeFrontmatter({ status: 'x' }, 'b'));
    expect(attrs).toEqual({ status: 'x' });
    expect(body).toBe('b');
  });
});
