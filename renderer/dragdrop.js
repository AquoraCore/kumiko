// Unified pointer-events drag-and-drop for the sidebar (mouse / pen / touch).
// Replaces the native HTML5 drag (draggable=true), which never fires on touch
// and is flaky on some trackpads. movePdf / moveNote / moveFolder /
// folderCanMoveTo are globals supplied by sidebar.js + pdf.js.
//   mouse/pen: drag starts after a small move threshold.
//   touch:     drag starts after a long-press (~350ms) so a quick swipe still scrolls.
(function(){
  const THRESH = 6, HOLD_MS = 300, TOUCH_CANCEL = 16;
  const noteList = () => document.getElementById('noteList');
  let st = null, holdT = null;

  function findDraggable(el){ return el && el.closest ? el.closest('[data-drag-kind]') : null; }
  function clearHi(){ document.querySelectorAll('.drop-hi,.drop-hi-root').forEach((e) => e.classList.remove('drop-hi','drop-hi-root')); }
  function findDrop(x, y){
    const under = document.elementFromPoint(x, y);
    if (!under) return null;
    const row = under.closest ? under.closest('[data-drop-path]') : null;
    if (row) return { path: row.dataset.dropPath, el: row };
    const nl = noteList();
    if (nl && nl.contains(under)) return { path: '', el: nl };
    return null;
  }
  function begin(){
    if (!st || st.active) return;
    st.active = true; st.moved = true;
    try { st.el.setPointerCapture(st.pid); } catch(_){}
    if (st.touch) { try { navigator.vibrate && navigator.vibrate(15); } catch(_){} }  // haptic "picked up" cue
    st.el.classList.add('dragging');
    const g = document.createElement('div'); g.className = 'drag-ghost';
    g.textContent = (st.rel || '').split('/').pop().replace(/\.(md|pdf)$/i,'');
    document.body.appendChild(g); st.ghost = g;
    document.body.classList.add('dragging-active');
  }
  function onDown(e){
    if (e.button != null && e.button > 0) return;                    // left / touch / pen only
    if (e.target.closest && e.target.closest('.folder-tri')) return; // triangle = collapse, not drag
    const el = findDraggable(e.target);
    if (!el) return;
    st = { kind: el.dataset.dragKind, rel: el.dataset.dragRel, x0: e.clientX, y0: e.clientY, el, pid: e.pointerId, active: false, moved: false, target: null, touch: e.pointerType === 'touch' };
    clearTimeout(holdT);
    if (st.touch) holdT = setTimeout(begin, HOLD_MS);                 // touch: long-press to arm (lets a quick swipe scroll)
  }
  function onMove(e){
    if (!st) return;
    const dx = e.clientX - st.x0, dy = e.clientY - st.y0;
    if (!st.active){
      if (st.touch){ if (Math.abs(dx) + Math.abs(dy) > TOUCH_CANCEL){ clearTimeout(holdT); if (!st.active) { st = null; return; } } return; } // moved a lot before the hold armed -> it's a scroll, abort (finger jitter under TOUCH_CANCEL is tolerated)
      if (Math.abs(dx) + Math.abs(dy) < THRESH) return;              // mouse/pen: start on threshold
      begin();
    }
    e.preventDefault();
    if (st.ghost){ st.ghost.style.left = (e.clientX + 12) + 'px'; st.ghost.style.top = (e.clientY + 14) + 'px'; }
    clearHi();
    st.target = null;
    const d = findDrop(e.clientX, e.clientY);
    if (d){
      if (st.kind === 'folder' && (d.path === st.rel || !folderCanMoveTo(st.rel, d.path))) return;
      st.target = d.path;
      d.el.classList.add(d.el === noteList() ? 'drop-hi-root' : 'drop-hi');
    }
  }
  function onUp(){
    clearTimeout(holdT);
    const s = st; st = null;
    if (!s) return;
    clearHi();
    if (s.ghost) s.ghost.remove();
    document.body.classList.remove('dragging-active');
    if (s.el){ s.el.classList.remove('dragging'); try { s.el.releasePointerCapture(s.pid); } catch(_){} }
    if (s.active && s.target != null){
      if (s.kind === 'pdf') movePdf(s.rel, s.target);
      else if (s.kind === 'note') moveNote(s.rel, s.target);
      else if (s.kind === 'folder') moveFolder(s.rel, s.target);
    }
    if (s.moved && s.el){                                           // swallow the click that trails a real drag
      const kill = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      s.el.addEventListener('click', kill, { capture: true, once: true });
      setTimeout(() => { try { s.el.removeEventListener('click', kill, true); } catch(_){} }, 80);
    }
  }
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, { capture: true, passive: false });
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onUp, true);
})();
