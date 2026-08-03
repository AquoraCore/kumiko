import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-webstatic-' + counter + '-' + process.pid);
}

describe('web static /vendor (pdf.js worker route)', () => {
  it('the pdf.js worker is served at /vendor for the web viewer', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const r = await fetch(base + '/vendor/pdfjs/pdf.worker.min.js');
      expect(r.status).toBe(200);
      const ct = r.headers.get('content-type') || '';
      expect(ct).toMatch(/javascript/);
      await r.arrayBuffer(); // drain the 1.1MB body so s.close() doesn't wait on an open connection
      const r2 = await fetch(base + '/vendor/pdfjs/pdf.min.js');
      expect(r2.status).toBe(200);
      await r2.arrayBuffer();
    } finally {
      await s.close();
    }
  });

  it('a missing vendor asset 404s, not 200', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const r3 = await fetch(base + '/vendor/pdfjs/nope.js');
      expect(r3.status).toBe(404);
    } finally {
      await s.close();
    }
  });
});
