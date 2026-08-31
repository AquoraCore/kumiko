import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const TI = require('../../core/tagindex.js');

const rows = [
  { name: 'A/dfd.md', tags: 'exam/midterm, DFD', body: 'ใช้คู่กับ #uml ในขั้น #req-analysis\n```\n#notatag\n```\n# Heading #no\n[[#x]] http://a.b/#frag' },
  { name: 'A/is.md', tags: 'exam/final, req-analysis' },
  { name: 'B/intro.md', tags: 'crft', body: 'ดู #exam ด้วย' },
  { name: 'C/empty.md', tags: '' },
];

describe('CoreTagIndex.build', () => {
  const ix = TI.build(rows);
  it('indexes frontmatter + body tags, ancestors implied, counts per unique note', () => {
    expect(ix.tags['exam'].count).toBe(3);                 // dfd (midterm), is (final), intro (body)
    expect(ix.tags['exam'].children).toEqual(['exam/final', 'exam/midterm']);
    expect(ix.tags['exam/midterm'].notes).toEqual(['A/dfd.md']);
    expect(ix.tags['uml'].sources.body).toBe(1);
    expect(ix.byNote['A/dfd.md'].map((x) => x.name + ':' + x.source)).toEqual(['exam/midterm:front', 'DFD:front', 'uml:body', 'req-analysis:body']);
    expect(ix.roots).toEqual(['crft', 'dfd', 'exam', 'req-analysis', 'uml']);
    expect(ix.byNote['C/empty.md']).toEqual([]);
  });
  it('bodyTags ignores code, headings, links, url fragments, bare numbers', () => {
    expect(TI.bodyTags('a #one, #two/x. `#code` #123 http://x/#frag [[#wl]]\n# H #h')).toEqual(['one', 'two/x']);
    expect(TI.bodyTags('ภาษาไทย #สอบ/กลางภาค ด้วย')).toEqual(['สอบ/กลางภาค']);
  });
  it('hue is stable and shared across a family; key is case-insensitive', () => {
    expect(TI.hueOf('exam')).toBe(TI.hueOf('Exam/midterm'));
    expect(TI.hueOf('exam')).toBeGreaterThanOrEqual(0); expect(TI.hueOf('exam')).toBeLessThan(6);
    expect(ix.tags['dfd'].name).toBe('DFD');             // first spelling kept, key lowercased
  });
  it('family + filterNotes (AND default, OR optional)', () => {
    expect(TI.family(ix, 'exam').sort()).toEqual(['exam', 'exam/final', 'exam/midterm']);
    expect(TI.filterNotes(ix, ['exam'])).toEqual(['A/dfd.md', 'A/is.md', 'B/intro.md']);
    expect(TI.filterNotes(ix, ['exam', 'req-analysis'])).toEqual(['A/dfd.md', 'A/is.md']);
    expect(TI.filterNotes(ix, ['crft', 'dfd'], 'or')).toEqual(['A/dfd.md', 'B/intro.md']);
    expect(TI.filterNotes(ix, [])).toEqual([]);
  });
  it('summary is a compact one-liner for the AI prompt', () => {
    expect(TI.summary(ix)).toBe('crft 1 · DFD 1 · exam 3 (final 1, midterm 1) · req-analysis 2 · uml 1');
  });
});

describe('write plans', () => {
  it('renamePlan moves a family root and its descendants; empty `to` removes', () => {
    const plan = TI.renamePlan(rows, 'exam', 'สอบ');
    expect(plan).toEqual([
      { name: 'A/dfd.md', bodyHits: 0, tags: 'สอบ/midterm, DFD' },
      { name: 'A/is.md', bodyHits: 0, tags: 'สอบ/final, req-analysis' },
      { name: 'B/intro.md', bodyHits: 1, body: 'ดู #สอบ ด้วย' },          // body-only hit follows the rename
    ]);
    expect(TI.renamePlan(rows, 'EXAM/midterm', '')).toEqual([{ name: 'A/dfd.md', bodyHits: 0, tags: 'DFD' }]);
    expect(TI.renamePlan(rows, 'nothing', 'x')).toEqual([]);
  });
  it('addTags / removeTags de-dupe case-insensitively', () => {
    expect(TI.addTags('exam, DFD', 'dfd, new')).toBe('exam, DFD, new');
    expect(TI.removeTags('exam/midterm, DFD', 'dfd')).toBe('exam/midterm');
  });
});

describe('tag system wiring (renderer / main / web / chat)', () => {
  const fs = require('fs'), path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
  it('both shells load core/tagindex.js + renderer/tagsys.js and have #tagView; noteTable rows carry bodyTags on BOTH platforms', () => {
    for (const f of ['renderer/index.html', 'web/index.html']) {
      const h = read(f);
      expect(h).toMatch(/core\/tagindex\.js/); expect(h).toMatch(/tagsys\.js/); expect(h).toMatch(/<div id="tagView" class="main-view"><\/div>/);
      expect(h.indexOf('tagsys.js')).toBeLessThan(h.indexOf('renderer.js"') > 0 ? h.indexOf('renderer.js"') : h.indexOf('renderer.js?'));
    }
    expect(read('main.js')).toMatch(/bodyTags=_tagIndex\.bodyTags\(/);
    expect(read('web/api-web.js')).toMatch(/bodyTags = \(window\.CoreTagIndex \? window\.CoreTagIndex\.bodyTags\(/);
  });
  it('renderer: sidebar tag section + filter, tag view in setMainView, verbs + prompt line, save → index refresh', () => {
    const js = read('renderer/renderer.js');
    expect(js).toMatch(/sbGroup\('tags', 'hash', t\('แท็ก'\)/);
    expect(js).toMatch(/renderFilteredNotes\(n\.body\)/);
    expect(js).toMatch(/left\.classList\.toggle\('view-tag', v==='tag'\)/);
    expect(js).toMatch(/if \(acts\.tagWrites && typeof runTagVerbs === 'function'\)/);
    expect(js).toMatch(/buildTagToolResults\(acts\)/);
    expect(js).toMatch(/===LIST-TAGS===/); expect(js).toMatch(/===ADD-TAGS name=/); expect(js).toMatch(/===RENAME-TAG from=/);
    expect(js).toMatch(/tagPromptLine\(\)/);
    expect(js).toMatch(/window\.__tagIxTimer = setTimeout\(\(\) => \{ tagIndexChanged\(\); \}, 600\)/);
    expect(js).toMatch(/lastOpen\.view === 'tag' && lastOpen\.tag/);
    // props bar: coloured chips via the shared element, body-tag ghosts, + button
    expect(js).toMatch(/const chip = tagChipEl\(tg, \{ onX: \(\) => removeAt\(i\)/);
    expect(js).toMatch(/function refreshGhosts\(\)/);
    expect(js).toMatch(/addBtn\.className = 'tg-add'/);
    expect(read('renderer/sidebar.js')).toMatch(/await refreshTagIndex\(true\)/);
    expect(read('renderer/chat.js')).toMatch(/🏷 /);
  });
  it('tagsys: vault-wide writes go through a confirm that names the count; AI writes respect the KUMIKO guard', () => {
    const ts = read('renderer/tagsys.js');
    expect(ts).toMatch(/confirmDelete\(label \+ '\\n' \+ detail/);
    expect(ts).toMatch(/if \(_aiProtectedName\(w\.name\)\) \{ _aiProtectToast\(\); continue; \}/);
    expect(ts).toMatch(/function tagPromptLine\(\)/);
    expect(ts).toMatch(/TI\.filterNotes\(ix, window\.__tagFilter\)/);
  });
});

describe('renameInBody + renamePlan with bodies (body #tags follow a rename)', () => {
  it('rewrites word-bounded #from and #from/child outside code/links/headings/urls', () => {
    const md = 'ดู #exam และ #exam/final แต่ไม่ใช่ #examples\n`#exam` ```\n#exam\n``` [[#exam]] [x](http://a/#exam) https://b/#exam\n# หัวข้อ #exam\n(#exam) [#Exam]';
    const r = TI.renameInBody(md, 'exam', 'สอบ');
    expect(r.count).toBe(4);   // #exam · #exam/final · (#exam) · [#Exam]
    expect(r.text).toBe('ดู #สอบ และ #สอบ/final แต่ไม่ใช่ #examples\n`#exam` ```\n#exam\n``` [[#exam]] [x](http://a/#exam) https://b/#exam\n# หัวข้อ #exam\n(#สอบ) [#สอบ]');
  });
  it('removing (empty `to`) keeps the word, drops the #', () => {
    expect(TI.renameInBody('ก่อน #exam/final จบ', 'exam', '')).toEqual({ text: 'ก่อน exam/final จบ', count: 1 });
    expect(TI.renameInBody('ไม่มี', 'exam', 'x')).toEqual({ text: 'ไม่มี', count: 0 });
  });
  it('renamePlan reports frontmatter + body changes separately; body can be opted out', () => {
    const rows2 = [
      { name: 'a.md', tags: 'exam/midterm', body: 'x #exam y' },
      { name: 'b.md', tags: '', body: 'only body #exam' },
      { name: 'c.md', tags: 'exam', body: 'no hashtag here' },
      { name: 'd.md', tags: 'other', body: '#other' },
    ];
    const plan = TI.renamePlan(rows2, 'exam', 'สอบ');
    expect(plan).toEqual([
      { name: 'a.md', bodyHits: 1, tags: 'สอบ/midterm', body: 'x #สอบ y' },
      { name: 'b.md', bodyHits: 1, body: 'only body #สอบ' },
      { name: 'c.md', bodyHits: 0, tags: 'สอบ' },
    ]);
    expect(TI.renamePlan(rows2, 'exam', 'สอบ', { body: false }).map((p) => p.name)).toEqual(['a.md', 'c.md']);
    // rows without bodies (old callers) never get a body field
    expect(TI.renamePlan(rows.map((r) => ({ name: r.name, tags: r.tags })), 'exam', 'สอบ').every((p) => p.body === undefined)).toBe(true);
  });
});

describe('rename flow: bodies + counts + undo snapshot', () => {
  const fs = require('fs'), path = require('path');
  const ts = fs.readFileSync(path.join(__dirname, '../../renderer/tagsys.js'), 'utf8');
  it('every vault-wide flow (rename/merge/remove/AI RENAME-TAG) plans with bodies; confirm shows header vs body counts; snapshot enables undo', () => {
    expect((ts.match(/renamePlan\(await tagRowsWithBodies\(\)/g) || []).length).toBe(4);
    expect(ts).toMatch(/const fmN = plan\.filter\(\(p\) => p\.tags !== undefined\)\.length;/);
    expect(ts).toMatch(/const bodyN = plan\.reduce\(\(n, p\) => n \+ \(p\.bodyHits \|\| 0\), 0\);/);
    expect(ts).toMatch(/snap\.files\.push\(\{ name: p\.name, before: raw \}\)/);
    expect(ts).toMatch(/vsSet\(TAG_UNDO_KEY, snap\)/);
    expect(ts).toMatch(/action: \{ label: t\('เลิกทำ'\), fn: undoTagRename \}/);
    expect(ts).toMatch(/async function undoTagRename\(\)/);
  });
});

describe('autolink suggests existing tags too', () => {
  const fs = require('fs'), path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  it('prompt carries the tag list + two result kinds; app-side filter: must exist, not already on the note, ≤3', () => {
    expect(js).toMatch(/แท็กที่มีอยู่ \(ชื่อ จำนวนโน้ต — ใช้ได้เฉพาะจากรายการนี้ ห้ามแต่งใหม่\)/);
    expect(js).toMatch(/\{"type":"tag","tag":"<แท็กจากรายการ>","reason"/);
    expect(js).toMatch(/if \(!autolinkTagSet\.has\(k\) \|\| curTags\.has\(k\) \|\| seenTag\.has\(k\)\) return false;/);
    expect(js).toMatch(/\}\)\.slice\(0, 3\);/);
    expect(js).toMatch(/renderAutolinkBar\(valid, tagSugs\)/);
    expect(js).toMatch(/async function addSuggestedTags\(tags\)/);
    expect(js).toMatch(/await insertLinks\(sugs\); await addSuggestedTags\(tgs\); clearAutolink\(\);/);
  });
  it('autolink bar colours follow the theme (no pinned hexes)', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
    const seg = css.slice(css.indexOf('#autolinkBar {'), css.indexOf('.al-empty {'));
    expect(seg).not.toMatch(/#[0-9a-f]{6}/i);
  });
});
