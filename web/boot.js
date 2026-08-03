// Phase 7d-3a: web boot — install the window.api shim, then wire the login overlay.
// Runs BEFORE renderer scripts (loaded right after api-web.js).
window.api = window.createWebApi({ baseUrl: location.origin, store: window.localStorage });

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
    if (!r.ok) { msg.textContent = body.error || ('error ' + r.status); return; }
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
  if (!webAuthed()) box.style.display = 'flex';
  document.getElementById('webLoginBtn').onclick = () => webAuth('login');
  document.getElementById('webSignupBtn').onclick = () => webAuth('signup');
});
