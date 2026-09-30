// Gestión de reservas: configuración, socios, bloqueos y reservas del día.
// Solo organización (misma sesión que /admin).
const express = require('express');
const { db, getAdminHash } = require('../db');
const B = require('../lib/bookings');

const router = express.Router();
function requireAdmin(req, res, next) {
  res.locals.section = 'admin';
  if (!getAdminHash()) return res.redirect('/admin/setup');
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}
router.use(requireAdmin);

function activeCourts() {
  try {
    return db.prepare('SELECT id, name FROM courts WHERE active = 1 ORDER BY name').all();
  } catch (e) { return []; }
}
const eur = (cents) => (Number(cents || 0) / 100).toFixed(2).replace('.', ',') + ' €';

router.get('/', (req, res) => res.redirect('/admin/reservas/dia'));

// ---- reservas del día ----
router.get('/dia', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : B.todayStr();
  const { bookings, blocks } = B.dayDetail(date);
  res.renderPage('reservas-admin/dia', {
    date, bookings, blocks, eur, minToStr: B.minToStr, info: req.query.ok || null,
    prev: B.addDays(date, -1), next: B.addDays(date, 1),
  });
});
router.post('/reservas/:id/anular', (req, res) => {
  const b = B.getBooking(parseInt(req.params.id, 10));
  const date = b ? b.date : B.todayStr();
  B.cancelBooking(parseInt(req.params.id, 10), true);
  res.redirect('/admin/reservas/dia?date=' + date + '&ok=' + encodeURIComponent('Reserva anulada.'));
});
router.post('/reservas/:id/pago', (req, res) => {
  const b = B.getBooking(parseInt(req.params.id, 10));
  const date = b ? b.date : B.todayStr();
  B.setBookingPaid(parseInt(req.params.id, 10), req.body.paid === '1');
  res.redirect('/admin/reservas/dia?date=' + date + '&ok=' + encodeURIComponent('Pago actualizado.'));
});
router.post('/reservas/:id/cargo', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = B.getBooking(id);
  const date = b ? b.date : B.todayStr();
  const cents = Math.round(parseFloat(String(req.body.amount || '').replace(',', '.')) * 100) || 0;
  const r = B.addCharge(id, req.body.label || '', cents);
  res.redirect('/admin/reservas/dia?date=' + date + '&ok=' + encodeURIComponent(r.ok ? 'Cargo añadido.' : (r.error || 'Error.')));
});
router.post('/cargos/:id/pagado', (req, res) => {
  const ch = B.bdb.prepare('SELECT booking_id FROM booking_charges WHERE id = ?').get(req.params.id);
  B.setChargePaid(parseInt(req.params.id, 10), req.body.paid === '1');
  const b = ch ? B.getBooking(ch.booking_id) : null;
  res.redirect('/admin/reservas/dia?date=' + (b ? b.date : B.todayStr()));
});
router.post('/cargos/:id/eliminar', (req, res) => {
  const ch = B.bdb.prepare('SELECT booking_id FROM booking_charges WHERE id = ?').get(req.params.id);
  B.deleteCharge(parseInt(req.params.id, 10));
  const b = ch ? B.getBooking(ch.booking_id) : null;
  res.redirect('/admin/reservas/dia?date=' + (b ? b.date : B.todayStr()));
});

// ---- configuración ----
router.get('/config', (req, res) => {
  res.renderPage('reservas-admin/config', { error: null, ok: null, config: B.getConfig(), minToStr: B.minToStr });
});
router.post('/config', (req, res) => {
  const open_min = B.strToMin(req.body.open) ?? 480;
  const close_min = B.strToMin(req.body.close) ?? 1380;
  const slot_min = parseInt(req.body.slot_min, 10);
  const days_ahead = Math.min(90, Math.max(1, parseInt(req.body.days_ahead, 10) || 14));
  const hold_min = Math.min(120, Math.max(5, parseInt(req.body.hold_min, 10) || 10));
  const cancel_limit_h = Math.min(72, Math.max(0, parseInt(req.body.cancel_limit_h, 10) || 0));
  const err = B.validateGrid(open_min, close_min, slot_min);
  if (err) return res.renderPage('reservas-admin/config', { error: err, ok: null, config: B.getConfig(), minToStr: B.minToStr });
  B.setCfg('open_min', open_min); B.setCfg('close_min', close_min); B.setCfg('slot_min', slot_min);
  B.setCfg('days_ahead', days_ahead); B.setCfg('hold_min', hold_min); B.setCfg('cancel_limit_h', cancel_limit_h);
  B.setCfg('guest_price', (req.body.guest_price || '').trim());
  B.setCfg('reminders_enabled', req.body.reminders_enabled === '1' ? '1' : '0');
  B.setCfg('reminder_hours', Math.min(24, Math.max(1, parseInt(req.body.reminder_hours, 10) || 3)));
  res.renderPage('reservas-admin/config', { error: null, ok: 'Configuración guardada.', config: B.getConfig(), minToStr: B.minToStr });
});

// ---- socios ----
router.get('/socios', (req, res) => {
  res.renderPage('reservas-admin/socios', { members: B.listMembers(), ok: req.query.ok || null, error: null });
});
router.post('/socios', (req, res) => {
  const ok = B.upsertMember(req.body.member_no, req.body.name, req.body.phone, req.body.email);
  res.redirect('/admin/reservas/socios' + (ok ? '?ok=' + encodeURIComponent('Socio guardado.') : ''));
});
router.post('/socios/toggle', (req, res) => {
  B.setMemberActive(req.body.member_no, req.body.active === '1');
  res.redirect('/admin/reservas/socios');
});
router.post('/socios/importar', (req, res) => {
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT member_no, MAX(name) AS name, MAX(phone) AS phone, MAX(email) AS email FROM players
       WHERE member_no IS NOT NULL AND TRIM(member_no) != '' AND COALESCE(member_verified, 0) = 1
       GROUP BY TRIM(member_no)`).all();
  } catch (e) { rows = []; }
  const n = B.importMembers(rows);
  res.redirect('/admin/reservas/socios?ok=' + encodeURIComponent(n ? `${n} socio(s) importados de la liga.` : 'No había socios verificados nuevos que importar.'));
});

// ---- bloqueos ----
router.get('/bloqueos', (req, res) => {
  res.renderPage('reservas-admin/bloqueos', {
    blocks: B.listBlocks(), courts: activeCourts(), config: B.getConfig(),
    error: null, minToStr: B.minToStr, today: B.todayStr(),
  });
});
router.post('/bloqueos', (req, res) => {
  const courts = activeCourts();
  const court = courts.find(x => x.id === parseInt(req.body.court_id, 10));
  const date = req.body.date;
  const start_min = B.strToMin(req.body.start);
  const end_min = B.strToMin(req.body.end);
  const reason = req.body.reason || '';
  const render = (error) => res.renderPage('reservas-admin/bloqueos', {
    blocks: B.listBlocks(), courts, config: B.getConfig(), error, minToStr: B.minToStr, today: B.todayStr(),
  });
  if (!court || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return render('Pista o fecha no válidos.');
  const r = B.createBlock({
    court_id: court.id, court_name: court.name, date, start_min, end_min,
    reason, notes: (req.body.notes || '').trim(), force: req.body.force === '1',
  });
  if (r.error) return render(r.error);
  if (r.conflict) {
    return res.renderPage('reservas-admin/bloqueo-conflicto', {
      court, date, start_min, end_min, reason, notes: (req.body.notes || '').trim(),
      affected: r.conflict, minToStr: B.minToStr,
    });
  }
  res.redirect('/admin/reservas/bloqueos');
});
router.post('/bloqueos/:id/eliminar', (req, res) => {
  B.deleteBlock(parseInt(req.params.id, 10));
  res.redirect('/admin/reservas/bloqueos');
});

module.exports = router;
