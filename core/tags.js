// Tag helpers — pure, UMD (Node + browser). Tags are stored in note frontmatter as a
// comma-separated string (`tags: a, b, c`), unchanged, so this is fully back-compatible;
// these helpers just parse that into chips and back. Case-insensitive de-dupe keeps the
// FIRST spelling seen (so "Exam" and "exam" collapse to one chip, not two).
function parseTags(str){
  if (Array.isArray(str)) str = str.join(',');
  const seen = new Set();
  const out = [];
  String(str || '').split(',').forEach((raw) => {
    const t = raw.trim().replace(/^#/, '');           // tolerate a leading # (Obsidian style)
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k); out.push(t);
  });
  return out;
}
function serializeTags(arr){
  return parseTags((arr || []).join(',')).join(', ');   // normalise + de-dupe on the way out
}
// Union of every note's tags (rows = [{ tags }]) → one sorted, de-duped pool for autocomplete.
function tagPoolFromRows(rows){
  const seen = new Set();
  const out = [];
  (rows || []).forEach((r) => parseTags(r && r.tags).forEach((t) => {
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }));
  out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return out;
}
// Suggestions for the current input: pool entries that START WITH / contain the query and
// aren't already applied. Prefix matches rank before substring matches. `limit` caps the list.
function suggestTags(pool, query, applied, limit){
  const q = String(query || '').trim().toLowerCase().replace(/^#/, '');
  const used = new Set((applied || []).map((t) => String(t).toLowerCase()));
  const avail = (pool || []).filter((t) => !used.has(String(t).toLowerCase()));
  if (!q) return avail.slice(0, limit || 8);
  const pre = [], sub = [];
  avail.forEach((t) => {
    const l = t.toLowerCase();
    if (l.startsWith(q)) pre.push(t);
    else if (l.indexOf(q) >= 0) sub.push(t);
  });
  return pre.concat(sub).slice(0, limit || 8);
}

// File-unique name: browser loads core/*.js in one shared script scope (a bare `_api`
// would collide with aicaps.js).
const _tagsApi = { parseTags, serializeTags, tagPoolFromRows, suggestTags };
if (typeof module !== 'undefined' && module.exports) module.exports = _tagsApi;
if (typeof window !== 'undefined') window.CoreTags = _tagsApi;
