// Phase 7d-3a: web boot — install the window.api shim, then wire the login overlay.
// Runs BEFORE renderer scripts (loaded right after api-web.js).
window.api = window.createWebApi({ baseUrl: location.origin, store: window.localStorage });
window.KUMIKO_WEB = true;
if (!localStorage.getItem("collabRelay")) localStorage.setItem("collabRelay", (location.protocol==="https:"?"wss":"ws")+"://"+location.host);

function webAuthed() {
  try { return !!(JSON.parse(localStorage.getItem('webAuth') || 'null') || {}).token; }
  catch { return false; }
}

async function webAuth(mode) {
  const email = document.getElementById('webLoginEmail').value.trim();
  const pass = document.getElementById('webLoginPass').value;
  const msg = document.getElementById('webLoginMsg');
  msg.textContent = '';
  try {
    const r = await fetch(location.origin + '/auth/' + mode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass }),
    });
    const body = await r.json().catch(() => ({}));
    // Signup with verification on: no token yet — tell the user to check their email.
    if (r.ok && body.verifyRequired) { msg.style.color = '#059669'; msg.textContent = 'สมัครแล้ว! เช็คอีเมลเพื่อยืนยันบัญชี จากนั้นเข้าสู่ระบบ'; return; }
    if (!r.ok) {
      const map = { email_not_verified: 'ยังไม่ได้ยืนยันอีเมล — เปิดลิงก์ยืนยันในอีเมลก่อน', not_allowed: 'อีเมลนี้ยังไม่ได้รับอนุญาตให้ใช้งาน', 'invalid credentials': 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' };
      msg.style.color = ''; msg.textContent = map[body.error] || body.error || ('error ' + r.status); return;
    }
    if (!body.token) { msg.textContent = 'ไม่ได้รับ token'; return; }
    await window.api.authSetToken(body.token, body.email);
    document.getElementById('webLogin').style.display = 'none';
    location.reload();
  } catch {
    msg.textContent = 'เชื่อมต่อไม่ได้';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const box = document.getElementById('webLogin');
  if (!box) return;
  if (!webAuthed()) {
    box.style.display = 'flex';
    setupGoogle(); // fire-and-forget; button stays hidden if no client id
    if (window.__hideSplash) window.__hideSplash(); // login is ready → drop the splash now (don't wait for heavy assets)
  }
  document.getElementById('webLoginBtn').onclick = () => webAuth('login');
  document.getElementById('webSignupBtn').onclick = () => webAuth('signup');
});

async function setupGoogle() {
  try {
    const cfg = await (await fetch(location.origin + '/auth/config')).json();
    const clientId = cfg && cfg.googleClientId;
    if (!clientId) return; // Google not configured -> leave the button hidden
    await new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.defer = true;
      sc.onload = res; sc.onerror = rej; document.head.appendChild(sc);
    });
    if (!(window.google && google.accounts && google.accounts.id)) return;
    google.accounts.id.initialize({ client_id: clientId, callback: onGoogleCredential });
    google.accounts.id.renderButton(document.getElementById('webGoogleBtn'),
      { theme: 'outline', size: 'large', width: 300 });
    document.getElementById('webGoogleWrap').style.display = 'block';
  } catch (_) { /* leave the button hidden on any failure */ }
}

async function onGoogleCredential(resp) {
  const idToken = resp && resp.credential;
  if (!idToken) return;
  const msg = document.getElementById('webLoginMsg');
  try {
    const r = await fetch(location.origin + '/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.token) { await window.api.authSetToken(j.token, j.email); location.reload(); }
    else if (msg) msg.textContent = (j && j.error) || 'Google login failed';
  } catch (_) { if (msg) msg.textContent = 'เชื่อมต่อไม่ได้'; }
}
