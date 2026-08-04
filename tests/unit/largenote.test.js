import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const { createWebApi } = require('../../web/api-web');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-largenote-' + counter + '-' + process.pid);
}

async function signup(base, email) {
  const r = await fetch(base + '/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  return (await r.json()).token;
}

// Regression: crop-into-note embeds a base64 PNG data-URI in the note markdown.
// Such a note exceeds express.json's 100kb DEFAULT, which used to 413 -> saveNote
// silently failed on WEB (desktop writes a file, no limit). The server must accept
// a multi-hundred-kB note body.
describe('web notes accept large bodies (crop-into-note data-URI)', () => {
  it('HAPPY: a ~600kB note (simulated crop image) saves and reads back intact', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const token = await signup(base, 'largenote@b.com');
    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      const bigDataUri = 'data:image/png;base64,' + 'A'.repeat(600 * 1024); // ~600kB, over the old 100kb cap
      const content = '### หน้า 1\n\n![ครอปหน้า 1](' + bigDataUri + ')\n';
      const r = await api.saveNote('PDF (คู่หู).md', content);
      expect(r.ok).toBe(true);                                   // was false (413) before the limit bump
      const back = await api.readNote('PDF (คู่หู).md');
      expect(back).toBe(content);                                // round-trips byte-for-byte
    } finally {
      await s.close();
    }
  }, 20000);
});
