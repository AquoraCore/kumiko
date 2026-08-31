import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

// "/" in a typed file name used to silently create folders (2026-08-25). Name fields now swap
// it for the visually identical FRACTION SLASH (⁄ U+2044); the new-note popover keeps its
// documented "กล่อง/ชื่อ" path syntax ONLY when the box actually exists.
const renderer = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
const sidebar = fs.readFileSync(path.join(__dirname, '../../renderer/sidebar.js'), 'utf8');
const pdf = fs.readFileSync(path.join(__dirname, '../../renderer/pdf.js'), 'utf8');

const m = renderer.match(/function resolveTypedName\([\s\S]*?\n}/);
const resolveTypedName = eval('(' + m[0] + ')');

describe('resolveTypedName', () => {
  const FOLDERS = ['BUS SOFTWARE SYS', 'BUS SOFTWARE SYS/Note', 'CRFT STW'];
  it('happy: plain name passes through', () => {
    expect(resolveTypedName('สรุปบทที่ 5', FOLDERS)).toEqual({ dir: '', name: 'สรุปบทที่ 5', converted: false });
  });
  it('happy: existing box → explicit path (nested boxes too)', () => {
    expect(resolveTypedName('CRFT STW/ใหม่', FOLDERS)).toEqual({ dir: 'CRFT STW', name: 'ใหม่', converted: false });
    expect(resolveTypedName('BUS SOFTWARE SYS/Note/ใหม่', FOLDERS)).toEqual({ dir: 'BUS SOFTWARE SYS/Note', name: 'ใหม่', converted: false });
  });
  it('edge: unknown prefix → the whole thing is ONE title with ⁄', () => {
    expect(resolveTypedName('ใบลดหนี้/Credit note', FOLDERS)).toEqual({ dir: '', name: 'ใบลดหนี้⁄Credit note', converted: true });
  });
  it('edge: multiple slashes with unknown prefix all convert', () => {
    expect(resolveTypedName('a/b/c', FOLDERS)).toEqual({ dir: '', name: 'a⁄b⁄c', converted: true });
  });
  it('edge: trailing slash or empty name half never creates a folder', () => {
    expect(resolveTypedName('CRFT STW/', FOLDERS).converted).toBe(true);
    expect(resolveTypedName('/x', FOLDERS).converted).toBe(true);
  });
  it('edge: no folder list at all still safe', () => {
    expect(resolveTypedName('a/b', null)).toEqual({ dir: '', name: 'a⁄b', converted: true });
  });
});

describe('nameNoSlash is wired into every name dialog', () => {
  it('renderer: note rename + popover create', () => {
    expect(renderer).toMatch(/function nameNoSlash/);
    expect(renderer).toMatch(/let to = nameNoSlash\(nm\.trim\(\)\); if \(!\/\\\.md\$\/i/);
    expect(renderer).toMatch(/resolveTypedName\(n0, window\.__wlFolders/);
  });
  it('sidebar: box create/rename + note-in-box', () => {
    expect(sidebar.match(/nameNoSlash\(/g).length).toBeGreaterThanOrEqual(3);
  });
  it('pdf: PDF rename + capture-target create', () => {
    expect(pdf).toMatch(/let to = nameNoSlash\(nm\.trim\(\)\); if \(!\/\\\.pdf\$\/i/);
    expect(pdf).toMatch(/nameNoSlash\(inp\.value\.trim\(\)\.replace\(\/\\\.md\$\/i, ''\)\)/);
  });
});
