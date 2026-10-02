// MEDIODÍA PADEL — administración (ediciones, parejas inscritas, ajustes, datos de prueba).
// Usa la misma sesión de organización que /admin. Opera SOLO sobre midday.db.
const express = require('express');
const router = express.Router();
const { middayDb, middayGet, middaySet, getAdminHash, MIDDAY_DEFAULTS, nextMondayISO } = require('../db');
const M = require('../lib/midday');
const D = require('../lib/midday-draw');

function requireAdmin(req, res, next) {
  res.locals.section = 'admin';
  if (!getAdminHash()) return res.redirect('/admin/setup');
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}
router.use(requireAdmin);

// Edición seleccionada (?t=): por defecto la abierta actual.
function selTournament(req) {
  const all = M.listTournaments(middayDb);
  let sel = null;
  if (req.query.t) sel = M.getTournament(middayDb, Number(req.query.t));
  if (!sel) sel = M.currentTournament(middayDb);
  if (!sel && all.length) sel = all[all.length - 1];
  return { all, sel };
}
const backTo = (tid, extra) => '/admin/mediodia?t=' + tid + (extra ? '&' + extra : '');

// ---- Panel de parejas ----
router.get('/', (req, res) => {
  const { all, sel } = selTournament(req);
  const tid = sel ? sel.id : null;
  const pairs = tid ? M.listPairs(middayDb, tid) : [];
  const sl = M.parseSlots(middayGet('slots', '[]', tid));
  res.renderPage('midday/admin/panel', {
    tournaments: all,
    sel,
    statusNames: M.TOURNAMENT_STATUS_NAMES,
    pairs,
    slots: sl,
    slotSummary: (p) => M.fmtSlotPrefs(p.slotPrefs, sl),
    weekdaysOff: (p) => M.fmtWeekdaysOff(p.weekdaysOff),
    testCount: tid ? M.countTestPairs(middayDb, tid) : 0,
    info: req.query.ok || null,
    error: req.query.error || null,
    sub: 'mediodia',
  });
});

router.post('/parejas/:id/aprobar', (req, res) => {
  M.setStatus(middayDb, req.params.id, 'approved');
  res.redirect(backTo(req.body.t, 'ok=Pareja aprobada.'));
});
router.post('/parejas/:id/rechazar', (req, res) => {
  M.setStatus(middayDb, req.params.id, 'rejected');
  res.redirect(backTo(req.body.t, 'ok=Pareja rechazada.'));
});
router.post('/parejas/:id/pendiente', (req, res) => {
  M.setStatus(middayDb, req.params.id, 'pending');
  res.redirect(backTo(req.body.t, 'ok=Pareja marcada como pendiente.'));
});
router.post('/parejas/:id/eliminar', (req, res) => {
  M.deletePair(middayDb, req.params.id);
  res.redirect(backTo(req.body.t, 'ok=Pareja eliminada.'));
});
router.post('/parejas/:id/nivel', (req, res) => {
  const ok = M.updateLevels(middayDb, req.params.id, req.body.level1, req.body.level2);
  res.redirect(backTo(req.body.t, 'ok=' + (ok ? 'Nivel actualizado.' : 'Nivel no válido (1–7 en pasos de 0,25).')));
});

// ---- Ediciones ----
router.post('/ediciones/nueva', (req, res) => {
  const r = M.createTournament(middayDb, req.body.name, req.body.copy_from || null, MIDDAY_DEFAULTS);
  if (!r.ok) return res.redirect('/admin/mediodia?error=' + encodeURIComponent(r.error));
  res.redirect(backTo(r.id, 'ok=Edición creada.'));
});
router.post('/ediciones/:id/renombrar', (req, res) => {
  const ok = M.renameTournament(middayDb, req.params.id, req.body.name);
  res.redirect(backTo(req.params.id, ok ? 'ok=Edición renombrada.' : 'error=El nombre no puede estar vacío.'));
});
router.post('/ediciones/:id/estado', (req, res) => {
  const r = M.setTournamentStatus(middayDb, req.params.id, req.body.status);
  if (!r.ok) return res.redirect(backTo(req.params.id, 'error=' + encodeURIComponent(r.error)));
  res.redirect(backTo(req.params.id, 'ok=Estado actualizado.'));
});
router.post('/ediciones/:id/eliminar', (req, res) => {
  const r = M.deleteTournament(middayDb, req.params.id);
  if (!r.ok) return res.redirect(backTo(req.params.id, 'error=' + encodeURIComponent(r.error)));
  res.redirect('/admin/mediodia?ok=Edición eliminada.');
});

// ---- Datos de prueba ----
router.post('/pruebas/generar', (req, res) => {
  const tid = Number(req.body.t);
  if (!M.getTournament(middayDb, tid)) return res.redirect('/admin/mediodia?error=Edición no válida.');
  const n = Math.min(30, Math.max(1, parseInt(req.body.n, 10) || 8));
  try {
    const created = M.generateTestPairs(middayDb, tid, n);
    res.redirect(backTo(tid, `ok=${created.length} parejas de prueba generadas.`));
  } catch (e) {
    console.error('midday pruebas', e);
    res.redirect(backTo(tid, 'error=No se pudieron generar los datos de prueba.'));
  }
});
router.post('/pruebas/eliminar', (req, res) => {
  const tid = Number(req.body.t);
  const n = M.deleteTestPairs(middayDb, tid);
  res.redirect(backTo(tid, `ok=${n} parejas de prueba eliminadas.`));
});

// ---- Ajustes (por edición) ----
function settingsForm(tid) {
  const rawSlots = M.parseSlots(middayGet('slots', '[]', tid));
  return {
    comp_name: middayGet('comp_name', 'MEDIODÍA PADEL', tid),
    slots_text: rawSlots.map(s => s.label).join('\n'),
    inscription_open: middayGet('inscription_open', '1', tid) === '1',
    inscription_deadline: middayGet('inscription_deadline', '', tid),
    courts_midday: middayGet('courts_midday', '4', tid),
    min_days_between: middayGet('min_days_between', '4', tid),
    start_date: middayGet('start_date', '', tid) || nextMondayISO(),
    test_email: middayGet('test_email', '', tid),
  };
}

// Ajustes que usa el programador del calendario (ámbito: edición).
function drawSettings(tid) {
  return {
    slots: M.parseSlots(middayGet('slots', '[]', tid)),
    courts: Math.max(1, parseInt(middayGet('courts_midday', '4', tid), 10) || 4),
    minDays: Math.max(0, parseInt(middayGet('min_days_between', '4', tid), 10) || 0),
    startDate: middayGet('start_date', '', tid) || nextMondayISO(),
  };
}

router.get('/ajustes', (req, res) => {
  const { all, sel } = selTournament(req);
  if (!sel) return res.redirect('/admin/mediodia?error=No hay ninguna edición.');
  res.renderPage('midday/admin/ajustes', {
    tournaments: all, sel, statusNames: M.TOURNAMENT_STATUS_NAMES,
    form: settingsForm(sel.id), errors: [], info: req.query.ok || null, sub: 'mediodia',
  });
});

router.post('/ajustes', (req, res) => {
  const b = req.body || {};
  const tid = Number(b.t);
  const sel = M.getTournament(middayDb, tid);
  if (!sel) return res.redirect('/admin/mediodia?error=Edición no válida.');
  const errors = [];
  const form = {
    comp_name: String(b.comp_name || '').trim() || 'MEDIODÍA PADEL',
    slots_text: String(b.slots_text || ''),
    inscription_open: !!b.inscription_open,
    inscription_deadline: String(b.inscription_deadline || '').trim(),
    courts_midday: String(b.courts_midday || '').trim(),
    min_days_between: String(b.min_days_between || '').trim(),
    start_date: String(b.start_date || '').trim(),
    test_email: String(b.test_email || '').trim().toLowerCase(),
  };

  const slotLabels = form.slots_text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!slotLabels.length) errors.push('Define al menos una franja horaria (una por línea).');
  if (form.inscription_deadline && !/^\d{4}-\d{2}-\d{2}$/.test(form.inscription_deadline))
    errors.push('La fecha límite no es válida (AAAA-MM-DD).');
  const courts = parseInt(form.courts_midday, 10);
  if (!(courts >= 1 && courts <= 20)) errors.push('Nº de pistas: entre 1 y 20.');
  const mindays = parseInt(form.min_days_between, 10);
  if (!(mindays >= 0 && mindays <= 30)) errors.push('Días mínimos entre partidos: entre 0 y 30.');
  if (!form.start_date) form.start_date = nextMondayISO();
  if (!D.parseISODate(form.start_date)) errors.push('La fecha de inicio no es válida (AAAA-MM-DD).');
  if (form.test_email && !M.validEmail(form.test_email)) errors.push('El email de pruebas no es válido.');

  if (errors.length)
    return res.renderPage('midday/admin/ajustes', {
      tournaments: M.listTournaments(middayDb), sel, statusNames: M.TOURNAMENT_STATUS_NAMES,
      form, errors, info: null, sub: 'mediodia',
    });

  middaySet('comp_name', form.comp_name, tid);
  middaySet('slots', JSON.stringify(slotLabels.map((label, i) => ({ id: `s${i + 1}`, label }))), tid);
  middaySet('inscription_open', form.inscription_open ? '1' : '0', tid);
  middaySet('inscription_deadline', form.inscription_deadline, tid);
  middaySet('courts_midday', String(courts), tid);
  middaySet('min_days_between', String(mindays), tid);
  middaySet('start_date', form.start_date, tid);
  middaySet('test_email', form.test_email, tid);
  res.redirect('/admin/mediodia/ajustes?t=' + tid + '&ok=Ajustes guardados.');
});

// ---- Sorteo y calendario (Fase B) ----
function renderSorteo(res, tid, extra = {}) {
  const { all, sel } = selTournament({ query: { t: String(tid) } });
  if (!sel) return res.redirect('/admin/mediodia?error=No hay ninguna edición.');
  const draw = D.drawForTournament(middayDb, tid);
  const approvedCount = middayDb.prepare(
    "SELECT COUNT(*) c FROM midday_pairs WHERE tournament_id = ? AND status = 'approved'").get(tid).c;
  const settings = drawSettings(tid);
  res.renderPage('midday/admin/sorteo', {
    tournaments: all, sel, statusNames: M.TOURNAMENT_STATUS_NAMES,
    draw,
    pots: draw ? D.drawPots(middayDb, draw.id) : [],
    matches: draw ? D.drawMatches(middayDb, draw.id).sort(D.compareForReview) : [],
    warnings: draw ? D.drawWarnings(middayDb, draw.id, settings) : null,
    approvedCount,
    settings,
    slotLabel: (m) => D.matchSlotLabel(m, settings.slots),
    fmtDate: D.fmtMatchDate,
    formatScore: D.formatScore,
    info: null,
    error: null,
    bulkResults: {},
    bulkSummary: null,
    sub: 'mediodia',
    ...extra,
  });
}
router.get('/sorteo', (req, res) => {
  const { sel } = selTournament(req);
  if (!sel) return res.redirect('/admin/mediodia?error=No hay ninguna edición.');
  renderSorteo(res, sel.id, { info: req.query.ok || null, error: req.query.error || null });
});

router.post('/sorteo/generar', (req, res) => {
  const tid = Number(req.body.t);
  try {
    const r = D.buildDraw(middayDb, tid); // bombos + emparejamientos + calendario propuesto
    let msg = `Sorteo generado: ${r.pairs} parejas en ${r.rounds} rondas. ${r.scheduled} de ${r.scheduled + r.unscheduled.length} partidos programados.`;
    if (r.unscheduled.length) msg += ` ${r.unscheduled.length} sin programar: revisa los avisos.`;
    res.redirect(`/admin/mediodia/sorteo?t=${tid}&ok=` + encodeURIComponent(msg));
  } catch (e) {
    res.redirect(`/admin/mediodia/sorteo?t=${tid}&error=` + encodeURIComponent(e.message));
  }
});

// Guarda en bloque todos los retoques del calendario (una sola confirmación).
// Las filas sin fecha se dejan como están; las que no cambian se omiten.
router.post('/sorteo/guardar-todo', (req, res) => {
  const tid = Number(req.body.t);
  const draw = D.drawForTournament(middayDb, tid);
  if (!draw || draw.status !== 'draft')
    return res.redirect(`/admin/mediodia/sorteo?t=${tid}&error=` + encodeURIComponent('No hay sorteo en borrador.'));
  const force = req.body.force_all === '1';
  const changes = D.drawMatches(middayDb, draw.id).map(m => {
    const norm = D.normalizeSlotInput(req.body['slot_' + m.id], req.body['ctime_' + m.id]);
    return {
      id: m.id,
      iso: req.body['date_' + m.id],
      slotId: norm.slotId,
      customTime: norm.customTime,
      courtNo: req.body['court_' + m.id],
    };
  });
  const r = D.bulkReschedule(middayDb, draw.id, changes, drawSettings(tid), { force });
  const summary = !r.changed ? 'Sin cambios.' :
    `${r.ok} partido(s) programado(s)` + (r.errors ? ` · ${r.errors} con error (revísalos abajo)` : '') + '.';
  renderSorteo(res, tid, { bulkResults: r.results, bulkSummary: summary, info: summary });
});

// Resolver disputa (aceptar el resultado) o reabrir un partido (borrar resultado).
router.post('/sorteo/resultado/:id/resolver', (req, res) => {
  const tid = Number(req.body.t);
  const m = middayDb.prepare('SELECT * FROM midday_matches WHERE id = ?').get(req.params.id);
  if (m && m.validation === 'disputed')
    middayDb.prepare("UPDATE midday_matches SET validation = 'validated' WHERE id = ?").run(m.id);
  res.redirect(`/admin/mediodia/sorteo?t=${tid}`);
});
router.post('/sorteo/resultado/:id/reabrir', (req, res) => {
  const tid = Number(req.body.t);
  middayDb.prepare(`UPDATE midday_matches SET s1a = NULL, s1b = NULL, s2a = NULL, s2b = NULL,
    stb_a = NULL, stb_b = NULL, winner_id = NULL, wo_winner_id = NULL, submitted_by = NULL,
    submitted_at = NULL, validation = 'none', validation_deadline = NULL, notes = '' WHERE id = ?`)
    .run(req.params.id);
  res.redirect(`/admin/mediodia/sorteo?t=${tid}`);
});

// Publica el calendario y avisa por email a las parejas (si hay Brevo configurado).
router.post('/sorteo/publicar', async (req, res) => {
  const tid = Number(req.body.t);
  try {
    const draw = D.drawForTournament(middayDb, tid);
    if (!draw || draw.status !== 'draft')
      return res.redirect(`/admin/mediodia/sorteo?t=${tid}&error=` + encodeURIComponent('No hay sorteo en borrador para publicar.'));
    const pub = D.publishDraw(middayDb, draw.id);
    if (!pub.ok)
      return res.redirect(`/admin/mediodia/sorteo?t=${tid}&error=` + encodeURIComponent(pub.error));
    const summary = await sendPublishEmails(tid, draw.id);
    D.setDrawEmailSummary(middayDb, draw.id, { ...summary, at: new Date().toISOString() });
    let msg = 'Calendario publicado.';
    if (summary.testMode) msg += ` Modo pruebas: avisos enviados a ${summary.testEmail} (no a los jugadores).`;
    else if (!summary.brevo) msg += ' Aviso: sin BREVO_API_KEY/MAIL_FROM no se han enviado emails.';
    else msg += ` Emails: ${summary.sent} enviados, ${summary.skipped} omitidos` +
      (summary.failed ? `, ${summary.failed} con error` : '') + '.';
    res.redirect(`/admin/mediodia/sorteo?t=${tid}&ok=` + encodeURIComponent(msg));
  } catch (e) {
    console.error('midday publicar', e);
    res.redirect(`/admin/mediodia/sorteo?t=${tid}&error=` + encodeURIComponent('Error al publicar: ' + e.message));
  }
});

async function sendPublishEmails(tid, drawId) {
  const compName = middayGet('comp_name', 'MEDIODÍA PADEL', tid);
  const t = M.getTournament(middayDb, tid);
  const link = process.env.MIDDAY_HOST
    ? `https://${process.env.MIDDAY_HOST}/mediodia/acceso` : '/mediodia/acceso';
  const settings = drawSettings(tid);
  const slotLabel = (m) => D.matchSlotLabel(m, settings.slots);
  const pairs = M.listPairs(middayDb, tid).filter(p => p.status === 'approved');
  // Modo pruebas: si hay email de pruebas, TODOS los avisos van a esa dirección.
  const testEmail = (middayGet('test_email', '', tid) || '').trim().toLowerCase();
  let sent = 0, skipped = 0, failed = 0;
  for (const p of pairs) {
    const ms = D.pairMatches(middayDb, drawId, p.id).filter(m => m.match_date);
    const rows = ms.map(m => {
      const rival = m.pair1_id === p.id ? `${m.n2a} y ${m.n2b}` : `${m.n1a} y ${m.n1b}`;
      return `<li><strong>Ronda ${m.round_no}</strong> · ${D.fmtMatchDate(m.match_date)} · ${slotLabel(m)} · Pista ${m.court_no || '—'} · contra ${rival}</li>`;
    }).join('');
    const html = (testEmail ? `<p><strong>Aviso dirigido a: ${p.player1_name} / ${p.player2_name}</strong></p>` : '') +
      `<p>Hola ${p.player1_name} y ${p.player2_name},</p>` +
      `<p>El calendario de <strong>${compName}</strong>${t ? ` (${t.name})` : ''} ya está publicado. Vuestros partidos:</p>` +
      `<ul>${rows}</ul>` +
      `<p>Podéis consultarlos cuando queráis con vuestro código <strong>${p.code}</strong> en <a href="${link}">${link}</a>.</p>` +
      `<p>¡Nos vemos al mediodía!</p>`;
    const subject = (testEmail ? '[PRUEBA] ' : '') + `${compName} · Calendario publicado`;
    const recipients = testEmail ? [testEmail] : [p.player1_email, p.player2_email];
    for (const em of recipients) {
      if (!M.validEmail(em)) { skipped++; continue; }
      try {
        const r = await D.sendMiddayEmail(em, subject, html);
        if (r.skipped) skipped++; else sent++;
      } catch (e) { failed++; }
    }
  }
  return { sent, skipped, failed, brevo: !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM), testMode: !!testEmail, testEmail: testEmail || null };
}

module.exports = router;
