import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const { createWebApi } = require('../../web/api-web');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-webpdf-' + counter + '-' + process.pid);
}

async function signup(base, email) {
  const r = await fetch(base + '/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const body = await r.json();
  return body.token;
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n fake pdf body');

describe('web pdfs (per-user cloud PDF storage + annot sidecars)', () => {
  it('HAPPY: upload, list, read, annotate, rename a PDF', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const token = await signup(base, 'webpdf-happy@b.com');
    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      const up = await api.uploadPdf('doc.pdf', PDF_BYTES);
      expect(up).toEqual({ name: 'doc.pdf' });

      expect((await api.listNotes()).pdfs).toContain('doc.pdf');

      const back = await api.readPdf('doc.pdf');
      expect(Buffer.from(back).equals(PDF_BYTES)).toBe(true);

      expect(await api.saveAnnots('doc.pdf', { highlights: [{ id: 'h1', text: 'x' }] })).toBe(true);
      expect((await api.readAnnots('doc.pdf')).highlights.length).toBe(1);

      const rn = await api.renamePdf('doc.pdf', 'renamed.pdf');
      expect(rn).toEqual({ name: 'renamed.pdf' });
      // sidecar moved with the file
      expect((await api.readAnnots('renamed.pdf')).highlights.length).toBe(1);
      // old name gone
      expect(await api.readPdf('doc.pdf')).toBe(null);
    } finally {
      await s.close();
    }
  }, 20000);

  it('EDGE: dedup, isolation, missing, bad rename', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const tokA = await signup(base, 'a-webpdf@b.com');
      const api = createWebApi({ baseUrl: base, getToken: () => tokA });

      await api.uploadPdf('same.pdf', PDF_BYTES);
      const dup = await api.uploadPdf('same.pdf', PDF_BYTES);
      expect(dup.name).toBe('same (1).pdf');

      expect(await api.readPdf('nope.pdf')).toBe(null);

      const bad = await api.renamePdf('same.pdf', 'same (1).pdf');
      expect(bad.error).toBe('exists');

      // per-user isolation: second signup -> apiB; B cannot see or read A's pdf
      const tokB = await signup(base, 'b-webpdf@b.com');
      const apiB = createWebApi({ baseUrl: base, getToken: () => tokB });
      expect((await apiB.listNotes()).pdfs).not.toContain('renamed.pdf');
      expect(await apiB.readPdf('renamed.pdf')).toBe(null);
    } finally {
      await s.close();
    }
  }, 20000);
});
