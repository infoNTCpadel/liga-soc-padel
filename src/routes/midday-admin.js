// MEDIODÍA PADEL — administración (Fase A: parejas inscritas y ajustes).
// Usa la misma sesión de organización que /admin. Opera SOLO sobre midday.db.
const express = require('express');
const router = express.Router();
const { middayDb, middayGet, middaySet, getAdminHash } = require('../db');
const M = require('../lib/midday');

function requireAdmin(req, res, next) {
  res.locals.section = 'admin';
  if (!getAdminHash()) return res.redirect('/admin/setup');
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}
router.use(requireAdmin);

// ---- Panel de parejas ----
router.get('/', (req, res) => {
  const pairs = M.listPairs(middayDb);
  const sl = M.parseSlots(middayGet('slots', '[]'));
  res.renderPage('midday/admin/panel', {
    pairs,
    slots: sl,
    slotSummary: (p) => M.fmtSlotPrefs(p.slotPrefs, sl),
    weekdaysOff: (p) => M.fmtWeekdaysOff(p.weekdaysOff),
    info: req.query.ok || null,
    sub: 'mediodia',
  });
});

router.post('/parejas/:id/aprobar', (req, res) => {
  M.setStatus(middayDb, req.params.id, 'approved');
  res.redirect('/admin/mediodia?ok=Pareja aprobada.');
});
router.post('/parejas/:id/rechazar', (req, res) => {
  M.setStatus(middayDb, req.params.id, 'rejected');
  res.redirect('/admin/mediodia?ok=Pareja rechazada.');
});
router.post('/parejas/:id/pendiente', (req, res) => {
  M.setStatus(middayDb, req.params.id, 'pending');
  res.redirect('/admin/mediodia?ok=Pareja marcada como pendiente.');
});
router.post('/parejas/:id/eliminar', (req, res) => {
  M.deletePair(middayDb, req.params.id);
  res.redirect('/admin/mediodia?ok=Pareja eliminada.');
});
router.post('/parejas/:id/nivel', (req, res) => {
  const ok = M.updateLevels(middayDb, req.params.id, req.body.level1, req.body.level2);
  res.redirect('/admin/mediodia?ok=' + (ok ? 'Nivel actualizado.' : 'Nivel no válido (1–7 en pasos de 0,25).'));
});

// ---- Ajustes ----
function settingsForm() {
  const rawSlots = M.parseSlots(middayGet('slots', '[]'));
  return {
    comp_name: middayGet('comp_name', 'MEDIODÍA PADEL'),
    slots_text: rawSlots.map(s => s.label).join('\n'),
    inscription_open: middayGet('inscription_open', '1') === '1',
    inscription_deadline: middayGet('inscription_deadline', ''),
    courts_midday: middayGet('courts_midday', '4'),
    min_days_between: middayGet('min_days_between', '4'),
  };
}

router.get('/ajustes', (req, res) => {
  res.renderPage('midday/admin/ajustes', { form: settingsForm(), errors: [], info: req.query.ok || null, sub: 'mediodia' });
});

router.post('/ajustes', (req, res) => {
  const b = req.body || {};
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
    return res.renderPage('midday/admin/ajustes', { form, errors, info: null, sub: 'mediodia' });

  middaySet('comp_name', form.comp_name);
  middaySet('slots', JSON.stringify(slotLabels.map((label, i) => ({ id: `s${i + 1}`, label }))));
  middaySet('inscription_open', form.inscription_open ? '1' : '0');
  middaySet('inscription_deadline', form.inscription_deadline);
  middaySet('courts_midday', String(courts));
  middaySet('min_days_between', String(mindays));
  res.redirect('/admin/mediodia/ajustes?ok=Ajustes guardados.');
});

module.exports = router;
