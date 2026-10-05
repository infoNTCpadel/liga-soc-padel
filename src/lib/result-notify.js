// Aviso por email a la pareja rival cuando se sube un resultado pendiente de validar.
// Si el email no está configurado o la rival no tiene email, no se hace nada.
const L = require('./league');
const { sendEmail, esc } = require('./email');

function formatScore(m) {
  if (m.wo_winner_id) return 'W.O.';
  const parts = [];
  if (m.s1a != null && m.s1b != null) parts.push(`${m.s1a}-${m.s1b}`);
  if (m.s2a != null && m.s2b != null) parts.push(`${m.s2a}-${m.s2b}`);
  if (m.stb_a != null && m.stb_b != null) parts.push(`súper tie-break ${m.stb_a}-${m.stb_b}`);
  return parts.join(', ') || '—';
}

function matchContext(db, m) {
  const cat = L.catName(m.category);
  if (L.isPlayoffStage(m.stage)) return `${cat} · Playoff ${L.playoffOrdinal(m.stage)}`;
  if (m.group_id) {
    const g = db.prepare('SELECT group_no FROM groups WHERE id = ?').get(m.group_id);
    return `${cat} · Ronda ${m.round_no} · Grupo ${g ? g.group_no : '—'}`;
  }
  return `${cat} · Ronda ${m.round_no}`;
}

// Devuelve { recipients, subject, html } o null si no hay a quién avisar.
function validationEmailData(db, matchId, baseUrl, clubName) {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!m || !m.submitted_by || m.validation !== 'pending') return null;
  const rivalId = m.pair_a_id === m.submitted_by ? m.pair_b_id : m.pair_a_id;
  if (!rivalId) return null;
  const r = db.prepare(
    `SELECT p1.email AS e1, p2.email AS e2 FROM pairs p
     JOIN players p1 ON p1.id = p.player1_id
     JOIN players p2 ON p2.id = p.player2_id
     WHERE p.id = ?`).get(rivalId);
  if (!r) return null;
  const recipients = [...new Set(
    [r.e1, r.e2].map(e => String(e || '').trim()).filter(Boolean)
  )];
  if (!recipients.length) return null;
  const link = String(baseUrl || '').replace(/\/+$/, '') + '/acceso';
  const subject = `Resultado pendiente de validar · ${clubName}`;
  const what = m.wo_winner_id
    ? 'ha indicado <strong>W.O.</strong> a su favor en vuestro partido'
    : 'ha subido el resultado de vuestro partido';
  const scoreLine = m.wo_winner_id ? '' :
    `:<br><span style="font-size:18px"><strong>${esc(formatScore(m))}</strong></span>`;
  const html =
    `<p>Hola,</p>` +
    `<p>La pareja <strong>${esc(L.pairName(db, m.submitted_by))}</strong> ${what} ` +
    `(<strong>${esc(matchContext(db, m))}</strong>)${scoreLine}</p>` +
    `<p>Entra con tu <strong>código de pareja</strong> en ` +
    `<a href="${esc(link)}">${esc(link)}</a> para <strong>validarlo</strong> o <strong>disputarlo</strong>.</p>` +
    `<p>Si no haces nada en 24 horas, el resultado se validará automáticamente.</p>`;
  return { recipients, subject, html };
}

// Envía el aviso; nunca lanza: un fallo de email no puede romper la subida del resultado.
async function notifyRivalValidation(db, matchId, baseUrl, clubName) {
  try {
    const data = validationEmailData(db, matchId, baseUrl, clubName);
    if (!data) return { skipped: true };
    const results = [];
    for (const to of data.recipients) {
      results.push(await sendEmail(to, data.subject, data.html, clubName));
    }
    const sent = results.filter(r => r.ok).length;
    console.log(`notifyRivalValidation: partido ${matchId} → email a ${sent}/${data.recipients.length} destinatario(s)`);
    return { ok: true, results };
  } catch (e) {
    console.error('notifyRivalValidation:', e.message);
    return { error: e.message };
  }
}

module.exports = { formatScore, matchContext, validationEmailData, notifyRivalValidation };
