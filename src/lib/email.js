// Envío de emails vía Brevo (API SMTP).
// Requiere BREVO_API_KEY y MAIL_FROM en el entorno: si faltan,
// sendEmail devuelve { skipped: true } sin intentar nada.
async function sendEmail(to, subject, html, senderName) {
  const key = process.env.BREVO_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) return { skipped: true };
  const recipients = (Array.isArray(to) ? to : [to])
    .map(e => String(e || '').trim()).filter(Boolean)
    .map(email => ({ email }));
  if (!recipients.length) return { skipped: true };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: from, name: senderName || 'Liga social de pádel' },
      to: recipients,
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error('Brevo respondió ' + res.status);
  return { ok: true, count: recipients.length };
}

function mailConfigured() {
  return !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM);
}

// Escape mínimo para interpolar texto de usuarios en el HTML del email.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

module.exports = { sendEmail, mailConfigured, esc };
