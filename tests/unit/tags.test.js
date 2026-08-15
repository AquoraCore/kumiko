import { describe, it, expect } from 'vitest';
const T = require('../../core/tags');

describe('tag parsing / serialising (frontmatter comma string <-> chips)', () => {
  it('parses, trims, drops empties, strips a leading #, de-dupes case-insensitively', () => {
    expect(T.parseTags('สอบ, ต้องทวน , สอบ, #Exam, ,exam')).toEqual(['สอบ', 'ต้องทวน', 'Exam']);
    expect(T.parseTags('')).toEqual([]);
    expect(T.parseTags(['a', 'b', 'A'])).toEqual(['a', 'b']);
  });
  it('serialises back to a normalised comma string', () => {
    expect(T.serializeTags(['a', 'b', 'a'])).toBe('a, b');
    expect(T.serializeTags([])).toBe('');
  });
});

describe('tag pool + suggestions (autocomplete)', () => {
  it('unions every note\'s tags into one sorted, de-duped pool', () => {
    const pool = T.tagPoolFromRows([{ tags: 'x, y' }, { tags: 'y, z' }, { tags: '' }]);
    expect(pool).toEqual(['x', 'y', 'z']);
  });
  it('suggests pool entries matching the query, excluding already-applied, prefix before substring', () => {
    expect(T.suggestTags(['exam', 'example', 'preexam', 'test'], 'ex', [], 5)).toEqual(['exam', 'example', 'preexam']);
    expect(T.suggestTags(['exam', 'example'], 'ex', ['example'], 5)).toEqual(['exam']);   // applied excluded
    expect(T.suggestTags(['exam', 'test'], '', [], 5)).toEqual(['exam', 'test']);          // empty query → all
  });
});
