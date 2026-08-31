import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

// renderer.js / sidebar.js are browser code (window/document/Crepe) — not importable in node.
// Source guards that lock in behaviors added 2026-08-15:
const rendererSrc = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
const sidebarSrc = fs.readFileSync(path.join(__dirname, '../../renderer/sidebar.js'), 'utf8');

describe('autosave (edits persist without ⌘S; never lost on note switch)', () => {
  it('a debounced autosave is scheduled on every edit', () => {
    expect(rendererSrc).toContain('function scheduleAutosave');
    // the markdownUpdated handler must schedule it (else edits sit dirty until ⌘S)
    expect(rendererSrc).toMatch(/markdownUpdated[\s\S]{0,200}scheduleAutosave\(\)/);
  });
  it('a pending save is flushed before switching notes (no cross-note bleed / loss)', () => {
    expect(rendererSrc).toContain('async function flushAutosave');
    expect(rendererSrc).toContain('window.flushAutosave = flushAutosave');
    // openNote must flush the CURRENT note before loading the next
    expect(sidebarSrc).toMatch(/async function openNote[\s\S]{0,1200}flushAutosave/);   // window widened: review-dot clear + pending-review hook precede it
  });
});

