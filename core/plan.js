// Kumiko Plan Mode — pure plan-note logic (UMD, Node + browser). A plan is a REAL markdown
// note "KUMIKO-PLAN — <title>.md" the user can open and edit by hand; the AI's PLAN-STEP
// verbs and the UI's skip/pause buttons both go through applyStepUpdate so the file is the
// single source of truth. Grammar mirrors the checkbox statuses the note already uses:
//   - [ ] todo · - [>] doing · - [x] done · - [!] blocked (with optional " — note" suffix)
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CorePlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var PLAN_ROUND_CAP = 12;

  var STATUS_BY_MARK = { ' ': 'todo', '>': 'doing', 'x': 'done', 'X': 'done', '!': 'blocked' };
  var MARK_BY_STATUS = { todo: ' ', doing: '>', done: 'x', blocked: '!' };

  // `- [x] ขั้นที่เสร็จ — โน้ตสั้น` → { text, status, note }. Non-checkbox lines are skipped;
  // the note (when present) splits at the LAST " — " so step text may itself contain a dash.
  function parsePlan(md) {
    var lines = String(md == null ? '' : md).split('\n');
    var title = '', steps = [];
    for (var i = 0; i < lines.length; i++) {
      var h = lines[i].match(/^#\s+(.*)$/);
      if (h && !title) { title = h[1].trim(); continue; }
      var m = lines[i].match(/^[ \t]*-\s\[([ xX>!])\]\s?(.*)$/);
      if (!m) continue;   // prose/garbage lines around the checklist are ignored
      var rest = m[2].trim();
      var text = rest, note = '';
      var cut = rest.lastIndexOf(' — ');
      if (cut > 0) { text = rest.slice(0, cut).trim(); note = rest.slice(cut + 3).trim(); }
      steps.push({ text: text, status: STATUS_BY_MARK[m[1]], note: note });
    }
    return { title: title, steps: steps };
  }

  function serializePlan(plan) {
    var p = plan || {};
    var out = p.title ? '# ' + p.title + '\n\n' : '';
    (p.steps || []).forEach(function (st) {
      var mark = MARK_BY_STATUS[st.status] || ' ';
      var line = '- [' + mark + '] ' + String(st.text == null ? '' : st.text);
      if (st.note) line += ' — ' + st.note;
      out += line + '\n';
    });
    return out;
  }

  // Immutable step update (n is 1-based). Unknown status / n out of range → the SAME plan
  // object back (callers compare identity to know nothing changed). Marking done/blocked
  // clears that step's doing state by replacement; OTHER steps keep their statuses as-is.
  function applyStepUpdate(plan, n, status, note) {
    var p = plan || {};
    var steps = p.steps || [];
    if (!MARK_BY_STATUS[status]) return plan;
    var i = Math.floor(Number(n)) - 1;
    if (!(i >= 0 && i < steps.length)) return plan;
    var next = { title: p.title, steps: steps.map(function (st, k) {
      if (k !== i) return { text: st.text, status: st.status, note: st.note };
      return { text: st.text, status: status, note: (note === undefined || note === null) ? st.note : String(note) };
    }) };
    return next;
  }

  // doing = 1-based index of the FIRST doing step (0 when none) — the chip/card headline.
  function planProgress(plan) {
    var steps = ((plan || {}).steps) || [];
    var done = 0, blocked = 0, doing = 0;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].status === 'done') done++;
      else if (steps[i].status === 'blocked') blocked++;
      else if (steps[i].status === 'doing' && !doing) doing = i + 1;
    }
    return { done: done, total: steps.length, blocked: blocked, doing: doing };
  }

  // Round budget for the plan auto-continue loop: the first 2 rounds are free (same as the
  // plain tool loop); every round after that must have shown PLAN-STEP progress in the
  // previous round, and the hard cap always applies.
  function planAllowContinue(o) {
    o = o || {};
    var round = Number(o.round) || 0;
    var cap = (typeof o.cap === 'number' && o.cap > 0) ? o.cap : PLAN_ROUND_CAP;
    return round < cap && (round < 2 || !!o.progressed);
  }

  // Work-log entry (KUMIKO-LOG.md) for a FINISHED plan: date/title header, result line
  // (done/total, optional minutes when startedAt+endedAt are present, optional summary) and
  // EVERY step line kept verbatim as a record — real marks (blocked shows [!]), notes and
  // [[wikilinks]] intact. meta = { date, summary, startedAt?, endedAt? }.
  function planLogEntry(plan, meta) {
    var p = plan || {}; meta = meta || {};
    var prog = planProgress(p);
    var mins = 0;
    if (meta.startedAt && meta.endedAt && Number(meta.endedAt) > Number(meta.startedAt)) {
      mins = Math.max(1, Math.round((Number(meta.endedAt) - Number(meta.startedAt)) / 60000));
    }
    var out = '## ' + String(meta.date || '') + ' · ' + String(p.title || '') + '\n\n';
    out += '✓ ' + prog.done + '/' + prog.total + ' ขั้น' +
      (mins ? ' · ใช้เวลา ' + mins + ' นาที' : '') +
      (meta.summary ? ' — ' + meta.summary : '') + '\n';
    (p.steps || []).forEach(function (st) {
      var line = '- [' + (MARK_BY_STATUS[st.status] || ' ') + '] ' + String(st.text == null ? '' : st.text);
      if (st.note) line += ' — ' + st.note;
      out += line + '\n';
    });
    return out;
  }

  // Newest-first insert into the worklog: the entry goes right under the file header
  // (H1 + blank + intro line + blank). A file without that shape (hand-edited away) keeps
  // its content and gets the entry at the very top — newest still reads first.
  function planLogPrepend(cur, entry) {
    var s = String(cur == null ? '' : cur);
    if (!s.trim()) return String(entry);
    var m = s.match(/^#[^\n]*\n\n[^\n]*\n\n/);
    if (!m) return String(entry) + '\n' + s;
    return m[0] + String(entry) + '\n' + s.slice(m[0].length).replace(/^\n+/, '');
  }

  return {
    PLAN_ROUND_CAP: PLAN_ROUND_CAP,
    parsePlan: parsePlan,
    serializePlan: serializePlan,
    applyStepUpdate: applyStepUpdate,
    planProgress: planProgress,
    planAllowContinue: planAllowContinue,
    planLogEntry: planLogEntry,
    planLogPrepend: planLogPrepend
  };
});
