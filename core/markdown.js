// Shared core: markdown -> HTML (display only). UMD: Node (module.exports) + browser (window.CoreMarkdown).
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CoreMarkdown = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  // lightweight markdown -> HTML for the AI review preview (display only, so it reads as rich text not raw .md)
  function _mdEsc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function _mdInline(s){
    // CommonMark hard break: an ODD run of trailing backslashes ends in a hard break — the
    // per-line structure around here already breaks lines, so drop just that last '\'
    // (crepe serializes "i = 0\<EOL>" and every surface showed the backslash, 2026-09-13).
    // An even run is escaped-backslash pairs, rendered below as one backslash per pair.
    s = s.replace(/\\+$/, function (m) { return m.length % 2 ? m.slice(0, -1) : m; });
    s = _mdEsc(s);
    // Inline code is parked FIRST, raw — its content must display verbatim ("&#x20;" or a
    // trailing "\\" inside backticks must not be decoded/collapsed). A backtick behind an
    // ODD backslash run is escaped and never opens a span (the escape pass handles it).
    var _code = [];
    // (no lookbehind \u2014 Safari < 16.4 fails to PARSE the file otherwise; the prefix groups
    // are captured and put back so "\`not code" keeps its escaped backtick untouched)
    s = s.replace(/(^|[^\\])((?:\\\\)*)`([^`\n]+)`/g, function (_, pre, esc, body) {
      _code.push('<code>' + body + '</code>');
      return pre + esc + '\uE004' + (_code.length - 1) + '\uE005';
    });
    // CommonMark backslash escapes: the WYSIWYG editor serializes "<<extend>>" as
    // "\<\<extend\>\>" — show the character, never the backslash ("มี \ เพิ่มเข้ามา").
    // Escaped chars are parked in private-use placeholders until AFTER the formatting
    // passes, so "\*x\*" renders as literal *x*, not emphasis. (Chars are already
    // HTML-escaped here, so the entity forms are matched too.)
    var _escd = [];
    s = s.replace(/\\(&lt;|&gt;|&amp;|&quot;|[\\`*_{}\[\]()#+\-.!~|=:;,\/?@^$%'])/g, function (_, c) {   // full CommonMark escapable set — '\=' at line start (setext guard) used to survive as a visible backslash
      _escd.push(c); return '' + (_escd.length - 1) + '';
    });
    // images render as images, not stray text — and the WHOLE tag is parked in a placeholder:
    // filenames like "chapter13_69_Accounts_Payable-…" contain _…_ pairs, and the emphasis
    // pass below used to inject <em> INSIDE the src attribute (canvas/review images 404'd)
    var _prot = [];
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, url) {
      _prot.push('<img class="md-img" src="' + url + '" alt="' + alt + '">');
      return '' + (_prot.length - 1) + '';
    });

    // Space entities ONLY (crepe writes leading indent as &#x20;/&#X20;/&#32;): a LEADING
    // run — entities possibly interleaved with real spaces — becomes one &nbsp; per entity
    // so HTML cannot collapse the indent; anywhere else the entity is a plain space. No
    // other entity ever decodes: &#x3C; and friends stay escaped text (XSS guard).
    s = s.replace(/^((?:&amp;#(?:[xX]20|32);| )+)/, function (run) {
      return run.indexOf('&amp;#') < 0 ? run : run.replace(/&amp;#(?:[xX]20|32);/g, '&nbsp;');
    });
    s = s.replace(/&amp;#(?:[xX]20|32);/g, ' ');
    s = s.replace(/\{c:([a-z]+)\}([\s\S]*?)\{\/c\}/g, (m,name,inner)=> '<span class="tcolor tcolor-'+name+'">'+inner+'</span>');   // inline text colour
    s = s.replace(/\\?\[\\?\[([^\[\]|\n]+?)(?:\|([^\[\]\n]+?))?\\?\]\\?\]/g, (m,a,b)=> '<span class="wikilink">'+(b||a)+'</span>');   // tolerates \[\[escaped]] links
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<span class="mdlink">$1</span>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/\uE002(\d+)\uE003/g, function (_, i) { return _prot[+i]; });   // restore parked <img> tags first — their urls may hold escd tokens
    s = s.replace(/(\d+)/g, function (_, i) { return _escd[+i]; });   // restore escaped chars
    s = s.replace(/\uE004(\d+)\uE005/g, function (_, i) { return _code[+i]; });   // inline code LAST — its content is final, nothing may rewrite it
    return s;
  }
  // split a single table row line into trimmed cells, dropping optional leading/trailing pipes
  function _mdRowCells(line){
    let s = line.trim();
    s = s.replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map((c) => c.trim());
  }

  // ---- light fence highlighter (pure regex, runs on ALREADY-ESCAPED text — display only).
  // Safe order: park escaped entities, then comments/strings (so keywords/numbers never match
  // inside them), highlight keywords/numbers on the rest, restore. No lookbehind anywhere
  // (Safari < 16.4 fails to PARSE the file otherwise — same rule as _mdInline).
  var _HL_KW = {
    python: 'def|return|if|elif|else|for|while|in|not|and|or|import|from|class|try|except|finally|with|as|pass|break|continue|lambda|None|True|False|is|del|global|raise|yield|assert',
    js: 'var|let|const|function|return|if|else|for|while|do|switch|case|default|break|continue|new|typeof|instanceof|in|of|class|extends|super|this|import|export|from|try|catch|finally|throw|async|await|yield|null|undefined|true|false|void|delete',
    java: 'public|private|protected|static|final|class|interface|extends|implements|enum|new|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|throws|import|package|this|super|null|true|false|abstract|synchronized|record|var|instanceof|void|int|long|double|float|boolean|char|byte|short',
    c: 'int|char|float|double|void|long|short|unsigned|signed|struct|union|enum|typedef|static|extern|const|return|if|else|for|while|do|switch|case|default|break|continue|goto|sizeof|NULL',
    sql: 'select|from|where|insert|into|values|update|set|delete|create|table|drop|alter|add|join|inner|left|right|outer|full|on|as|and|or|not|null|is|in|like|between|group|by|order|having|limit|offset|union|all|distinct|count|sum|avg|min|max|primary|key|foreign|references|index|view'
  };
  _HL_KW.ts = _HL_KW.js + '|interface|type|implements|namespace|declare|readonly|public|private|protected|abstract|any|unknown|never|string|number|boolean';
  var _HL_ALIAS = { python: 'python', py: 'python', js: 'js', javascript: 'js', jsx: 'js', node: 'js',
    ts: 'ts', typescript: 'ts', tsx: 'ts', java: 'java', c: 'c', cpp: 'c', h: 'c', sql: 'sql', sqlite: 'sql' };
  function _hlLang(info){ return _HL_ALIAS[String(info || '').toLowerCase()] || null; }
  function _hlCode(esc, lang){
    var parked = [];
    var park = function (val) { parked.push(val); return '\uE012' + (parked.length - 1) + '\uE013'; };
    // 1) escaped entities — parked so their digits/# never feed the comment/number passes.
    //    A source-level entity like &#x20; escapes to TWO adjacent chunks (`&amp;` + `#x20;`)
    //    — the optional tail swallows the second chunk so its `#` can't open a comment span.
    esc = esc.replace(/&(?:amp|lt|gt);(?:[#a-zA-Z0-9]+;)?/g, park);
    // 2) comments + strings, leftmost-first: anything they consume can never match as keyword
    var parts = ["'(?:[^'\\\\\\n]|\\\\.)*'", '"(?:[^"\\\\\\n]|\\\\.)*"', '\\/\\/[^\\n]*'];
    if (lang !== 'js' && lang !== 'ts' && lang !== 'java' && lang !== 'c') parts.push('#[^\\n]*');
    esc = esc.replace(new RegExp(parts.join('|'), 'g'), function (m) {
      return park('<span class="' + ((m.charAt(0) === '\'' || m.charAt(0) === '"') ? 'tok-s' : 'tok-c') + '">' + m + '</span>');
    });
    // 3) keywords (known languages) + numbers on what is left
    if (lang && _HL_KW[lang]){
      esc = esc.replace(new RegExp('(^|[^A-Za-z0-9_$\\uE012\\uE013])(' + _HL_KW[lang] + ')(?![A-Za-z0-9_$\\uE012\\uE013])', 'g'),
        function (_, pre, w) { return pre + '<span class="tok-k">' + w + '</span>'; });
    }
    esc = esc.replace(/(^|[^A-Za-z0-9_$.\uE012\uE013])(\d+(?:\.\d+)?)(?![A-Za-z0-9_$\uE012\uE013])/g,
      function (_, pre, n) { return pre + '<span class="tok-n">' + n + '</span>'; });
    // 4) restore (looped: a parked string may itself hold a parked entity)
    var guard = 0;
    while (/\uE012\d+\uE013/.test(esc) && guard++ < 5){
      esc = esc.replace(/\uE012(\d+)\uE013/g, function (_, i) { return parked[+i]; });
    }
    return esc;
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
      // ---- fenced code block: three backticks + lang. Mermaid emits a placeholder the PDF
      // preview upgrades to a live diagram; other languages render as a proper code block. ----
      const fm = /^```[ \t]*([A-Za-z0-9_-]*)[ \t]*$/.exec(line);
      if (fm){
        closeList();
        let k = i + 1; const buf = [];
        while (k < lines.length && !/^```\s*$/.test(lines[k])) { buf.push(lines[k]); k++; }
        const code = buf.join('\n');
        const escAttr = (x) => _mdEsc(x).replace(/"/g, '&quot;');
        if ((fm[1] || '').toLowerCase() === 'mermaid') {
          html += '<pre class="md-mermaid-src" data-mmd="' + escAttr(code) + '">' + _mdEsc(code) + '</pre>';
        } else {
          // R2 "code studio": bar with the language label + copy button over a sumi panel.
          // Label = uppercase of the info string's first token; body is highlighted ON the
          // escaped text (highlight never sees raw markup — no XSS surface).
          const label = fm[1] ? _mdEsc(fm[1].toUpperCase()) : 'CODE';
          html += '<div class="md-codewrap"><div class="md-codebar"><span class="md-lang">' + label +
            '</span><button type="button" class="md-copy" title="คัดลอกโค้ด">⧉</button></div>' +
            '<pre class="md-code"><code>' + _hlCode(_mdEsc(code), _hlLang(fm[1])) + '</code></pre></div>';
        }
        i = k + 1;   // skip the closing fence (or EOF)
        continue;
      }
      // ---- GFM table: header row + separator row + 0+ body rows · headerless form: the
      // first row is ALL empty cells (`| | |`, `||`) — render tbody only, no thead. ----
      const headerlessRow = (l) => l.includes('|') && _mdRowCells(l).every((c) => !c);
      if ((isPipeRow(line) || headerlessRow(line)) && i + 1 < lines.length){
        const sepCells = _mdRowCells(lines[i + 1]);
        if (sepCells.length >= 1 && sepCells.every(_isMdSepCell)){
          closeList();
          if (!headerlessRow(line)){
            html += '<table class="md-table"><thead><tr>';
            _mdRowCells(line).forEach((c) => { html += '<th>' + _mdInline(c) + '</th>'; });
            html += '</tr></thead>';
          } else {
            html += '<table class="md-table">';
          }
          html += '<tbody>';
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
  // Unwrap a single ```markdown … ``` (or bare ``` … ```) fence that an AI wraps a whole-note
  // reply in, so "แทนที่ทั้งโน้ต" applies the note body, not a literal code block. Only strips
  // when the ENTIRE trimmed text is one fence — inline/partial code fences are left untouched.
  function stripMdFence(text){
    var s = String(text == null ? '' : text).trim();
    var m = s.match(/^```[ \t]*(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
    return m ? m[1].trim() : s;
  }
  // The AI signals "this reply IS an edit of the open note" by wrapping the complete revised note
  // between these markers. Line-delimited (not a ``` fence) so a note containing code fences still
  // parses. Deliberately product-name-free so renaming the app never breaks the protocol.
  var NOTE_OPEN = '===UPDATED-NOTE===';
  var NOTE_CLOSE = '===END-NOTE===';
  // -> { body, chat }: body = the revised note (null when the reply is ordinary conversation),
  // chat = the reply with the note block removed, so the bubble shows the AI's remark, not a dump.
  // `===UPDATED-NOTE===` edits the OPEN note; `===UPDATED-NOTE name=X===` edits note X — the
  // AI kept editing whatever was open because targeting another note had no channel at all.
  function extractNoteUpdate(text) {
    var s = String(text == null ? '' : text);
    var m = s.match(/^[ \t]*===UPDATED-NOTE(?: name=(.+?))?===[ \t]*$/m);
    if (!m) return { body: null, chat: s.trim(), name: null };
    var i = m.index;
    var rest = s.slice(i + m[0].length);
    var j = rest.indexOf(NOTE_CLOSE);
    // no closing marker yet (reply cut short / still streaming) -> take the remainder
    var body = (j < 0) ? rest : rest.slice(0, j);
    var after = (j < 0) ? '' : rest.slice(j + NOTE_CLOSE.length);
    var chat = (s.slice(0, i) + '\n' + after).replace(/\n{3,}/g, '\n\n').trim();
    body = stripMdFence(body.replace(/^\r?\n/, ''));
    return { body: body.trim() === '' ? null : body, chat: chat, name: m[1] ? m[1].trim() : null };
  }
  // Replace ONE section (heading -> just before the next same-or-higher heading) of a note
  // body. The fix for "แก้หัวข้อ 4 แล้วที่เหลือหายหมด": the AI sends ONLY the section, the app
  // merges — it never needs (and never had, with passage-selected context) the whole file.
  function replaceSection(body, heading, section) {
    var lines = String(body == null ? '' : body).split('\n');
    var want = String(heading == null ? '' : heading).replace(/^#+\s*/, '').trim().toLowerCase();
    if (!want) return null;
    var start = -1, level = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^(#{1,6})\s+(.*)$/);
      if (m && m[2].trim().toLowerCase() === want) { start = i; level = m[1].length; break; }
    }
    if (start < 0) return null;
    var end = lines.length;
    for (var j = start + 1; j < lines.length; j++) {
      var m2 = lines[j].match(/^(#{1,6})\s/);
      if (m2 && m2[1].length <= level) { end = j; break; }
    }
    var sec = String(section == null ? '' : section).trim();
    if (!/^#{1,6}\s/.test(sec)) sec = lines[start] + '\n\n' + sec;   // heading omitted -> keep the original
    var head = lines.slice(0, start).join('\n');
    var tail = lines.slice(end).join('\n').replace(/^\n+/, '');
    return (head ? head + '\n' : '') + sec + (tail ? '\n\n' + tail : '') + '\n';
  }

  // AI command: edit ONE SECTION of the open note.
  //   ===UPDATED-SECTION heading=ชื่อหัวข้อ===
  //   (เนื้อหาของหัวข้อนั้น รวมบรรทัดหัวข้อ)
  //   ===END-NOTE===
  // -> { sections: [{heading, body}], chat }.
  function extractSectionUpdates(text) {
    var s = String(text == null ? '' : text);
    var sections = [], chat = s, guard = 0;
    // optional name= targets ANY note (2026-08-19) — without it the section applies to the
    // OPEN note. The AI used to aim section edits at named notes with no channel for it, and
    // the executor silently dropped them (log: "เพิ่มใน Functional Modelling" went nowhere).
    var re = /^[ \t]*===UPDATED-SECTION (?:name=(.+?) )?heading=(.+?)===[ \t]*\r?\n?/m;
    while (guard++ < 10) {
      var m = chat.match(re);
      if (!m) break;
      var start = m.index;
      var rest = chat.slice(start + m[0].length);
      var j = rest.indexOf(NOTE_CLOSE);
      var body = j < 0 ? rest : rest.slice(0, j);
      var afterIdx = j < 0 ? chat.length : start + m[0].length + j + NOTE_CLOSE.length;
      var heading = m[2].trim();
      body = stripMdFence(body).trim();
      if (heading && body) sections.push({ heading: heading, body: body, name: m[1] ? m[1].trim() : null });
      chat = chat.slice(0, start) + chat.slice(afterIdx);
    }
    chat = chat.replace(/\n{3,}/g, '\n\n').trim();
    return { sections: sections, chat: chat };
  }

  // AI command: CREATE a new note. The AI names it and supplies the whole body:
  //   ===NEW-NOTE name=ชื่อโน้ต===
  //   (body)
  //   ===END-NOTE===
  // Without this, "สร้างโน้ตใหม่" had no channel — the model shoved content into the
  // open note via UPDATED-NOTE, the only marker it knew.
  // -> { notes: [{name, body}], chat: reply with the blocks removed }.
  function extractNewNotes(text) {
    var s = String(text == null ? '' : text);
    var notes = [], chat = s, guard = 0;
    var re = /^[ \t]*===NEW-NOTE name=(.+?)===[ \t]*\r?\n?/m;
    while (guard++ < 10) {
      var m = chat.match(re);
      if (!m) break;
      var start = m.index;
      var rest = chat.slice(start + m[0].length);
      var j = rest.indexOf(NOTE_CLOSE);
      var body = j < 0 ? rest : rest.slice(0, j);   // no close yet (streaming) -> take the remainder
      var afterIdx = j < 0 ? chat.length : start + m[0].length + j + NOTE_CLOSE.length;
      var name = m[1].trim();
      body = stripMdFence(body).trim();
      if (name && body) notes.push({ name: name, body: body });
      chat = chat.slice(0, start) + chat.slice(afterIdx);
    }
    chat = chat.replace(/\n{3,}/g, '\n\n').trim();
    return { notes: notes, chat: chat };
  }

  // AI command: "paste page N of the open PDF into its companion note" — one marker line per
  // page, emitted inside a chat reply. Same marker style as the note-update protocol.
  //   ===PDF-CLIP page=12===
  // -> { pages: [12, ...] (deduped, document order), chat: reply with the command lines removed }.
  // Remove every note-protocol block (UPDATED-NOTE / UPDATED-SECTION / NEW-NOTE ... END-NOTE)
  // and return the remainder. Lets the clip executor see ONLY standalone ===PDF-CLIP=== lines —
  // markers INSIDE a note block belong to that note (resolved into the body), not to the
  // PDF's capture target. Fix for "แนบรูปแล้วเข้าโน้ต DFD เสมอ".
  function stripNoteBlocks(text) {
    var s = String(text == null ? '' : text);
    var re = /^[ \t]*===(?:UPDATED-NOTE|UPDATED-SECTION|NEW-NOTE|KUMIKO-RULE|KUMIKO-PLAN|REMEMBER)[^\n]*===[ \t]*$/m;
    var guard = 0;
    while (guard++ < 20) {
      var m = s.match(re);
      if (!m) break;
      var rest = s.slice(m.index + m[0].length);
      var j = rest.indexOf(NOTE_CLOSE);
      var end = j < 0 ? s.length : m.index + m[0].length + j + NOTE_CLOSE.length;
      s = s.slice(0, m.index) + s.slice(end);
    }
    return s;
  }

  // ---- Kumiko tool lines (one shared grammar): ===VERB key=value=== on a line of its own.
  // READ-NOTE / SEARCH are "ask" verbs — the app fetches and CONTINUES the turn with the
  // results (bounded agentic loop). RENAME-NOTE / DELETE-NOTE / SET-CAPTURE-TARGET are file
  // verbs — executed immediately (delete asks the user first; everything is trash/undo-able).
  function extractActions(text) {
    var s = String(text == null ? '' : text);
    var out = { reads: [], searches: [], renames: [], deletes: [], targets: [],
      listTags: false, notesByTag: [], setTags: [], addTags: [], removeTags: [], renameTags: [],
      canvasList: false, canvasOps: [], planSteps: [], planDone: null };
    var chat = s.replace(/^[ \t]*===(READ-NOTE|SEARCH|RENAME-NOTE|DELETE-NOTE|SET-CAPTURE-TARGET|LIST-TAGS|NOTES-BY-TAG|SET-TAGS|ADD-TAGS|REMOVE-TAGS|RENAME-TAG|CANVAS-LIST|CANVAS-BOARD|CANVAS-ADD|CANVAS-REMOVE|CANVAS-WIRE|CANVAS-UNWIRE|CANVAS-STICKY|CANVAS-PLACE|CANVAS-ARRANGE|PLAN-STEP|PLAN-DONE)(?: (.+?))?===[ \t]*$/gm, function (_, verb, arg) {
      arg = (arg || '').trim();
      var m;
      if (verb === 'READ-NOTE') { m = arg.match(/^name=(.+)$/); if (m) out.reads.push(m[1].trim()); }
      else if (verb === 'SEARCH') { m = arg.match(/^query=(.+)$/); if (m) out.searches.push(m[1].trim()); }
      else if (verb === 'RENAME-NOTE') { m = arg.match(/^from=(.+?) to=(.+)$/); if (m) out.renames.push({ from: m[1].trim(), to: m[2].trim() }); }
      else if (verb === 'DELETE-NOTE') { m = arg.match(/^name=(.+)$/); if (m) out.deletes.push(m[1].trim()); }
      else if (verb === 'SET-CAPTURE-TARGET') { m = arg.match(/^name=(.+)$/); if (m) out.targets.push(m[1].trim()); }
      // ---- tag verbs (ask: LIST-TAGS / NOTES-BY-TAG · write: SET/ADD/REMOVE-TAGS per note · RENAME-TAG vault-wide) ----
      else if (verb === 'LIST-TAGS') { out.listTags = true; }
      else if (verb === 'NOTES-BY-TAG') { m = arg.match(/^tags?=(.+)$/); if (m) out.notesByTag.push(m[1].trim()); }
      else if (verb === 'SET-TAGS' || verb === 'ADD-TAGS' || verb === 'REMOVE-TAGS') {
        m = arg.match(/^name=(.+?) tags=(.*)$/);
        if (m) (verb === 'SET-TAGS' ? out.setTags : verb === 'ADD-TAGS' ? out.addTags : out.removeTags).push({ name: m[1].trim(), tags: m[2].trim() });
      }
      else if (verb === 'RENAME-TAG') { m = arg.match(/^from=(.+?)(?: to=(.*))?$/); if (m) out.renameTags.push({ from: m[1].trim(), to: (m[2] || '').trim() }); }
      // ---- Canvas verbs (ask: CANVAS-LIST · write: BOARD/ADD/REMOVE/WIRE/UNWIRE/STICKY) ----
      // Writes stay ONE ordered list — CANVAS-BOARD selects the board the following ops land on.
      else if (verb === 'CANVAS-LIST') { out.canvasList = true; }
      else if (verb === 'CANVAS-BOARD') { m = arg.match(/^name=(.+)$/); if (m) out.canvasOps.push({ op: 'board', name: m[1].trim() }); }
      else if (verb === 'CANVAS-ADD') {
        m = arg.match(/^name=(.+?)(?: segs=(.+?))?(?: w=(\d+))?$/);
        if (m) out.canvasOps.push({ op: 'add', name: m[1].trim(),
          segs: m[2] ? m[2].split('|').map(function (x) { return x.trim(); }).filter(Boolean) : [],
          w: m[3] ? parseInt(m[3], 10) : 0 });
      }
      else if (verb === 'CANVAS-REMOVE') { m = arg.match(/^name=(.+?)(?: seg=(.+))?$/); if (m) out.canvasOps.push({ op: 'remove', name: m[1].trim(), seg: m[2] ? m[2].trim() : '' }); }
      else if (verb === 'CANVAS-WIRE') {
        m = arg.match(/^from=(.+?)(?: fromseg=(.+?))? to=(.+?)(?: toseg=(.+))?$/);
        if (m) out.canvasOps.push({ op: 'wire', from: m[1].trim(), fromSeg: m[2] ? m[2].trim() : '', to: m[3].trim(), toSeg: m[4] ? m[4].trim() : '' });
      }
      else if (verb === 'CANVAS-UNWIRE') { m = arg.match(/^from=(.+?) to=(.+)$/); if (m) out.canvasOps.push({ op: 'unwire', from: m[1].trim(), to: m[2].trim() }); }
      else if (verb === 'CANVAS-STICKY') { m = arg.match(/^text=(.+)$/); if (m) out.canvasOps.push({ op: 'sticky', text: m[1].trim() }); }
      // ---- grid verbs (G2): position in CELL units — the mock's board=/note= spellings are
      // accepted alongside the family's name=; board= emits the board-select op first ----
      else if (verb === 'CANVAS-PLACE') {
        m = arg.match(/^(?:board=(.+?) )?(?:name|note)=(.+?)(?: seg=(.+?))?(?: at=(\S+?))?(?: size=(\S+?))?$/);
        if (m) {
          if (m[1]) out.canvasOps.push({ op: 'board', name: m[1].trim() });
          out.canvasOps.push({ op: 'place', name: m[2].trim(), seg: m[3] ? m[3].trim() : '', at: m[4] || '', size: m[5] || '' });
        }
      }
      else if (verb === 'CANVAS-ARRANGE') {
        m = arg.match(/^(?:board=(.+?) )?(?:mode=(grid|hub))?$/);
        if (m) {
          if (m[1]) out.canvasOps.push({ op: 'board', name: m[1].trim() });
          out.canvasOps.push({ op: 'arrange', mode: m[2] || 'grid' });
        }
      }
      // ---- plan verbs (mid-plan status lines; the plan card/file is the executor's side) ----
      else if (verb === 'PLAN-STEP') {
        m = arg.match(/^n=(\d+)(?: status=(done|doing|blocked))?(?: note=(.*))?$/);
        if (m) out.planSteps.push({ n: parseInt(m[1], 10), status: m[2] || 'done', note: (m[3] || '').trim() });
      }
      else if (verb === 'PLAN-DONE') { m = arg.match(/^summary=(.*)$/); if (m) out.planDone = { summary: m[1].trim() }; }
      return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    out.reads = out.reads.slice(0, 3);
    out.searches = out.searches.slice(0, 2);
    out.renames = out.renames.slice(0, 3);
    out.deletes = out.deletes.slice(0, 3);
    out.targets = out.targets.slice(0, 1);
    out.notesByTag = out.notesByTag.slice(0, 3);
    out.setTags = out.setTags.slice(0, 5); out.addTags = out.addTags.slice(0, 5); out.removeTags = out.removeTags.slice(0, 5);
    out.renameTags = out.renameTags.slice(0, 2);
    out.canvasOps = out.canvasOps.slice(0, 20);
    out.planSteps = out.planSteps.slice(0, 10);
    out.chat = chat;
    out.needsContinue = !!(out.reads.length || out.searches.length || out.listTags || out.notesByTag.length || out.canvasList);
    out.tagWrites = out.setTags.length + out.addTags.length + out.removeTags.length + out.renameTags.length;
    out.canvasWrites = out.canvasOps.length;
    out.planWrites = out.planSteps.length + (out.planDone ? 1 : 0);
    out.any = out.needsContinue || !!(out.renames.length || out.deletes.length || out.targets.length || out.tagWrites || out.canvasWrites || out.planWrites);
    return out;
  }

  // While a PDF is open, note content the AI writes usually cites its slides in headings —
  // "## Insertion Sort (หน้า 46)". The user's standing rule (2026-08-24): the slide IMAGE must
  // ride along, always. This is the deterministic net behind the prompt: any heading citing a
  // page whose section has no ===PDF-CLIP=== marker and no image gets the marker injected
  // right under the heading. Returns { body, added }.
  function ensureSlideClips(body, maxPage) {
    var lines = String(body == null ? '' : body).split('\n');
    var out = [], added = 0;
    for (var i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      var h = lines[i].match(/^#{1,6}\s.*(?:\(หน้า|\(p\.?|\(page)\s*(\d{1,4})\s*\)/i);
      if (!h) continue;
      var page = parseInt(h[1], 10);
      if (!(page >= 1) || (maxPage && page > maxPage)) continue;
      // scan this section (up to the next heading) for an existing clip/image of any kind
      var hasImg = false, j = i + 1;
      for (; j < lines.length && !/^#{1,6}\s/.test(lines[j]); j++) {
        if (/^[ \t]*===PDF-CLIP page=\d+===/.test(lines[j]) || /!\[[^\]]*\]\(/.test(lines[j])) { hasImg = true; break; }
      }
      if (hasImg) continue;
      out.push('');
      out.push('===PDF-CLIP page=' + page + '===');
      added++;
    }
    return { body: out.join('\n'), added: added };
  }

  // ===KUMIKO-RULE=== ... ===END-NOTE=== — the AI PROPOSES a standing work rule it noticed
  // (e.g. the user corrected it the same way twice). Never auto-applied: the executor shows a
  // confirm card and only an explicit user accept appends the rule to KUMIKO.md.
  function extractKumikoRules(text) {
    var s = String(text == null ? '' : text);
    var rules = [], guard = 0;
    var re = /^[ \t]*===KUMIKO-RULE===[ \t]*\r?\n?/m;
    while (guard++ < 5) {
      var m = s.match(re);
      if (!m) break;
      var rest = s.slice(m.index + m[0].length);
      var j = rest.indexOf(NOTE_CLOSE);
      var body = (j < 0 ? rest : rest.slice(0, j)).trim();
      var end = j < 0 ? s.length : m.index + m[0].length + j + NOTE_CLOSE.length;
      if (body) rules.push(body.slice(0, 300));
      s = s.slice(0, m.index) + s.slice(end);
    }
    return { rules: rules, chat: s.replace(/\n{3,}/g, '\n\n').trim() };
  }

  // ===REMEMBER type=วิชา=== ... ===END-NOTE=== — the AI PROPOSES a per-vault memory (a fact
  // worth keeping across chats). Never auto-saved: the executor shows a confirm card and only
  // an explicit accept writes to KUMIKO-MEMORY.md. ===FORGET text=…=== (single line) proposes
  // removing an existing card, matched by substring — also confirm-gated.
  function extractMemories(text) {
    var s = String(text == null ? '' : text);
    var memories = [], forgets = [], guard = 0;
    var re = /^[ \t]*===REMEMBER(?:[ \t]+type=([^=\n]+?))?===[ \t]*\r?\n?/m;
    while (guard++ < 6) {
      var m = s.match(re);
      if (!m) break;
      var rest = s.slice(m.index + m[0].length);
      var j = rest.indexOf(NOTE_CLOSE);
      var body = (j < 0 ? rest : rest.slice(0, j)).trim();
      var end = j < 0 ? s.length : m.index + m[0].length + j + NOTE_CLOSE.length;
      if (body) memories.push({ type: (m[1] || '').trim(), text: body.slice(0, 300) });
      s = s.slice(0, m.index) + s.slice(end);
    }
    s = s.replace(/^[ \t]*===FORGET[ \t]+text=(.+?)===[ \t]*$/gm, function (_, t2) {
      forgets.push(t2.trim().slice(0, 300));
      return '';
    });
    return { memories: memories, forgets: forgets, chat: s.replace(/\n{3,}/g, '\n\n').trim() };
  }

  // ===KUMIKO-PLAN title=…=== … ===END-NOTE=== — the AI PROPOSES a multi-step work plan
  // (jobs touching many notes / >2 steps). Never auto-started: the executor shows a plan
  // card and only the user's ▶ creates the plan note and starts the round loop.
  // -> { plans: [{title, steps:[string]}] (max 1, array per convention), chat: block removed }.
  function extractPlanProposals(text) {
    var s = String(text == null ? '' : text);
    var plans = [], guard = 0;
    var re = /^[ \t]*===KUMIKO-PLAN(?:[ \t]+title=(.+?))?===[ \t]*\r?\n?/m;
    while (guard++ < 3) {
      var m = s.match(re);
      if (!m) break;
      var rest = s.slice(m.index + m[0].length);
      var j = rest.indexOf(NOTE_CLOSE);
      var body = j < 0 ? rest : rest.slice(0, j);   // no close yet -> take the remainder (same as rules)
      var end = j < 0 ? s.length : m.index + m[0].length + j + NOTE_CLOSE.length;
      var steps = [];
      body.split('\n').forEach(function (ln) {
        var sm = /^\s*-\s+(.+?)\s*$/.exec(ln);
        if (sm) steps.push(sm[1].slice(0, 200));
      });
      if (steps.length) plans.push({ title: (m[1] || '').trim().slice(0, 120), steps: steps.slice(0, 30) });
      s = s.slice(0, m.index) + s.slice(end);
    }
    return { plans: plans.slice(0, 1), chat: s.replace(/\n{3,}/g, '\n\n').trim() };
  }

  function extractPdfClips(text) {
    var s = String(text == null ? '' : text);
    var pages = [], seen = {};
    var chat = s.replace(/^[ \t]*===PDF-CLIP page=(\d{1,4})===[ \t]*$/gm, function (_, n) {
      var p = parseInt(n, 10);
      if (p > 0 && !seen[p]) { seen[p] = 1; pages.push(p); }
      return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { pages: pages, chat: chat };
  }

  // The failure line pushed into the chat when ===PDF-CLIP=== markers could NOT be
  // resolved (2026-09-25: the note was silently saved without the image and only a
  // 3-second toast knew). Pure: pages are deduped + sorted (max 8 shown, then "…");
  // non-numeric values are filtered. T = the renderer's translate fn (identity
  // default, so tests see the Thai source strings). No lookbehind.
  function pdfClipFailLine(pages, noPdf, T) {
    T = typeof T === 'function' ? T : function (x) { return x; };
    var seen = {}, ps = [];
    (Array.isArray(pages) ? pages : []).forEach(function (p) {
      var n = Number(p);
      if (isFinite(n) && n > 0 && !seen[n]) { seen[n] = 1; ps.push(n); }
    });
    if (!ps.length) return '';
    ps.sort(function (a, b) { return a - b; });
    var list = ps.slice(0, 8).join(', ') + (ps.length > 8 ? ', …' : '');
    return T('⚠ แปะภาพสไลด์หน้า ') + list + (noPdf
      ? T(' ไม่สำเร็จ — ยังไม่มีไฟล์ PDF เปิดอยู่ ให้เปิดไฟล์ PDF ต้นทางในแอปก่อน แล้วสั่งใหม่อีกครั้ง')
      : T(' ไม่สำเร็จ (เรนเดอร์ไม่ผ่าน) — โน้ตถูกบันทึกโดยไม่มีภาพ ลองสั่งใหม่อีกครั้งได้'));
  }

  // ---- live activity console (mock W2 2026-09-22): what the AI is doing RIGHT NOW, read
  // from the raw streaming buffer — the display strip empties the bubble of verbs/note
  // blocks, so without this a long turn reads as frozen. Pure: rows keep first-seen order
  // (READ-NOTE merges into one row), a note block still OPEN becomes `writing`
  // (name + current body length) instead of a finished row. T = the renderer's translate
  // fn for i18n (identity default, so tests see the Thai source strings). No lookbehind.
  function liveActivity(acc, T) {
    T = typeof T === 'function' ? T : function (x) { return x; };
    var s = String(acc == null ? '' : acc);
    var rows = [], writing = null;
    var readRow = null, readNames = [], tagRow = null, tagN = 0, cvRow = null, cvN = 0, noteK = 0;
    var re = /^[ \t]*===(READ-NOTE|SEARCH|SET-TAGS|ADD-TAGS|REMOVE-TAGS|RENAME-TAG|CANVAS-BOARD|CANVAS-ADD|CANVAS-REMOVE|CANVAS-WIRE|CANVAS-UNWIRE|CANVAS-STICKY|CANVAS-PLACE|CANVAS-ARRANGE|PLAN-STEP|NEW-NOTE|UPDATED-NOTE|UPDATED-SECTION)((?:[^=\n]|=(?!==))*)===[ \t]*$/gm;
    // minimal arg validation per canvas write-op (mirrors extractActions' drops)
    var CV_OK = { 'CANVAS-BOARD': /^name=/, 'CANVAS-ADD': /^name=/, 'CANVAS-REMOVE': /^name=/,
      'CANVAS-WIRE': /^from=/, 'CANVAS-UNWIRE': /^from=.+ to=/, 'CANVAS-STICKY': /^text=/,
      'CANVAS-PLACE': /(?:^|\s)(?:name|note)=/, 'CANVAS-ARRANGE': /^(?:board=.+? )?(?:mode=(grid|hub))?$/ };
    var m;
    while ((m = re.exec(s))) {
      var verb = m[1], arg = (m[2] || '').trim();
      if (verb === 'NEW-NOTE' || verb === 'UPDATED-NOTE' || verb === 'UPDATED-SECTION') {
        var rest = s.slice(m.index + m[0].length);
        var j = rest.indexOf(NOTE_CLOSE);   // no close yet (still streaming) -> open block
        var nm = ((arg.match(/name=([^=]+?)(?: heading=|$)/) || [])[1] || (arg.match(/heading=(.+)$/) || [])[1] || '').trim();
        if (j < 0) writing = { name: nm, chars: rest.replace(/^\r?\n/, '').length };
        else rows.push({ k: 'note:' + (noteK++), ic: '✍️', label: T('เขียนโน้ต') + (nm ? ' "' + nm + '"' : '') + T(' เสร็จ') });
      }
      else if (verb === 'READ-NOTE') {
        var rm = arg.match(/^name=(.+)$/); if (!rm) continue;
        if (!readRow) { readRow = { k: 'read', ic: '🔎', label: '' }; rows.push(readRow); }
        readNames.push(rm[1].trim());
        readRow.label = T('อ่าน') + ': ' + readNames.join(' · ');
      }
      else if (verb === 'SEARCH') {
        var qm = arg.match(/^query=(.+)$/); if (!qm) continue;
        rows.push({ k: 'search:' + qm[1].trim(), ic: '🔎', label: T('ค้นหา') + ': ' + qm[1].trim() });
      }
      else if (verb === 'SET-TAGS' || verb === 'ADD-TAGS' || verb === 'REMOVE-TAGS' || verb === 'RENAME-TAG') {
        var ok = (verb === 'RENAME-TAG') ? /^from=.+/.test(arg) : /^name=.+? tags=/.test(arg);
        if (!ok) continue;
        if (!tagRow) { tagRow = { k: 'tag', ic: '🏷', label: '' }; rows.push(tagRow); }
        tagRow.label = T('แก้แท็ก') + ': ' + (++tagN) + T(' รายการ');
      }
      else if (CV_OK[verb]) {
        if (!CV_OK[verb].test(arg)) continue;
        if (!cvRow) { cvRow = { k: 'canvas', ic: '🖼', label: '' }; rows.push(cvRow); }
        cvRow.label = T('จัดแคนวาส') + ': ' + (++cvN) + T(' รายการ');
      }
      else if (verb === 'PLAN-STEP') {
        var pm = arg.match(/^n=(\d+)(?: status=(done|doing|blocked))?(?: note=(.*))?$/); if (!pm) continue;
        rows.push({ k: 'plan:' + pm[1], ic: '📋', label: T('ขั้น') + ' ' + pm[1] + ' ' +
          ({ done: '✓', doing: '…', blocked: '✗' })[pm[2] || 'done'] + (pm[3] ? ' ' + pm[3].trim() : '') });
      }
    }
    return { rows: rows, writing: writing };
  }

  // Make chat references clickable: @[Name] mentions and [source: Name] citations become
  // <a class="at-ref" data-ref="Name"> anchors the chat click-handler resolves to a note/PDF.
  // Runs on ALREADY-ESCAPED html (mdToHtml output or escaped user text) — never on raw input.

  // Resolve a chat [source:]/@ ref string to a concrete target. Model-written refs are messy:
  // "Name หน้า 17", "A, B หน้า 14–17", several names in one bracket — take the FIRST segment
  // that resolves; a trailing page marker becomes the PDF page to open at. Pure: the caller
  // hands in plain-name→rel maps (notes win over PDFs) and the pdf family-key fn.
  function resolveRefTarget(raw, noteMap, pdfMap, famKey) {
    var segs = String(raw == null ? '' : raw).split(/[,;·|]|\u0e41\u0e25\u0e30/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!segs.length) return null;
    for (var i = 0; i < segs.length; i++) {
      var m = segs[i].match(/^(.*?)(?:\s*[\u2014\u00b7-]?\s*(?:\u0e2b\u0e19\u0e49\u0e32|p\.?|\u0e19\.)\s*(\d+)(?:\s*[\u2013\u2014-]\s*\d+)?)?\s*$/i);
      var name = ((m && m[1]) || segs[i]).trim().replace(/[.:]+$/, '');
      var page = (m && m[2]) ? parseInt(m[2], 10) : null;
      var plain = name.split('/').pop().replace(/\.(md|pdf)$/i, '').trim().toLowerCase();
      if (!plain) continue;
      var noteRel = (noteMap && noteMap[plain]) || null;
      // a PDF's SHADOW note (PDF-Text/) shares its name — the reader wants the real PDF,
      // never the raw extract, so the shadow only wins when no actual pdf matches
      if (noteRel && !/^PDF-Text\//.test(noteRel)) return { kind: 'note', rel: noteRel };
      var fam = famKey ? famKey(name) : plain;
      var pdfRel = (pdfMap && (pdfMap[plain] || pdfMap[fam])) || null;
      if (pdfRel) return { kind: 'pdf', rel: pdfRel, page: page };
      if (noteRel) return { kind: 'note', rel: noteRel };
    }
    return null;
  }

  function linkifyRefs(html, names) {
    var s = String(html == null ? '' : html);
    var q = function (n) { return n.replace(/"/g, '&quot;'); };
    s = s.replace(/@\[([^\]<>\n]+)\]/g, function (_, n) {
      // display just the note name as a hyperlink — the @ is input syntax, not part of the name
      n = n.trim(); return '<a class="at-ref" data-ref="' + q(n) + '">' + n + '</a>';
    });
    s = s.replace(/\[source:\s*([^\]<>\n]+)\]/g, function (_, n) {
      n = n.trim(); return '<a class="at-ref src" data-ref="' + q(n) + '">📄 ' + n + '</a>';
    });
    // plain @Name mentions (current syntax — no brackets), matched against the KNOWN note list,
    // longest-first so "@BSD Cost" never re-matches as "@BSD". The @ is input syntax: drop it.
    if (Array.isArray(names) && names.length) {
      var sorted = names.slice().sort(function (a2, b2) { return String(b2).length - String(a2).length; });
      for (var i = 0; i < sorted.length; i++) {
        var raw = String(sorted[i] == null ? '' : sorted[i]); if (!raw) continue;
        var lit = _mdEsc(raw);
        var re = new RegExp('[@\\u200B]' + lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        s = s.replace(re, '<a class="at-ref" data-ref="' + q(lit) + '">' + lit + '</a>');
      }
    }
    return s;
  }

  // What a past message contributes to the NEXT prompt's history. Two leaks fixed here:
  //  1. an edit-turn reply carries the ENTIRE rewritten note between the markers — replaying that
  //     verbatim re-injected the whole note into every following prompt (slower every turn);
  //  2. unbounded long replies. History is context about the conversation, not a payload channel.
  function historyText(text, maxLen) {
    maxLen = (typeof maxLen === 'number' && isFinite(maxLen) && maxLen > 0) ? maxLen : 800;
    var r = extractNoteUpdate(text);
    var s = r.body
      ? ((r.chat ? r.chat + ' ' : '') + '[เทิร์นนี้ได้แก้โน้ตแล้ว — เนื้อฉบับเต็มไม่แสดงซ้ำ]')
      : String(text == null ? '' : text);
    var su = extractSectionUpdates(s);
    if (su.sections.length) s = su.chat + ' [แก้หัวข้อ: ' + su.sections.map(function (x) { return x.heading; }).join(', ') + ' แล้ว]';
    var nn = extractNewNotes(s);
    if (nn.notes.length) s = nn.chat + ' [สร้างโน้ตใหม่: ' + nn.notes.map(function (x) { return x.name; }).join(', ') + ' แล้ว]';
    var clips = extractPdfClips(s);
    if (clips.pages.length) s = clips.chat + ' [แปะสไลด์หน้า ' + clips.pages.join(', ') + ' แล้ว]';
    var kr = extractKumikoRules(s);
    if (kr.rules.length) s = kr.chat + ' [เสนอกติกาการทำงาน ' + kr.rules.length + ' ข้อแล้ว]';
    var mm = extractMemories(s);
    if (mm.memories.length || mm.forgets.length) s = mm.chat + ' [เสนอความจำ ' + (mm.memories.length + mm.forgets.length) + ' ใบแล้ว]';
    var pl = extractPlanProposals(s);
    if (pl.plans.length) s = pl.chat + ' [เสนอแผนงาน "' + pl.plans[0].title + '" แล้ว]';
    var ac = extractActions(s);
    if (ac.any) s = ac.chat + ' [ใช้เครื่องมือ' + (ac.reads.length ? ' อ่าน:' + ac.reads.join(',') : '') + (ac.searches.length ? ' ค้น:' + ac.searches.join(',') : '') + (ac.renames.length || ac.deletes.length || ac.targets.length ? ' จัดการไฟล์' : '') + ' แล้ว]';
    s = s.trim();
    if (s.length > maxLen) s = s.slice(0, maxLen) + ' …';
    return s;
  }
  return {
    mdToHtml: mdToHtml, _mdInline: _mdInline, _mdEsc: _mdEsc, stripMdFence: stripMdFence,
    extractNoteUpdate: extractNoteUpdate, extractPdfClips: extractPdfClips, pdfClipFailLine: pdfClipFailLine, extractNewNotes: extractNewNotes, extractSectionUpdates: extractSectionUpdates, replaceSection: replaceSection, stripNoteBlocks: stripNoteBlocks, extractKumikoRules: extractKumikoRules, extractMemories: extractMemories, extractPlanProposals: extractPlanProposals, extractActions: extractActions, liveActivity: liveActivity, ensureSlideClips: ensureSlideClips, linkifyRefs: linkifyRefs, resolveRefTarget: resolveRefTarget, historyText: historyText, NOTE_OPEN: NOTE_OPEN, NOTE_CLOSE: NOTE_CLOSE
  };
});
