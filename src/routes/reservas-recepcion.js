// Recepción: reservas del día, cobro a invitados y cargos extra (p. ej. luz).
// Misma sesión que /recepcion.
const express = require('express');
const { getReceptionHash } = require('../db');
const B = require('../lib/bookings');

const router = express.Router();
function requireReception(req, res, next) {
  res.locals.section = 'recepcion';
  if (req.session.reception || req.session.admin) return next();
  if (req.path === '/login') return next();
  return res.redirect('/recepcion/login');
}
router.use(requireReception);

const eur = (cents) => (Number(cents || 0) / 100).toFixed(2).replace('.', ',') + ' €';

router.get('/', (req, res) => {
  if (!getReceptionHash() && !req.session.admin) return res.redirect('/recepcion/login');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : B.todayStr();
  const { bookings, blocks } = B.dayDetail(date);
  const pending = bookings.filter(b => b.status === 'active' && b.payment_status === 'pending');
  const unpaidCharges = [];
  for (const b of bookings) for (const ch of b.charges) if (!ch.paid) unpaidCharges.push({ ...ch, booking: b });
  res.renderPage('recepcion/reservas', {
    date, bookings, blocks, pending, unpaidCharges, eur, minToStr: B.minToStr,
    info: req.query.ok || null,
    prev: B.addDays(date, -1), next: B.addDays(date, 1),
  });
});
router.post('/:id/pago', (req, res) => {
  const b = B.getBooking(parseInt(req.params.id, 10));
  B.setBookingPaid(parseInt(req.params.id, 10), req.body.paid === '1');
  res.redirect('/recepcion/reservas?date=' + (b ? b.date : B.todayStr()) + '&ok=' + encodeURIComponent('Pago actualizado.'));
});
router.post('/:id/cargo', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = B.getBooking(id);
  const cents = Math.round(parseFloat(String(req.body.amount || '').replace(',', '.')) * 100) || 0;
  B.addCharge(id, req.body.label || '', cents);
  res.redirect('/recepcion/reservas?date=' + (b ? b.date : B.todayStr()) + '&ok=' + encodeURIComponent('Cargo añadido.'));
});
router.post('/cargos/:cid/pagado', (req, res) => {
  const ch = B.bdb.prepare('SELECT booking_id FROM booking_charges WHERE id = ?').get(req.params.cid);
  B.setChargePaid(parseInt(req.params.cid, 10), req.body.paid === '1');
  const b = ch ? B.getBooking(ch.booking_id) : null;
  res.redirect('/recepcion/reservas?date=' + (b ? b.date : B.todayStr()));
});
router.post('/:id/anular', (req, res) => {
  const b = B.getBooking(parseInt(req.params.id, 10));
  B.cancelBooking(parseInt(req.params.id, 10), true);
  res.redirect('/recepcion/reservas?date=' + (b ? b.date : B.todayStr()) + '&ok=' + encodeURIComponent('Reserva anulada.'));
});

module.exports = router;
