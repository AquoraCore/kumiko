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
    // Code-based verification (REQUIRE_EMAIL_VERIFY): no token yet — ask for the 6-digit code.
    if (r.ok && body.pendingVerify) {
      webLoginMode('verify');
      msg.style.color = '#059669';
      msg.textContent = 'ส่งรหัส 6 หลักไปที่อีเมลแล้ว กรอกเพื่อยืนยัน / A 6-digit code was emailed to you';
      return;
    }
    // Signup with link verification on: no token yet — tell the user to check their email.
    if (r.ok && body.verifyRequired) { msg.style.color = '#059669'; msg.textContent = 'สมัครแล้ว! เช็คอีเมลเพื่อยืนยันบัญชี จากนั้นเข้าสู่ระบบ'; return; }
    if (!r.ok) {
      if (body.pendingVerify) { // login while unverified → jump to the code form
        webLoginMode('verify');
        msg.textContent = 'ยังไม่ได้ยืนยันอีเมล — กรอกรหัส 6 หลัก / Verify your email — enter the 6-digit code';
        return;
      }
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

// ---- login-card modes: login | verify | forgot | reset --------------------------------
const WEB_LOGIN_IDS = ['webLoginEmail','webLoginPass','webLoginBtn','webSignupBtn','webForgotLink','webLoginCode','webVerifyBtn','webResendBtn','webResetToken','webNewPass','webForgotBtn','webResetBtn','webBackLogin'];
function webLoginMode(mode) {
  const show = {
    login:  ['webLoginEmail','webLoginPass','webLoginBtn','webSignupBtn','webForgotLink'],
    verify: ['webLoginEmail','webLoginCode','webVerifyBtn','webResendBtn','webBackLogin'],
    forgot: ['webLoginEmail','webForgotBtn','webBackLogin'],
    reset:  ['webLoginEmail','webResetToken','webNewPass','webResetBtn','webBackLogin'],
  }[mode] || ['webLoginEmail','webLoginPass','webLoginBtn','webSignupBtn','webForgotLink'];
  WEB_LOGIN_IDS.forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = show.indexOf(id) >= 0 ? '' : 'none'; });
  const msg = document.getElementById('webLoginMsg');
  msg.textContent = ''; msg.style.color = '';
}

async function webJson(path, body) {
  const r = await fetch(location.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { r, j: await r.json().catch(() => ({})) };
}

async function webVerify() {
  const msg = document.getElementById('webLoginMsg');
  msg.textContent = '';
  try {
    const { r, j } = await webJson('/auth/verify', {
      email: document.getElementById('webLoginEmail').value.trim(),
      code: document.getElementById('webLoginCode').value.trim(),
    });
    if (r.ok && j.token) {
      await window.api.authSetToken(j.token, j.email);
      document.getElementById('webLogin').style.display = 'none';
      location.reload();
      return;
    }
    const e = String(j.error || '');
    msg.style.color = '';
    msg.textContent = e.indexOf('expired') >= 0 ? 'โค้ดหมดอายุ — กดส่งโค้ดใหม่ / Code expired — resend'
      : e.indexOf('too many') >= 0 ? 'ลองผิดหลายครั้ง — กดส่งโค้ดใหม่ / Too many attempts — resend'
      : 'โค้ดไม่ถูกต้อง / Invalid code';
  } catch { msg.style.color = ''; msg.textContent = 'เชื่อมต่อไม่ได้'; }
}

async function webResend() {
  const msg = document.getElementById('webLoginMsg');
  msg.textContent = '';
  try {
    const { r, j } = await webJson('/auth/resend-code', { email: document.getElementById('webLoginEmail').value.trim() });
    msg.style.color = r.ok ? '#059669' : '';
    msg.textContent = r.ok ? 'ส่งโค้ดใหม่แล้ว / Code resent' : (j.error || 'error ' + r.status);
  } catch { msg.style.color = ''; msg.textContent = 'เชื่อมต่อไม่ได้'; }
}

async function webForgot() {
  const msg = document.getElementById('webLoginMsg');
  msg.textContent = '';
  try {
    const { r } = await webJson('/auth/forgot', { email: document.getElementById('webLoginEmail').value.trim() });
    if (!r.ok) { msg.style.color = ''; msg.textContent = 'error ' + r.status; return; }
    webLoginMode('reset');
    msg.style.color = '#059669';
    msg.textContent = 'ถ้ามีบัญชีนี้ ระบบส่งโค้ดตั้งรหัสใหม่ไปที่อีเมลแล้ว / If the account exists, a reset code was sent';
  } catch { msg.style.color = ''; msg.textContent = 'เชื่อมต่อไม่ได้'; }
}

async function webReset() {
  const msg = document.getElementById('webLoginMsg');
  msg.textContent = '';
  try {
    const { r, j } = await webJson('/auth/reset', {
      email: document.getElementById('webLoginEmail').value.trim(),
      token: document.getElementById('webResetToken').value.trim(),
      newPassword: document.getElementById('webNewPass').value,
    });
    if (r.ok) {
      webLoginMode('login');
      msg.style.color = '#059669';
      msg.textContent = 'ตั้งรหัสผ่านใหม่แล้ว — เข้าสู่ระบบได้เลย / Password reset — log in';
      return;
    }
    const map = { 'password too short': 'รหัสผ่านสั้นเกินไป (8 ตัวขึ้นไป) / Password too short (8+)', 'invalid token': 'โค้ดไม่ถูกต้องหรือหมดอายุ / Invalid or expired code' };
    msg.style.color = '';
    msg.textContent = map[j.error] || j.error || ('error ' + r.status);
  } catch { msg.style.color = ''; msg.textContent = 'เชื่อมต่อไม่ได้'; }
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
  document.getElementById('webVerifyBtn').onclick = webVerify;
  document.getElementById('webResendBtn').onclick = webResend;
  document.getElementById('webForgotBtn').onclick = webForgot;
  document.getElementById('webResetBtn').onclick = webReset;
  document.getElementById('webForgotLink').onclick = (e) => { e.preventDefault(); webLoginMode('forgot'); };
  document.getElementById('webBackLogin').onclick = (e) => { e.preventDefault(); webLoginMode('login'); };
  document.getElementById('webLoginCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') webVerify(); });
  // Arriving from a reset-email link: /?reset=<token>&email=<addr> → open the form prefilled.
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('reset')) {
      document.getElementById('webResetToken').value = q.get('reset');
      if (q.get('email')) document.getElementById('webLoginEmail').value = q.get('email');
      webLoginMode('reset');
    }
  } catch (_) {}
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
