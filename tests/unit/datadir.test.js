import { describe, it, expect, afterEach } from 'vitest';
const { startServer } = require('../../server/index');
const fs = require('fs'); const path = require('path'); const os = require('os');

describe('DATA_DIR env', () => {
  const prev = process.env.DATA_DIR;
  afterEach(() => { if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev; });

  it('startServer() with no opts.dataDir writes users under process.env.DATA_DIR', async () => {
    const dir = path.join(os.tmpdir(), 'washi-datadir-' + process.pid + '-' + Math.floor(process.hrtime()[1]));
    process.env.DATA_DIR = dir;
    const s = await startServer({ port: 0 });
    try {
      await fetch('http://127.0.0.1:'+s.port+'/auth/signup', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email:'dd@e2e.local', password:'secret123' }) });
      expect(fs.existsSync(path.join(dir, 'users.json'))).toBe(true);
    } finally { await s.close(); }
  });
});
