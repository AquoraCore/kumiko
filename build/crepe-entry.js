// Milkdown Crepe — Notion-style WYSIWYG markdown editor.
// Bundled to renderer/vendor/crepe.bundle.{js,css}.
// Exposes: window.Crepe, window.MDHeadingFold (collapse a heading's section by level).
import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { editorViewCtx } from '@milkdown/core';
import * as pmCommands from '@milkdown/prose/commands';
import * as pmList from '@milkdown/prose/schema-list';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { languages as cmLanguages } from '@codemirror/language-data';
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const foldKey = new PluginKey('md-heading-fold');

// top-level children as { node, start }
function topLevel(doc) {
  const out = [];
  let o = 0;
  doc.forEach((n) => { out.push({ node: n, start: o }); o += n.nodeSize; });
  return out;
}

function buildDecos(state, collapsed) {
  const doc = state.doc;
  const items = topLevel(doc);
  const decos = [];
  items.forEach((it, idx) => {
    if (it.node.type.name !== 'heading') return;
    const pos = it.start;
    const level = it.node.attrs.level || 1;
    // does this heading have a foldable section?
    const hasSection = idx + 1 < items.length &&
      !(items[idx + 1].node.type.name === 'heading' && (items[idx + 1].node.attrs.level || 1) <= level);
    const isCollapsed = collapsed.includes(pos);
    // triangle widget at heading start
    decos.push(Decoration.widget(pos + 1, () => {
      const b = document.createElement('span');
      b.className = 'md-fold-tri' + (isCollapsed ? ' collapsed' : '') + (hasSection ? '' : ' empty');
      b.textContent = isCollapsed ? '▸' : '▾';
      b.contentEditable = 'false';
      b.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (window.__mdFoldToggle) window.__mdFoldToggle(pos);
      });
      return b;
    }, { side: -1, key: 'tri-' + pos + '-' + isCollapsed + '-' + hasSection }));
    // hide the section when collapsed
    if (isCollapsed && hasSection) {
      for (let i = idx + 1; i < items.length; i++) {
        const p = items[i];
        if (p.node.type.name === 'heading' && (p.node.attrs.level || 1) <= level) break;
        decos.push(Decoration.node(p.start, p.start + p.node.nodeSize, { class: 'md-folded-hidden' }));
      }
    }
  });
  return DecorationSet.create(doc, decos);
}

const headingFold = $prose(() => new Plugin({
  key: foldKey,
  state: {
    init: () => ({ collapsed: [] }),
    apply(tr, value) {
      let collapsed = value.collapsed
        .map((p) => tr.mapping.map(p, -1))
        .filter((p) => p != null);
      const meta = tr.getMeta(foldKey);
      if (meta && meta.toggle != null) {
        const p = meta.toggle;
        collapsed = collapsed.includes(p) ? collapsed.filter((x) => x !== p) : [...collapsed, p];
      }
      return { collapsed };
    },
  },
  props: {
    decorations(state) { return buildDecos(state, foldKey.getState(state).collapsed); },
  },
  view(editorView) {
    window.__mdFoldToggle = (pos) => {
      editorView.dispatch(editorView.state.tr.setMeta(foldKey, { toggle: pos }));
    };
    return { destroy() { window.__mdFoldToggle = null; } };
  },
}));

// Wikilink [[name]] / [[name|alias]] — decorate the span so it reads as a link,
// and on click hand the resolved name to renderer-side window.__wikiNav.
const WIKI_RE = /\[\[([^\[\]\n]+?)\]\]/g;

const wikiLink = $prose(() => new Plugin({
  key: new PluginKey('md-wikilink'),
  props: {
    decorations(state) {
      const decos = [];
      const sel = state.selection;
      state.doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return;
        const text = node.text; let m;
        WIKI_RE.lastIndex = 0;
        while ((m = WIKI_RE.exec(text)) !== null) {
          const from = pos + m.index;
          const to = from + m[0].length;
          decos.push(Decoration.inline(from, to, { class: 'md-wikilink' }));
          // Hide the literal [[ ]] brackets so the note reads as prose — but reveal them the
          // moment the caret enters the link, so it stays editable as plain markdown.
          // (The .wl-hide CSS shipped long ago; nothing ever applied the class until now.)
          const inside = sel.from <= to && sel.to >= from;
          if (!inside) {
            // [[target|alias]] reads as just "alias": hide "[[target|" and "]]" (Obsidian-style)
            const pipe = m[0].indexOf('|');
            const openEnd = pipe >= 0 ? from + pipe + 1 : from + 2;
            decos.push(Decoration.inline(from, openEnd, { class: 'wl-hide' }));
            decos.push(Decoration.inline(to - 2, to, { class: 'wl-hide' }));
          }
        }
      });
      return DecorationSet.create(state.doc, decos);
    },
    // Obsidian-style wrap: with text SELECTED, typing '[' turns it into a [[wikilink]]
    // instead of replacing the selection. (The select-then-[[ helper died in the old-editor
    // migration; this brings it back.)
    handleTextInput(view, from, to, text) {
      if (text !== '[' || from === to) return false;
      const sel = view.state.doc.textBetween(from, to);
      if (!sel || sel.indexOf('\n') >= 0 || sel.indexOf('[') >= 0) return false;
      view.dispatch(view.state.tr.insertText('[[' + sel + ']]', from, to));
      return true;
    },
    handleClick(view, clickPos) {
      const $pos = view.state.doc.resolve(clickPos);
      const parent = $pos.parent;
      if (!parent || !parent.isTextblock) return false;
      const start = $pos.start();
      const text = parent.textContent || '';
      const offset = clickPos - start;
      let m; WIKI_RE.lastIndex = 0;
      while ((m = WIKI_RE.exec(text)) !== null) {
        const a = m.index, b = m.index + m[0].length;
        if (offset >= a && offset <= b) {
          const raw = m[1].split('|')[0].trim();   // [[name|alias]] -> name
          if (raw && typeof window.__wikiNav === 'function') { window.__wikiNav(raw); return true; }
          return false;
        }
      }
      return false;
    },
  },
}));

// Callout colour — a blockquote whose first line starts with `[!#hex]` is a coloured
// callout. Decoration-only (like wikiLink): the marker is literal markdown text, so it
// round-trips for free; we just (a) paint the blockquote via a --callout CSS var + class
// and (b) hide the marker span from view. window.__calloutSetColor(hex) inserts/updates
// the marker on the blockquote at the cursor (''/null clears it).
// `{!#hex}` (curly braces — NOT markdown-special, so the serializer won't backslash-escape
// them the way it would `[`). Keeps raw markdown clean: `> {!#f59e0b} text`.
const CALLOUT_RE = /^\{!(#[0-9a-fA-F]{3,8})\} ?/;
function calloutMarkerLen(text){ const m = CALLOUT_RE.exec(text || ''); return m ? m[0].length : 0; }
function calloutColorOf(text){ const m = CALLOUT_RE.exec(text || ''); return m ? m[1] : null; }

const calloutColor = $prose(() => new Plugin({
  key: new PluginKey('md-callout-color'),
  props: {
    decorations(state) {
      const decos = [];
      state.doc.descendants((node, pos) => {
        if (node.type.name !== 'blockquote') return;
        const first = node.firstChild;
        if (!first || !first.isTextblock) return;
        const color = calloutColorOf(first.textContent);
        if (!color) return;
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'callout-colored', style: '--callout:' + color }));
        const from = pos + 2;   // inline content start of the first paragraph (bq open + para open)
        const to = from + calloutMarkerLen(first.textContent);
        decos.push(Decoration.inline(from, to, { class: 'callout-marker-hidden' }));
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
  view(editorView) {
    const findBq = (stateSel) => {
      const $from = stateSel.$from;
      for (let i = $from.depth; i >= 0; i--) {
        const n = $from.node(i);
        if (n.type.name === 'blockquote') return { node: n, pos: $from.before(i) };
      }
      return null;
    };
    window.__calloutSetColor = (color) => {
      const { state, dispatch } = editorView;
      const hit = findBq(state.selection);
      if (!hit) return false;
      const first = hit.node.firstChild;
      if (!first || !first.isTextblock) return false;
      const paraStart = hit.pos + 2;
      const len = calloutMarkerLen(first.textContent);
      const marker = color ? ('{!' + color + '} ') : '';
      const tr = state.tr;
      if (len) tr.replaceWith(paraStart, paraStart + len, marker ? state.schema.text(marker) : []);
      else if (marker) tr.insert(paraStart, state.schema.text(marker));
      else return false;
      dispatch(tr);
      editorView.focus();
      return true;
    };
    window.__calloutCurrent = () => {
      const hit = findBq(editorView.state.selection);
      if (!hit) return { inCallout: false, color: null };
      const first = hit.node.firstChild;
      return { inCallout: true, color: first ? calloutColorOf(first.textContent) : null };
    };
    return { destroy() { window.__calloutSetColor = null; window.__calloutCurrent = null; } };
  },
}));

// Mermaid — render a ```mermaid code block as a live diagram widget UNDER the code
// (code stays editable; the SVG previews below). Decoration-only, like wikiLink/callout.
// Needs window.mermaid (renderer/vendor/mermaid.bundle.js) loaded before the editor.
let _mmSeq = 0;
function _mmHash(s){ let h = 0; for (let i = 0; i < s.length; i++){ h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }
// mermaid v8 renders its OWN full-size "Syntax error in graph" bomb SVG on bad input, and since
// we pass no container it lands in <body>. decorations() re-runs on every keystroke, so typing an
// unfinished diagram stacked one bomb per character at the end of the page. Sweep any it leaves.
function _mmSweepOrphans(){
  try {
    document.querySelectorAll('body > svg[id^="mmd-"], body > svg[id^="dmmd-"], body > div[id^="dmmd-"], body > #dmermaid, body > .mermaidTooltip')
      .forEach((n) => n.remove());
  } catch (_) {}
}
function renderMermaidInto(el, code){
  const mm = window.mermaid;
  if (!mm){ el.textContent = '⚠ mermaid ยังไม่พร้อม'; return; }
  if (!code.trim()){ el.textContent = ''; return; }
  // Render on the next tick (the widget div isn't in the DOM yet when the factory runs) and
  // do NOT pass `el` as the container — mermaid measures against document.body, so it works
  // even before the widget attaches. We just drop the returned SVG string into el.
  setTimeout(async () => {
    const id = 'mmd-' + (++_mmSeq);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const fail = (msg) => {
      // A half-typed diagram is the NORMAL state while editing — keep the notice small and quiet,
      // never anything page-sized. Show the source too: the ```mermaid block itself is hidden in
      // diagram mode, so without this a failed diagram would render as a blank gap.
      el.innerHTML = '<div class="md-mermaid-err">' + esc(msg || 'ยังวาดไม่ได้ — ตรวจไวยากรณ์แผนภาพ') + '</div>'
        + '<pre class="md-mermaid-code">' + esc(code) + '</pre>';
      _mmSweepOrphans();
    };
    try {
      // v11: parse() and render() are async and reject on bad syntax; `suppressErrorRendering`
      // (set in mermaid-entry.js) stops mermaid drawing its own error graphic.
      const r = mm.render(id, code);
      if (r && typeof r.then === 'function') {
        const out = await r;
        el.innerHTML = (out && out.svg) || '';
      } else if (typeof r === 'string') {
        el.innerHTML = r;                       // (older sync API, kept for safety)
      }
      _mmSweepOrphans();
    } catch (e) {
      fail(e && e.message);
    }
  }, 0);
}
const mermaidView = $prose(() => new Plugin({
  key: new PluginKey('md-mermaid'),
  props: {
    decorations(state){
      const decos = [];
      const sel = state.selection;
      state.doc.descendants((node, pos) => {
        if (node.type.name !== 'code_block') return;
        const lang = String((node.attrs && (node.attrs.language || node.attrs.lang)) || '').toLowerCase();
        if (lang !== 'mermaid') return;
        const code = node.textContent || '';
        const end = pos + node.nodeSize;
        // Caret inside the block = EDIT mode (source shown). Otherwise only the diagram shows —
        // clicking it drops the caret in, which flips this flag on the next render.
        const editing = sel.from >= pos && sel.to <= end;
        if (!editing) decos.push(Decoration.node(pos, end, { class: 'md-mm-src-hidden' }));
        decos.push(Decoration.widget(end, (view) => {
          const d = document.createElement('div');
          d.className = 'md-mermaid-render' + (editing ? ' is-editing' : '');
          d.contentEditable = 'false';
          if (!editing){
            d.title = 'คลิกเพื่อแก้ไขแผนภาพ';
            d.addEventListener('mousedown', (ev) => {
              ev.preventDefault(); ev.stopPropagation();
              try {
                const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1));
                view.dispatch(tr.scrollIntoView()); view.focus();
              } catch (_) {}
            });
          }
          renderMermaidInto(d, code);
          return d;
        }, { side: 1, key: 'mmd-' + pos + '-' + (editing ? 'e' : 'v') + '-' + _mmHash(code) }));
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
}));

// Text colour — inline `{c:name}...{/c}` marker (round-trips as plain markdown, like the
// callout marker). A decoration paints the inner text (a light bg + dark ink per name via the
// .tcolor-<name> CSS) and hides the markers. window.__tboxSetColor(view, name) wraps the
// selection ('' clears). Positions map 1:1 to textContent because a text-box holds only text.
const tcolor = $prose(() => new Plugin({
  key: new PluginKey('md-tcolor'),
  props: {
    decorations(state){
      const decos = [];
      state.doc.descendants((node, pos) => {
        if (!node.isTextblock) return;
        const text = node.textContent;
        if (!text || text.indexOf('{c:') < 0) return;
        const start = pos + 1;
        const re = /\{c:([a-z]+)\}([\s\S]*?)\{\/c\}/g;
        let m;
        while ((m = re.exec(text)) !== null){
          const openLen = m[0].indexOf('}') + 1;
          const openStart = start + m.index, openEnd = openStart + openLen;
          const closeEnd = start + m.index + m[0].length, closeStart = closeEnd - 4;
          decos.push(Decoration.inline(openStart, openEnd, { class: 'tcolor-hide' }));
          decos.push(Decoration.inline(closeStart, closeEnd, { class: 'tcolor-hide' }));
          if (closeStart > openEnd) decos.push(Decoration.inline(openEnd, closeStart, { class: 'tcolor tcolor-' + m[1] }));
        }
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
  view(editorView){
    window.__tboxSetColor = (view, name) => {
      const v = view || editorView; const { state, dispatch } = v;
      const { from, to, empty } = state.selection; if (empty) return false;
      const sel = state.doc.textBetween(from, to);
      const inner = sel.replace(/\{c:[a-z]+\}|\{\/c\}/g, '');   // drop any existing colour markers
      const repl = name ? ('{c:' + name + '}' + inner + '{/c}') : inner;
      dispatch(repl ? state.tr.replaceWith(from, to, state.schema.text(repl)) : state.tr.delete(from, to));
      v.focus(); return true;
    };
    return { destroy(){ window.__tboxSetColor = null; } };
  },
}));

// Link-on-paste — select text, paste a URL → the selection becomes a hyperlink (Notion-style).
const linkPaste = $prose(() => new Plugin({
  key: new PluginKey('md-linkpaste'),
  props: {
    handlePaste(view, event){
      let text = ''; try { text = (event.clipboardData || window.clipboardData).getData('text/plain'); } catch (_) {}
      const url = (text || '').trim();
      if (!/^https?:\/\/[^\s]+$/.test(url)) return false;      // only a bare URL
      const { from, to, empty } = view.state.selection;
      if (empty) return false;                                // no selection → let default paste run
      const mark = view.state.schema.marks.link;
      if (!mark) return false;
      view.dispatch(view.state.tr.addMark(from, to, mark.create({ href: url, title: null })));
      return true;
    },
  },
}));

// Editor command API for external toolbars (the PDF text-box formatting bar). Exposes the
// live ProseMirror view + the prosemirror-commands / schema-list helpers so the renderer can
// toggle marks (bold/italic/…), set block types (headings), and wrap lists on the real editor.
window.MDEdit = {
  getView(crepe){ try { return crepe.editor.ctx.get(editorViewCtx); } catch (_) { return null; } },
  cmd: pmCommands,
  list: pmList,
};

window.Crepe = Crepe;
window.MDHeadingFold = headingFold;
window.MDWikiLink = wikiLink;
window.MDCalloutColor = calloutColor;
window.MDMermaid = mermaidView;
// Code-block language list with mermaid FIRST — the picker had no mermaid entry, forcing users
// to type ```mermaid by hand. Plain tokenizer (diagrams need no syntax highlighting; the live
// render below the block is the real feedback).
const mermaidCodeLang = LanguageDescription.of({
  name: 'mermaid',
  alias: ['mmd'],
  load: async () => new LanguageSupport(StreamLanguage.define({ token: (st) => { st.next(); return null; } })),
});
window.MDCodeLangs = [mermaidCodeLang, ...cmLanguages];
window.MDTColor = tcolor;
window.MDLinkPaste = linkPaste;
window.Y = Y;                                   // the ONE yjs instance for the whole app
window.WebsocketProvider = WebsocketProvider;   // client provider (connects to the relay)
window.MilkdownCollab = { collab, collabServiceCtx };   // the Milkdown collab plugin + its service ctx

// Debug/introspection hook: the live ProseMirror view (used by block-handle diagnostics and
// any renderer feature that needs posAtCoords). Registered as a plain prose plugin.
const exposeView = $prose(() => new Plugin({
  key: new PluginKey('kumiko-expose-view'),
  view: (editorView) => { window.__pmView = editorView; return { destroy(){ if (window.__pmView === editorView) window.__pmView = null; } }; },
}));
window.MDExposeView = exposeView;
