// Shared core: markdown -> HTML (display only). UMD: Node (module.exports) + browser (window.CoreMarkdown).
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CoreMarkdown = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  // lightweight markdown -> HTML for the AI review preview (display only, so it reads as rich text not raw .md)
  function _mdEsc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function _mdInline(s){
    s = _mdEsc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\\?\[\\?\[([^\[\]|\n]+?)(?:\|([^\[\]\n]+?))?\\?\]\\?\]/g, (m,a,b)=> '<span class="wikilink">'+(b||a)+'</span>');   // tolerates \[\[escaped]] links
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<span class="mdlink">$1</span>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    return s;
  }
  // split a single table row line into trimmed cells, dropping optional leading/trailing pipes
  function _mdRowCells(line){
    let s = line.trim();
    s = s.replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map((c) => c.trim());
  }
  // GFM separator cell: dashes with optional leading/trailing colons, e.g. ":---:", "---", "---:"
  function _isMdSepCell(c){ return /^[ ]?:-{1,}:[ ]?$/.test(c) || /^[ ]?:?-+:?[ ]?$/.test(c); }
  function mdToHtml(md){
    const lines = String(md == null ? '' : md).split('\n');
    let html = '', listType = null;
    const closeList = () => { if (listType){ html += '</'+listType+'>'; listType = null; } };
    // a line that looks like a table row: has a pipe and at least one non-space cell char
    const isPipeRow = (l) => l.includes('|') && l.replace(/[|\s]/g,'').length > 0;
    for (let i = 0; i < lines.length; ){
      const line = lines[i];
      if (/^\s*$/.test(line)){ closeList(); i++; continue; }
      // ---- GFM table: header row + separator row + 0+ body rows ----
      if (isPipeRow(line) && i + 1 < lines.length){
        const sepCells = _mdRowCells(lines[i + 1]);
        if (sepCells.length >= 1 && sepCells.every(_isMdSepCell)){
          closeList();
          html += '<table class="md-table"><thead><tr>';
          _mdRowCells(line).forEach((c) => { html += '<th>' + _mdInline(c) + '</th>'; });
          html += '</tr></thead><tbody>';
          let k = i + 2;
          while (k < lines.length && isPipeRow(lines[k])){
            html += '<tr>';
            _mdRowCells(lines[k]).forEach((c) => { html += '<td>' + _mdInline(c) + '</td>'; });
            html += '</tr>';
            k++;
          }
          html += '</tbody></table>';
          i = k;
          continue;
        }
      }
      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))){ closeList(); const lvl = m[1].length; html += '<h'+lvl+'>'+_mdInline(m[2])+'</h'+lvl+'>'; i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)){ closeList(); html += '<hr>'; i++; continue; }
      if (/^\s*[-*+]\s+/.test(line)){ if (listType !== 'ul'){ closeList(); html += '<ul>'; listType = 'ul'; } html += '<li>'+_mdInline(line.replace(/^\s*[-*+]\s+/,''))+'</li>'; i++; continue; }
      if (/^\s*\d+\.\s+/.test(line)){ if (listType !== 'ol'){ closeList(); html += '<ol>'; listType = 'ol'; } html += '<li>'+_mdInline(line.replace(/^\s*\d+\.\s+/,''))+'</li>'; i++; continue; }
      if (/^\s*>\s?/.test(line)){
        closeList();
        // Callout colour marker `{!#hex}` (see the Milkdown callout-colour plugin): strip it
        // from the rendered text and apply the colour — otherwise it leaks as literal text in
        // previews / AI context, most visibly on an empty callout where it's the only content.
        let inner = line.replace(/^\s*>\s?/, '');
        let attr = '';
        const cm = /^\{!(#[0-9a-fA-F]{3,8})\} ?/.exec(inner);
        if (cm){ inner = inner.slice(cm[0].length); attr = ' class="callout-colored" style="--callout:' + cm[1] + '"'; }
        html += '<blockquote' + attr + '>' + _mdInline(inner) + '</blockquote>'; i++; continue;
      }
      closeList(); html += '<p>'+_mdInline(line)+'</p>'; i++;
    }
    closeList();
    return html;
  }
  return { mdToHtml: mdToHtml, _mdInline: _mdInline, _mdEsc: _mdEsc };
});
