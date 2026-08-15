import { describe, it, expect } from 'vitest';
import { mdToHtml, _mdInline } from '../../core/markdown.js';

describe('mdToHtml (happy)', () => {
  it('renders **bold** as <strong>', () => {
    expect(mdToHtml('**bold**')).toContain('<strong>bold</strong>');
  });

  it('renders a bullet list as <ul> with two <li>', () => {
    const out = mdToHtml('- a\n- b');
    expect(out).toContain('<ul>');
    expect(out.match(/<li>/g)).toHaveLength(2);
  });

  it('renders # Title as an <h1>', () => {
    expect(mdToHtml('# Title')).toContain('<h1>Title</h1>');
  });

  it('renders a GFM table with md-table class, header cell and body cell', () => {
    const out = mdToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(out).toContain('<table class="md-table">');
    expect(out).toContain('<th>A</th>');
    expect(out).toContain('<td>1</td>');
  });
});

describe('_mdInline (happy)', () => {
  it('renders `code` as <code>', () => {
    expect(_mdInline('`code`')).toContain('<code>code</code>');
  });

  it('renders [[Nephron]] as a wikilink span', () => {
    const out = _mdInline('see [[Nephron]]');
    expect(out).toContain('wikilink');
    expect(out).toContain('Nephron');
  });
});

describe('mdToHtml / _mdInline (edge)', () => {
  it('returns "" for empty input', () => {
    expect(mdToHtml('')).toBe('');
  });

  it('returns "" for null input', () => {
    expect(mdToHtml(null)).toBe('');
  });

  it('does NOT turn a pipe line without a separator row into a table', () => {
    const out = mdToHtml('| just | text |');
    expect(out).not.toContain('<table');
  });

  it('escapes raw HTML in mdToHtml', () => {
    const out = mdToHtml('<script>x');
    expect(out).toContain('&lt;');
    expect(out).not.toContain('<script>');
  });

  it('escapes raw HTML in _mdInline', () => {
    expect(_mdInline('<b>')).toContain('&lt;');
  });

  it('strips the {!#hex} callout-colour marker (never leaks as literal text)', () => {
    // empty callout — the marker is the ONLY content; must not render as text
    const empty = mdToHtml('> {!#f59e0b} ');
    expect(empty).not.toContain('{!');
    expect(empty).toContain('callout-colored');
    expect(empty).toContain('--callout:#f59e0b');
    // callout with text — marker stripped, text kept, colour applied
    const withText = mdToHtml('> {!#3b82f6} Hello');
    expect(withText).not.toContain('{!');
    expect(withText).toContain('>Hello</blockquote>');
    // a plain blockquote is untouched
    expect(mdToHtml('> normal')).toContain('<blockquote>normal</blockquote>');
  });
});
