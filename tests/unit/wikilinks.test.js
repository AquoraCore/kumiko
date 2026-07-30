import { describe, it, expect } from 'vitest';
import { wikiTargets, linksTo, rewriteLinkTargets } from '../../core/wikilinks.js';

describe('wikiTargets', () => {
  it('extracts a plain [[Note]] target (happy)', () => {
    expect(wikiTargets('[[Note]]')).toEqual(['Note']);
  });

  it('keeps only the target of [[Target|Alias]] (happy)', () => {
    expect(wikiTargets('[[Target|Alias]]')).toEqual(['Target']);
  });

  it('returns both targets when two links appear in one string (happy)', () => {
    expect(wikiTargets('see [[a]] and [[b]]')).toEqual(['a', 'b']);
  });

  it('matches the escaped \\[\\[Note]] form Crepe writes (happy)', () => {
    expect(wikiTargets('\\[\\[Note]]')).toEqual(['Note']);
  });

  it('returns [] for empty string (edge)', () => {
    expect(wikiTargets('')).toEqual([]);
  });

  it('returns [] for null (edge)', () => {
    expect(wikiTargets(null)).toEqual([]);
  });

  it('returns [] when there are no links (edge)', () => {
    expect(wikiTargets('just plain text, no brackets')).toEqual([]);
  });

  it('skips a blank [[ ]] target (edge)', () => {
    expect(wikiTargets('[[]]')).toEqual([]);
    expect(wikiTargets('[[ ]]')).toEqual([]);
  });

  it('does not match a link that spans a newline (edge)', () => {
    expect(wikiTargets('[[a\nb]]')).toEqual([]);
  });
});

describe('linksTo', () => {
  it('matches case-insensitively (happy)', () => {
    expect(linksTo('see [[Nephron]]', 'nephron')).toBe(true);
  });

  it('returns false when there are no links (edge)', () => {
    expect(linksTo('no links here', 'x')).toBe(false);
  });

  it('returns false when no link target matches (edge)', () => {
    expect(linksTo('[[A]]', 'b')).toBe(false);
  });
});

describe('rewriteLinkTargets', () => {
  it('rewrites [[Old]] to [[New]] (happy)', () => {
    expect(rewriteLinkTargets('[[Old]]', 'Old', 'New')).toBe('[[New]]');
  });

  it('preserves a |alias when rewriting (happy)', () => {
    expect(rewriteLinkTargets('[[Old|shown]]', 'Old', 'New')).toBe('[[New|shown]]');
  });

  it('leaves a non-matching target unchanged (edge)', () => {
    expect(rewriteLinkTargets('[[Other]]', 'Old', 'New')).toBe('[[Other]]');
  });

  it('still rewrites the escaped \\[\\[Old]] form (edge)', () => {
    expect(rewriteLinkTargets('\\[\\[Old]]', 'Old', 'New')).toBe('\\[\\[New]]');
  });

  it('is case-insensitive on the target (edge)', () => {
    expect(rewriteLinkTargets('[[old]]', 'OLD', 'New')).toBe('[[New]]');
  });

  it('returns the original reference when nothing changed (edge)', () => {
    const s = 'no links at all';
    expect(rewriteLinkTargets(s, 'Old', 'New')).toBe(s);
  });
});
