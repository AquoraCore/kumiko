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
    // CommonMark backslash escapes: the WYSIWYG editor serializes "<<extend>>" as
    // "\<\<extend\>\>" — show the character, never the backslash ("มี \ เพิ่มเข้ามา").
    // Escaped chars are parked in private-use placeholders until AFTER the formatting
    // passes, so "\*x\*" renders as literal *x*, not emphasis. (Chars are already
    // HTML-escaped here, so the entity forms are matched too.)
    var _escd = [];
    s = s.replace(/\\(&lt;|&gt;|&amp;|&quot;|[\\`*_{}\[\]()#+\-.!~|=:;,\/?@^$%'])/g, function (_, c) {   // full CommonMark escapable set — '\=' at line start (setext guard) used to survive as a visible backslash
      _escd.push(c); return '' + (_escd.length - 1) + '';
    });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img class="md-img" src="$2" alt="$1">');   // images render as images, not stray text

    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\{c:([a-z]+)\}([\s\S]*?)\{\/c\}/g, (m,name,inner)=> '<span class="tcolor tcolor-'+name+'">'+inner+'</span>');   // inline text colour
    s = s.replace(/\\?\[\\?\[([^\[\]|\n]+?)(?:\|([^\[\]\n]+?))?\\?\]\\?\]/g, (m,a,b)=> '<span class="wikilink">'+(b||a)+'</span>');   // tolerates \[\[escaped]] links
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<span class="mdlink">$1</span>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/(\d+)/g, function (_, i) { return _escd[+i]; });   // restore escaped chars
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
          html += '<pre class="md-code"><code>' + _mdEsc(code) + '</code></pre>';
        }
        i = k + 1;   // skip the closing fence (or EOF)
        continue;
      }
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
    var re = /^[ \t]*===(?:UPDATED-NOTE|UPDATED-SECTION|NEW-NOTE|KUMIKO-RULE|REMEMBER)[^\n]*===[ \t]*$/m;
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
      listTags: false, notesByTag: [], setTags: [], addTags: [], removeTags: [], renameTags: [] };
    var chat = s.replace(/^[ \t]*===(READ-NOTE|SEARCH|RENAME-NOTE|DELETE-NOTE|SET-CAPTURE-TARGET|LIST-TAGS|NOTES-BY-TAG|SET-TAGS|ADD-TAGS|REMOVE-TAGS|RENAME-TAG)(?: (.+?))?===[ \t]*$/gm, function (_, verb, arg) {
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
    out.chat = chat;
    out.needsContinue = !!(out.reads.length || out.searches.length || out.listTags || out.notesByTag.length);
    out.tagWrites = out.setTags.length + out.addTags.length + out.removeTags.length + out.renameTags.length;
    out.any = out.needsContinue || !!(out.renames.length || out.deletes.length || out.targets.length || out.tagWrites);
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

  // Make chat references clickable: @[Name] mentions and [source: Name] citations become
  // <a class="at-ref" data-ref="Name"> anchors the chat click-handler resolves to a note/PDF.
  // Runs on ALREADY-ESCAPED html (mdToHtml output or escaped user text) — never on raw input.
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
    var ac = extractActions(s);
    if (ac.any) s = ac.chat + ' [ใช้เครื่องมือ' + (ac.reads.length ? ' อ่าน:' + ac.reads.join(',') : '') + (ac.searches.length ? ' ค้น:' + ac.searches.join(',') : '') + (ac.renames.length || ac.deletes.length || ac.targets.length ? ' จัดการไฟล์' : '') + ' แล้ว]';
    s = s.trim();
    if (s.length > maxLen) s = s.slice(0, maxLen) + ' …';
    return s;
  }
  return {
    mdToHtml: mdToHtml, _mdInline: _mdInline, _mdEsc: _mdEsc, stripMdFence: stripMdFence,
    extractNoteUpdate: extractNoteUpdate, extractPdfClips: extractPdfClips, extractNewNotes: extractNewNotes, extractSectionUpdates: extractSectionUpdates, replaceSection: replaceSection, stripNoteBlocks: stripNoteBlocks, extractKumikoRules: extractKumikoRules, extractMemories: extractMemories, extractActions: extractActions, ensureSlideClips: ensureSlideClips, linkifyRefs: linkifyRefs, historyText: historyText, NOTE_OPEN: NOTE_OPEN, NOTE_CLOSE: NOTE_CLOSE
  };
});
