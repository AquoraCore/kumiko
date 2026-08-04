// ---- wikilink scanning ----------------------------------------------------
// Crepe escapes brackets when it serializes markdown, so a link on disk can be
// [[Note]] OR `\[\[Note]]`. It may also carry an alias: [[Target|shown]].
function wikiTargets(text){
  const re = /\\?\[\\?\[([^\[\]\n]+?)\\?\]\\?\]/g;
  const out = []; let m;
  while ((m = re.exec(text || ''))) {
    const t = String(m[1]).split('|')[0].trim();
    if (t) out.push(t);
  }
  return out;
}
function linksTo(text, base){
  const b = String(base).toLowerCase();
  return wikiTargets(text).some((t) => t.toLowerCase() === b);
}
// Rewrite every wikilink whose (trimmed) target equals oldBase (case-insensitive)
// to newBase. Same tolerant regex as wikiTargets(): tolerates `\[\[escaped]]` and
// `[[target|alias]]`. Preserves bracket/escape form, |alias, and surrounding
// whitespace. Whole-target only (the regex captures the full inner token, so the
// equality check can never match a substring of a longer word). Returns the
// original string if nothing changed so callers can skip the write.
function rewriteLinkTargets(text, oldBase, newBase){
  const re = /\\?\[\\?\[([^\[\]\n]+?)\\?\]\\?\]/g; // identical to wikiTargets()
  const oldLower = oldBase.toLowerCase();
  let changed = false;
  const out = text.replace(re, (whole, inner) => {
    const at = inner.indexOf('|');
    const targetRaw = at >= 0 ? inner.slice(0, at) : inner;
    const lead = targetRaw.search(/\S|$/);          // preserve leading whitespace
    const target = targetRaw.trim();                // resolver trims, so match trimmed
    if (target.toLowerCase() !== oldLower) return whole;
    const alias = at >= 0 ? inner.slice(at) : '';   // keep |alias verbatim
    const newInner = targetRaw.slice(0, lead) + newBase + targetRaw.slice(lead + target.length) + alias;
    const i = whole.indexOf(inner);                 // splice inside the original brackets/escapes
    if (i < 0) return whole;
    changed = true;
    return whole.slice(0, i) + newInner + whole.slice(i + inner.length);
  });
  return changed ? out : text;
}

module.exports = { wikiTargets, linksTo, rewriteLinkTargets };
if (typeof window !== 'undefined') { window.CoreWikilinks = { wikiTargets, linksTo, rewriteLinkTargets }; }
