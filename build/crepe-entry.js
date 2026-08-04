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

window.Crepe = Crepe;
window.MDHeadingFold = headingFold;
window.MDWikiLink = wikiLink;
window.Y = Y;                                   // the ONE yjs instance for the whole app
window.WebsocketProvider = WebsocketProvider;   // client provider (connects to the relay)
window.MilkdownCollab = { collab, collabServiceCtx };   // the Milkdown collab plugin + its service ctx
