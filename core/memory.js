// Memory layer — pure, UMD (Node + browser). The per-vault fact store the AI reads on every
// question: KUMIKO-MEMORY.md holds one memory per list line; this module parses/serializes it,
// decides which cards get INJECTED (profile always, others scored against the question), and
// enforces the injection budget. Distinct from KUMIKO.md (rules = how to behave): memory =
// what the AI knows about THIS vault. Never touches disk — callers read/save the file.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CoreMemory = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var TYPES = ['user', 'subject', 'ref', 'state'];
  var TYPE_TH = { user: 'ผู้ใช้', subject: 'วิชา', ref: 'อ้างอิง', state: 'สถานะ' };
  var TH_TYPE = { 'ผู้ใช้': 'user', 'วิชา': 'subject', 'อ้างอิง': 'ref', 'สถานะ': 'state' };
  var FADE_DAYS = 90;      // older than this → stops being injected until re-confirmed
  var BUDGET = 1200;       // max chars injected per question (KUMIKO.md rules keep their own 2000)
  var MAX_RELEVANT = 4;

  function _id(type, text) {
    var s = type + '|' + text, h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'm' + (h >>> 0).toString(36);
  }
  function normType(t) {
    t = String(t || '').trim();
    if (TYPES.indexOf(t) >= 0) return t;
    if (TH_TYPE[t]) return TH_TYPE[t];
    return 'subject';
  }
  // Auto-detect a card's type from its text (Thai + English cues). Order matters — most
  // specific first, and the course-fact cues (อาจารย์/สอบ/ส่งงาน…) are checked BEFORE the
  // user-preference cues: user-type routes to the GLOBAL cross-vault profile, so a course
  // fact misread as "user" is the costly mistake ("อาจารย์ให้ส่งงานทาง X" must stay in-vault).
  var DETECT = [
    ['state',   /อ่านถึง|ทำถึง|ถึงหน้า|ค้างอยู่|ทำค้าง|ยังไม่ได้|ยังไม่จบ|ยังไม่สรุป|กำลังอ่าน|กำลังทำ|อ่านล่าสุด|ไปถึง/],
    ['subject', /อาจารย์|ครูสอน|ครูให้|สอบ|ควิซ|quiz|midterm|final|กำหนดส่ง|เดดไลน์|deadline|คะแนน|เน้นบท|ออกข้อสอบ|ออกสอบ|ส่งงาน|การบ้าน|รายงาน|กลุ่ม|คาบ|เทอม|วิชานี้สอน/],
    ['ref',     /\[\[|https?:\/\/|\.pdf|เล่มหลัก|หนังสือ|สไลด์|ชีท|ไฟล์|เอกสาร|chapter|แหล่งอ้างอิง|ดูจาก/],
    ['user',    /ชอบ|ไม่ชอบ|อยากได้|อยากให้|ขอให้|ขอเป็น|สไตล์|โทน|เสมอ|ทุกครั้ง|ประจำ|ตอบสั้น|ตอบยาว|ภาษาไทย|ภาษาอังกฤษ|ตัวอย่างประกอบ|ตาราง|mnemonic|ฉันเป็น|ผมเป็น/]
  ];
  function detectType(text) {
    var s = String(text || '');
    for (var i = 0; i < DETECT.length; i++) if (DETECT[i][1].test(s)) return DETECT[i][0];
    return 'subject';
  }
  // Trust an explicit valid type; anything missing/unknown falls back to detection.
  function normTypeOr(t, text) {
    t = String(t || '').trim();
    if (TYPES.indexOf(t) >= 0) return t;
    if (TH_TYPE[t]) return TH_TYPE[t];
    return detectType(text);
  }
  function _mkCard(type, text, ts) {
    var tp = normType(type);
    var tx = String(text || '').replace(/\s*\n\s*/g, ' ').trim().slice(0, 300);
    return tx ? { id: _id(tp, tx), type: tp, text: tx, ts: ts || '' } : null;
  }

  // FILE FORMAT — human-first so hand edits survive: "## <Thai type>" sections, one memory per
  // "- text <!--k YYYY-MM-DD-->" line. A hand-added line without the stamp gets today's date on
  // the next serialize. Unknown section headings fall back to วิชา.
  function parse(md, today) {
    var cards = [], type = 'subject';
    String(md || '').split(/\r?\n/).forEach(function (line) {
      var h = line.match(/^##\s+(.+)$/);
      if (h) { type = normType(h[1].trim()); return; }
      var m = line.match(/^[-*]\s+(.+)$/);
      if (!m) return;
      var body = m[1], ts = today || '';
      var c = body.match(/<!--k\s+(\d{4}-\d{2}-\d{2})\s*-->/);
      if (c) { ts = c[1]; body = body.replace(/<!--k[\s\S]*?-->/, ''); }
      var card = _mkCard(type, body, ts);
      if (card) cards.push(card);
    });
    return cards;
  }
  function serialize(cards) {
    var out = '# ความจำของ Kumiko\n\n' +
      '> ไฟล์นี้คือความจำถาวรของ AI สำหรับ vault นี้ — ระบบคัดใบที่เกี่ยวกับคำถามส่งให้ AI ทุกครั้ง ' +
      'แก้/ลบได้ผ่านโต๊ะความจำ (🧠 ที่หัวแชต) หรือแก้ไฟล์นี้ตรง ๆ\n';
    var byType = {};
    (cards || []).forEach(function (c) { var t = normType(c.type); (byType[t] = byType[t] || []).push(c); });
    TYPES.forEach(function (t) {
      var list = byType[t];
      if (!list || !list.length) return;
      out += '\n## ' + TYPE_TH[t] + '\n\n';
      list.forEach(function (c) {
        out += '- ' + String(c.text).replace(/\s*\n\s*/g, ' ').trim() + (c.ts ? ' <!--k ' + c.ts + '-->' : '') + '\n';
      });
    });
    return out;
  }

  function ageDays(card, now) {
    if (!card || !card.ts) return 0;
    var t = Date.parse(card.ts + 'T00:00:00Z');
    if (!isFinite(t)) return 0;
    return Math.floor((now - t) / 86400000);
  }
  function isFaded(card, now, days) { return ageDays(card, now) > (days || FADE_DAYS); }

  // Relevance = char-bigram overlap (works for Thai, which has no word spaces): what fraction
  // of the QUERY's bigrams appear in the card. Cheap and good enough for tens of short cards —
  // deliberately not another embedding index.
  function _grams(s) {
    s = String(s || '').toLowerCase().replace(/\s+/g, '');
    var g = {};
    for (var i = 0; i < s.length - 1; i++) g[s.slice(i, i + 2)] = 1;
    return g;
  }
  function score(query, text) {
    var q = _grams(query), t = _grams(text), hit = 0, total = 0, k;
    for (k in q) { total++; if (t[k]) hit++; }
    return total ? hit / total : 0;
  }

  // What gets injected for this question: the GLOBAL profile (opts.profileExtra — the per-user
  // cross-vault cards, injected always and NEVER fade: identity doesn't expire), then NON-faded
  // vault user-type cards, then the rest scored against the query, top-K above a floor,
  // everything inside the char budget.
  function select(cards, query, opts) {
    opts = opts || {};
    var now = opts.now || 0;
    var live = (cards || []).filter(function (c) { return !isFaded(c, now, opts.fadeDays); });
    var profile = (opts.profileExtra || []).concat(live.filter(function (c) { return c.type === 'user'; }));
    var scored = live.filter(function (c) { return c.type !== 'user'; })
      .map(function (c) { return { c: c, s: score(query || '', c.text) }; })
      .filter(function (x) { return x.s >= (opts.minScore != null ? opts.minScore : 0.12); })
      .sort(function (a, b) { return b.s - a.s; })
      .slice(0, opts.maxRelevant || MAX_RELEVANT)
      .map(function (x) { return x.c; });
    var budget = opts.budget || BUDGET, used = 0, prof = [], rel = [];
    profile.forEach(function (c) { if (used + c.text.length <= budget) { prof.push(c); used += c.text.length; } });
    scored.forEach(function (c) { if (used + c.text.length <= budget) { rel.push(c); used += c.text.length; } });
    return { profile: prof, relevant: rel, total: live.length, chars: used };
  }
  // The block header warns the AI that cards come from the WHOLE vault (every subject), not
  // just this chat tab — with opts.tabName it also names the tab so cross-subject cards
  // ("โจทย์ Business" from CRAFT showing up in a REQ ANAL tab) get ignored, not answered.
  function promptBlock(cards, query, opts) {
    var sel = select(cards, query, opts);
    if (!sel.profile.length && !sel.relevant.length) return { text: '', ids: [], sel: sel };
    var tab = (opts && typeof opts.tabName === 'string') ? opts.tabName.trim().slice(0, 60) : '';
    var lines = [];
    if (sel.profile.length) lines.push('[ความจำ · โปรไฟล์] ' + sel.profile.map(function (c) { return c.text; }).join(' · '));
    if (sel.relevant.length) lines.push('[ความจำ · เกี่ยวกับคำถามนี้ ' + sel.relevant.length + '/' + sel.total + '] ' + sel.relevant.map(function (c) { return c.text; }).join(' · '));
    var head = 'ความจำของ vault นี้ (ข้อเท็จจริงที่ผู้ใช้ยืนยันแล้ว — เป็นความจำรวมทุกวิชา/ทุกเรื่องใน vault ไม่ใช่ของแท็บนี้อย่างเดียว)' +
      (tab ? ' แท็บสนทนานี้คือ "' + tab + '" — ใช้เฉพาะใบที่ตรงกับหัวข้อของแท็บนี้' : '') +
      ' ใบที่เป็นของวิชา/เรื่องอื่นให้เพิกเฉย ห้ามทึกทักว่าสถานะงาน/โจทย์ของวิชาอื่นเป็นของแท็บนี้ และไม่ต้องท่องความจำซ้ำให้ฟัง):\n';
    return {
      text: head + lines.join('\n') + '\n\n',
      ids: sel.profile.concat(sel.relevant).map(function (c) { return c.id; }),
      sel: sel
    };
  }

  function addCard(cards, type, text, ts) {
    var card = _mkCard(type, text, ts);
    if (!card) return cards || [];
    if ((cards || []).some(function (c) { return c.id === card.id; })) return cards || [];
    return (cards || []).concat([card]);
  }
  // Symmetric similarity for dedupe (score() alone is directional: short query vs long card).
  function similar(a, b) { return Math.max(score(a, b), score(b, a)); }
  // The PROCESSING step on every save: a new card that is a near-duplicate of an existing one
  // (same type, ≥80% bigram overlap) REPLACES it — memory updates in place instead of piling
  // up variants ("สอบ 12 ก.ย." then "สอบเลื่อนเป็น 19 ก.ย." = one card, newest wins).
  function upsertCard(cards, type, text, ts, thresh) {
    var card = _mkCard(type, text, ts);
    var list = cards || [];
    if (!card) return { cards: list, added: false, replaced: null };
    if (list.some(function (c) { return c.id === card.id; })) return { cards: list, added: false, replaced: null };
    var th = thresh || 0.8, replaced = null;
    var out = list.filter(function (c) {
      if (!replaced && c.type === card.type && similar(c.text, card.text) >= th) { replaced = c; return false; }
      return true;
    });
    out.push(card);
    return { cards: out, added: true, replaced: replaced };
  }
  // Group cards for browsing: global profile · fresh (≤14 days) · recent · old (past the fade
  // horizon — no longer injected). Newest first inside each group.
  var FRESH_DAYS = 14;
  function organize(cards, now, opts) {
    var g = { global: [], fresh: [], recent: [], old: [] };
    (cards || []).forEach(function (c) {
      if (c.g) { g.global.push(c); return; }
      if (isFaded(c, now || 0, opts && opts.fadeDays)) { g.old.push(c); return; }
      if (ageDays(c, now || 0) <= (opts && opts.freshDays || FRESH_DAYS)) g.fresh.push(c);
      else g.recent.push(c);
    });
    var by = function (a, b) { return String(b.ts || '').localeCompare(String(a.ts || '')); };
    g.global.sort(by); g.fresh.sort(by); g.recent.sort(by); g.old.sort(by);
    return g;
  }
  function removeCard(cards, id) { return (cards || []).filter(function (c) { return c.id !== id; }); }
  // FORGET matches by substring (case-insensitive) — the AI quotes part of the card's text
  function findByText(cards, text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q) return null;
    for (var i = 0; i < (cards || []).length; i++) {
      if (cards[i].text.toLowerCase().indexOf(q) >= 0) return cards[i];
    }
    return null;
  }

  return { TYPES: TYPES, TYPE_TH: TYPE_TH, FADE_DAYS: FADE_DAYS, FRESH_DAYS: FRESH_DAYS, BUDGET: BUDGET, MAX_RELEVANT: MAX_RELEVANT,
    similar: similar, upsertCard: upsertCard, organize: organize,
    normType: normType, detectType: detectType, normTypeOr: normTypeOr,
    parse: parse, serialize: serialize, ageDays: ageDays, isFaded: isFaded,
    score: score, select: select, promptBlock: promptBlock,
    addCard: addCard, removeCard: removeCard, findByText: findByText };
});
