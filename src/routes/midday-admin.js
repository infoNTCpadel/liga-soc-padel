// MEDIODÍA PADEL — administración (ediciones, parejas inscritas, ajustes, datos de prueba).
// Usa la misma sesión de organización que /admin. Opera SOLO sobre midday.db.
const express = require('express');
const router = express.Router();
const { middayDb, middayGet, middaySet, getAdminHash, MIDDAY_DEFAULTS } = require('../db');
const M = require('../lib/midday');

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
  };

  const slotLabels = form.slots_text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!slotLabels.length) errors.push('Define al menos una franja horaria (una por línea).');
  if (form.inscription_deadline && !/^\d{4}-\d{2}-\d{2}$/.test(form.inscription_deadline))
    errors.push('La fecha límite no es válida (AAAA-MM-DD).');
  const courts = parseInt(form.courts_midday, 10);
  if (!(courts >= 1 && courts <= 20)) errors.push('Nº de pistas: entre 1 y 20.');
  const mindays = parseInt(form.min_days_between, 10);
  if (!(mindays >= 0 && mindays <= 30)) errors.push('Días mínimos entre partidos: entre 0 y 30.');

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
  res.redirect('/admin/mediodia/ajustes?t=' + tid + '&ok=Ajustes guardados.');
});

module.exports = router;
