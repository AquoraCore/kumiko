// Bundled with esbuild into renderer/vendor/editor.bundle.{js,css}
// Provides window.CodeMirror + window.HyperMD + window.HMDFold for the
// Obsidian-style live editor (with Notion-style collapse/expand folding).
import CodeMirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import 'codemirror/addon/fold/foldcode.js';
import 'codemirror/addon/fold/foldgutter.js';
import 'codemirror/addon/fold/foldgutter.css';
import 'hypermd/mode/hypermd.css';
import 'hypermd/theme/hypermd-light.css';
import * as HyperMD from 'hypermd';

// Notion-style toggle: fold a heading's section, or a list item's indented children.
function foldRange(cm, start) {
  const firstLine = cm.getLine(start.line);
  const lastLineNo = cm.lastLine();

  const headingMatch = firstLine.match(/^(#{1,6})\s/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    let end = start.line;
    for (let i = start.line + 1; i <= lastLineNo; i++) {
      const m = cm.getLine(i).match(/^(#{1,6})\s/);
      if (m && m[1].length <= level) break;
      end = i;
    }
    if (end > start.line) {
      return {
        from: CodeMirror.Pos(start.line, firstLine.length),
        to: CodeMirror.Pos(end, cm.getLine(end).length),
      };
    }
    return;
  }

  const listMatch = firstLine.match(/^(\s*)([-*+]|\d+\.)\s/);
  if (listMatch) {
    const indent = listMatch[1].length;
    let end = start.line;
    for (let i = start.line + 1; i <= lastLineNo; i++) {
      const l = cm.getLine(i);
      if (l.trim() === '') break;
      const childIndent = (l.match(/^(\s*)/) || ['', ''])[1].length;
      if (childIndent <= indent) break;
      end = i;
    }
    if (end > start.line) {
      return {
        from: CodeMirror.Pos(start.line, firstLine.length),
        to: CodeMirror.Pos(end, cm.getLine(end).length),
      };
    }
  }
}

CodeMirror.registerHelper('fold', 'hmdToggle', foldRange);

window.CodeMirror = CodeMirror;
window.HyperMD = HyperMD;
window.HMDFold = foldRange;
