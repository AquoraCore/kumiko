// Milkdown Crepe — Notion-style WYSIWYG markdown editor.
// Bundled to renderer/vendor/crepe.bundle.{js,css}.
// Exposes: window.Crepe, window.MDHeadingFold (collapse a heading's section by level).
import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
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
      state.doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return;
        const text = node.text; let m;
        WIKI_RE.lastIndex = 0;
        while ((m = WIKI_RE.exec(text)) !== null) {
          const from = pos + m.index;
          const to = from + m[0].length;
          decos.push(Decoration.inline(from, to, { class: 'md-wikilink' }));
        }
      });
      return DecorationSet.create(state.doc, decos);
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
function renderMermaidInto(el, code){
  const mm = window.mermaid;
  if (!mm){ el.textContent = '⚠ mermaid ยังไม่พร้อม'; return; }
  if (!code.trim()){ el.textContent = ''; return; }
  // Render on the next tick (the widget div isn't in the DOM yet when the factory runs) and
  // do NOT pass `el` as the container — mermaid measures against document.body, so it works
  // even before the widget attaches. We just drop the returned SVG string into el.
  setTimeout(() => {
    const id = 'mmd-' + (++_mmSeq);
    try {
      mm.render(id, code, (svg) => { el.innerHTML = svg; });
    } catch (e) {
      el.innerHTML = '<div class="md-mermaid-err">แผนภาพผิดพลาด: ' + String(e && e.message || e).replace(/</g, '&lt;') + '</div>';
    }
  }, 0);
}
const mermaidView = $prose(() => new Plugin({
  key: new PluginKey('md-mermaid'),
  props: {
    decorations(state){
      const decos = [];
      state.doc.descendants((node, pos) => {
        if (node.type.name !== 'code_block') return;
        const lang = String((node.attrs && (node.attrs.language || node.attrs.lang)) || '').toLowerCase();
        if (lang !== 'mermaid') return;
        const code = node.textContent || '';
        decos.push(Decoration.widget(pos + node.nodeSize, () => {
          const d = document.createElement('div'); d.className = 'md-mermaid-render'; d.contentEditable = 'false';
          renderMermaidInto(d, code);
          return d;
        }, { side: 1, key: 'mmd-' + pos + '-' + _mmHash(code) }));
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
}));

window.Crepe = Crepe;
window.MDHeadingFold = headingFold;
window.MDWikiLink = wikiLink;
window.MDCalloutColor = calloutColor;
window.MDMermaid = mermaidView;
window.Y = Y;                                   // the ONE yjs instance for the whole app
window.WebsocketProvider = WebsocketProvider;   // client provider (connects to the relay)
window.MilkdownCollab = { collab, collabServiceCtx };   // the Milkdown collab plugin + its service ctx
