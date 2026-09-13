// Email pipeline — PURE pieces shared by the server (Node) and any UI that needs
// to preview messages. UMD like the other core modules: no side effects, no fetch.
//
// buildEmailRequest(provider, cfg, msg) -> {url, headers, body} | null
//   provider 'resend': POST https://api.resend.com/emails, Bearer auth.
//   any other provider (or a missing apiKey/from) -> null.
// Templates return {subject, text} — Thai first, English appended, one message.

function buildEmailRequest(provider, cfg, msg) {
  if (provider !== 'resend') return null;
  const apiKey = cfg && cfg.apiKey;
  const from = cfg && cfg.from;
  if (!apiKey || !from || !msg || !msg.to) return null;
  return {
    url: 'https://api.resend.com/emails',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: { from, to: msg.to, subject: msg.subject || '', text: msg.text || '' },
  };
}

function verifyEmailMsg(code) {
  return {
    subject: 'รหัสยืนยันอีเมล Kumiko / Kumiko verification code',
    text:
      'รหัสยืนยันอีเมลของคุณคือ ' + code + ' (ใช้ได้ 15 นาที)\n' +
      'ถ้าคุณไม่ได้สมัครเอง ข้ามอีเมลนี้ได้เลย\n\n' +
      'Your Kumiko verification code is ' + code + ' (valid for 15 minutes).\n' +
      'If you did not sign up, you can ignore this email.',
  };
}

function resetEmailMsg(link) {
  return {
    subject: 'ตั้งรหัสผ่านใหม่ Kumiko / Reset your Kumiko password',
    text:
      'ตั้งรหัสผ่านใหม่ได้ที่ลิงก์นี้ (ใช้ได้ 15 นาที): ' + link + '\n' +
      'ถ้าคุณไม่ได้ขอเอง ข้ามอีเมลนี้ได้เลย\n\n' +
      'Reset your Kumiko password with this link (valid for 15 minutes): ' + link + '\n' +
      'If you did not request this, you can ignore this email.',
  };
}

// NOTE: browser loads core/*.js as plain scripts sharing one global scope, so this
// top-level const must keep a file-unique name.
const _coreEmailApi = { buildEmailRequest, verifyEmailMsg, resetEmailMsg };
if (typeof module !== 'undefined' && module.exports) module.exports = _coreEmailApi;
if (typeof window !== 'undefined') window.CoreEmail = _coreEmailApi;
