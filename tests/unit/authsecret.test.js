import { describe, it, expect, afterEach } from 'vitest';
const { startServer } = require('../../server/index');
const fs = require('fs'); const path = require('path'); const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-authsecret-' + counter + '-' + process.pid);
}

describe('AUTH_SECRET resolution', () => {
  const prev = process.env.AUTH_SECRET;
  afterEach(() => { if (prev === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = prev; });

  it('happy: env AUTH_SECRET wins over an existing secret file', async () => {
    const dir = tmpDir(); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.auth-secret'), 'file-secret-value');
    process.env.AUTH_SECRET = 'env-secret-value';
    const s = await startServer({ port: 0, dataDir: dir });
    try {
      expect(s.secret).toBe('env-secret-value');
      // file untouched
      expect(fs.readFileSync(path.join(dir, '.auth-secret'), 'utf8')).toBe('file-secret-value');
    } finally { await s.close(); }
  });

  it('happy: no env -> generate + persist, and a restart on the same dataDir gets the same secret back', async () => {
    const dir = tmpDir();
    const s1 = await startServer({ port: 0, dataDir: dir });
    try {
      expect(typeof s1.secret).toBe('string');
      expect(s1.secret.length).toBeGreaterThanOrEqual(64); // 32 bytes hex
      const file = path.join(dir, '.auth-secret');
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf8').trim()).toBe(s1.secret);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally { await s1.close(); }

    const s2 = await startServer({ port: 0, dataDir: dir });
    try { expect(s2.secret).toBe(s1.secret); } finally { await s2.close(); }
  });

  it('edge: existing file with a value is used as-is (no regeneration)', async () => {
    const dir = tmpDir(); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.auth-secret'), '  pre-existing-secret  ');
    const s = await startServer({ port: 0, dataDir: dir });
    try {
      expect(s.secret).toBe('pre-existing-secret'); // trimmed
      expect(fs.readFileSync(path.join(dir, '.auth-secret'), 'utf8')).toBe('  pre-existing-secret  '); // file not rewritten
    } finally { await s.close(); }
  });

  it('edge: empty / whitespace-only file is regenerated over', async () => {
    const dir = tmpDir(); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.auth-secret'), '   \n\t  ');
    const s = await startServer({ port: 0, dataDir: dir });
    try {
      expect(s.secret.length).toBeGreaterThanOrEqual(64);
      expect(fs.readFileSync(path.join(dir, '.auth-secret'), 'utf8').trim()).toBe(s.secret);
    } finally { await s.close(); }
  });
});
