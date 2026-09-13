// Email sender — the ONLY side-effecting half of the email pipeline (the pure
// request/message building lives in core/email.js). No dependency beyond the
// global fetch (Node 18+), per the no-new-npm-deps rule.
//
// Behavior:
// - RESEND_API_KEY set    -> real send via https://api.resend.com/emails (10s timeout).
// - RESEND_API_KEY unset  -> dev-mode: log the message and report success, so a
//   home/self-host server (and tests) get the full flow with codes visible in the log.
// Errors are logged, never thrown — email must not take down an auth request.
const { buildEmailRequest } = require('../core/email');

const DEFAULT_FROM = 'Kumiko <no-reply@aquoracore.com>';

async function sendEmail(msg, fetchImpl) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || DEFAULT_FROM;
  if (!apiKey) {
    console.log('[email dev-mode] to=' + (msg && msg.to) + ' subject=' + (msg && msg.subject) + ' body=' + (msg && msg.text));
    return true;
  }
  const req = buildEmailRequest('resend', { apiKey, from }, msg);
  if (!req) { console.log('[email] no provider request could be built'); return false; }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await (fetchImpl || fetch)(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: ctl.signal,
      });
      if (!res.ok) { console.log('[email] resend failed: HTTP ' + res.status); return false; }
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.log('[email] send error: ' + (e && e.message));
    return false;
  }
}

module.exports = { sendEmail, DEFAULT_FROM };
