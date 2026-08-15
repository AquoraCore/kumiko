import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

// The callout-colour plugin lives in the Milkdown bundle (browser/ProseMirror) so it can't
// run in node. Source guards lock in the design decided 2026-08-15:
//   - per-callout colour persisted as a `{!#hex}` marker (curly braces so Milkdown's
//     serializer does NOT backslash-escape it), round-tripped as plain markdown text,
//     hidden from view by a decoration.
const entrySrc = fs.readFileSync(path.join(__dirname, '../../build/crepe-entry.js'), 'utf8');
const bundleSrc = fs.readFileSync(path.join(__dirname, '../../renderer/vendor/crepe.bundle.js'), 'utf8');

describe('callout colour plugin (build entry)', () => {
  it('uses the curly-brace {!#hex} marker (avoids markdown escaping of [)', () => {
    expect(entrySrc).toMatch(/\\\{!\(#\[0-9a-fA-F\]/);   // CALLOUT_RE begins with \{!(#[0-9a-fA-F]
    expect(entrySrc).toContain("'{!'");                  // marker written with curly braces
  });
  it('is decoration-only (colours + hides marker) and exposes the setter', () => {
    expect(entrySrc).toContain('callout-colored');
    expect(entrySrc).toContain('callout-marker-hidden');
    expect(entrySrc).toContain('window.__calloutSetColor');
    expect(entrySrc).toContain('window.MDCalloutColor = calloutColor');
  });
  it('the shipped bundle was rebuilt to include the plugin', () => {
    expect(bundleSrc).toContain('__calloutSetColor');
    expect(bundleSrc).toContain('MDCalloutColor');
  });
});
