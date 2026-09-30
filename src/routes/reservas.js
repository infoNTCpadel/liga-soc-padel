// Reserva web de pistas (fase 1) — acceso público para socios del club.
const express = require('express');
const { db } = require('../db');
const B = require('../lib/bookings');

const router = express.Router();
router.use((req, res, next) => { res.locals.section = 'public'; res.locals.sub = 'reservar'; next(); });

function activeCourts() {
  try {
    return db.prepare('SELECT id, name FROM courts WHERE active = 1 ORDER BY name').all();
  } catch (e) { return []; }
}
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null;
}
function clampDate(s) {
  const c = B.getConfig();
  const today = B.todayStr(), max = B.addDays(today, c.days_ahead);
  if (!s || s < today) return today;
  if (s > max) return max;
  return s;
}

// Parrilla de disponibilidad.
router.get('/', (req, res) => {
  const c = B.getConfig();
  const date = clampDate(validDate(req.query.date));
  const courts = activeCourts();
  const grid = B.gridFor(date, courts);
  const today = B.todayStr();
  res.renderPage('reservas/grid', {
    date, grid, config: c, today,
    prev: date > today ? B.addDays(date, -1) : null,
    next: date < B.addDays(today, c.days_ahead) ? B.addDays(date, 1) : null,
    noCourts: courts.length === 0,
    minToStr: B.minToStr,
  });
});

// Formulario de reserva.
router.get('/nueva', (req, res) => {
  const c = B.getConfig();
  const courts = activeCourts();
  const date = clampDate(validDate(req.query.date));
  const start_min = parseInt(req.query.slot, 10);
  const court = courts.find(x => x.id === parseInt(req.query.court, 10));
  let offer = null;
  if (req.query.offer) {
    B.expireOffers();
    const w = B.bdb.prepare('SELECT * FROM waitlist WHERE id = ?').get(req.query.offer);
    if (w && w.status === 'offered') offer = w;
  }
  if (!offer && (!court || !Number.isInteger(start_min))) return res.redirect('/reservar');
  const oc = offer ? courts.find(x => x.id === offer.court_id) : court;
  if (!oc) return res.redirect('/reservar');
  const odate = offer ? offer.date : date;
  const ostart = offer ? offer.start_min : start_min;
  // ¿Cuántas franjas seguidas libres hay desde aquí?
  const bookings = B.dayBookings(odate), blocks = B.dayBlocks(odate);
  let maxN = 0;
  for (let n = 1; n <= 8; n++) {
    const e = ostart + n * c.slot_min;
    if (e > c.close_min) break;
    const clash = bookings.some(b => b.court_id === oc.id && b.status === 'active' && B.overlaps(ostart, e, b.start_min, b.end_min));
    const blk = blocks.some(b => b.court_id === oc.id && B.overlaps(ostart, e, b.start_min, b.end_min));
    if (clash || blk) break;
    maxN = n;
  }
  if (maxN === 0) return res.redirect('/reservar?date=' + odate);
  res.renderPage('reservas/nueva', {
    error: null, court: oc, date: odate, start_min: ostart, maxN, config: c,
    offer, titular: offer ? offer.member_no : '',
    minToStr: B.minToStr,
  });
});

router.post('/nueva', (req, res) => {
  const c = B.getConfig();
  const courts = activeCourts();
  const court = courts.find(x => x.id === parseInt(req.body.court_id, 10));
  const date = clampDate(validDate(req.body.date));
  const start_min = parseInt(req.body.start_min, 10);
  const nslots = parseInt(req.body.nslots, 10) || 1;
  const titular = (req.body.titular || '').trim();
  const players = [1, 2, 3, 4].map(i => ({
    name: (req.body['p' + i + '_name'] || '').trim(),
    member_no: (req.body['p' + i + '_member'] || '').trim(),
  }));
  const offerId = req.body.offer_id ? parseInt(req.body.offer_id, 10) : null;
  let offerRow = null;
  if (offerId) {
    // La oferta fija pista/día/hora: no se aceptan los del formulario.
    offerRow = B.bdb.prepare('SELECT * FROM waitlist WHERE id = ?').get(offerId);
  }
  const effCourt = offerRow ? courts.find(x => x.id === offerRow.court_id) : court;
  const effDate = offerRow ? offerRow.date : date;
  const effStart = offerRow ? offerRow.start_min : start_min;
  const render = (error) => res.renderPage('reservas/nueva', {
    error, court: effCourt || {}, date: effDate, start_min: effStart, maxN: 8, config: c,
    offer: offerRow, titular, minToStr: B.minToStr,
  });
  if (!effCourt) return res.redirect('/reservar?date=' + effDate);
  if (offerId) {
    const chk = B.confirmOffer(offerId, titular);
    if (chk.error) return render(chk.error);
  }
  const r = B.createBooking({ court_id: effCourt.id, court_name: effCourt.name, date: effDate, start_min: effStart, nslots, titular_member_no: titular, players });
  if (r.error) return render(r.error);
  const titularEmail = (req.body.titular_email || '').trim();
  if (titularEmail) {
    const tm = B.getMember(titular);
    if (tm) B.upsertMember(titular, tm.name, tm.phone, titularEmail);
  }
  res.redirect('/reservar/ok?id=' + r.id);
});

router.get('/ok', (req, res) => {
  const b = B.getBooking(parseInt(req.query.id, 10));
  if (!b) return res.redirect('/reservar');
  res.renderPage('reservas/ok', { b, config: B.getConfig(), minToStr: B.minToStr });
});

// Mis reservas: acceso con nº de socio.
router.get('/mis', (req, res) => {
  res.renderPage('reservas/mis', { error: null, area: null, member_no: '', minToStr: B.minToStr, config: B.getConfig() });
});
router.post('/mis', (req, res) => {
  const member_no = (req.body.member_no || '').trim();
  const area = B.memberArea(member_no);
  if (!area) return res.renderPage('reservas/mis', { error: 'Nº de socio no encontrado.', area: null, member_no, minToStr: B.minToStr, config: B.getConfig() });
  res.renderPage('reservas/mis', { error: null, area, member_no, minToStr: B.minToStr, config: B.getConfig() });
});
function areaOrRedirect(req, res) {
  const member_no = (req.body.member_no || '').trim();
  const area = B.memberArea(member_no);
  if (!area) return null;
  return { member_no, area };
}
router.post('/anular', (req, res) => {
  const ctx = areaOrRedirect(req, res);
  if (!ctx) return res.redirect('/reservar/mis');
  const b = B.getBooking(parseInt(req.body.booking_id, 10));
  if (!b || b.titular_member_no !== ctx.member_no) return res.redirect('/reservar/mis');
  const r = B.cancelBooking(b.id, false);
  res.renderPage('reservas/mis', {
    error: r.error || null, area: B.memberArea(ctx.member_no), member_no: ctx.member_no,
    minToStr: B.minToStr, config: B.getConfig(),
    info: r.ok ? 'Reserva anulada.' : null,
  });
});
router.post('/espera/salir', (req, res) => {
  const member_no = (req.body.member_no || '').trim();
  B.leaveWaitlist(parseInt(req.body.wait_id, 10), member_no);
  const area = B.memberArea(member_no);
  res.renderPage('reservas/mis', { error: null, area, member_no, minToStr: B.minToStr, config: B.getConfig() });
});

// Apuntarse a la lista de espera de una franja ocupada.
router.post('/espera', (req, res) => {
  const courts = activeCourts();
  const court = courts.find(x => x.id === parseInt(req.body.court_id, 10));
  const date = clampDate(validDate(req.body.date));
  const start_min = parseInt(req.body.start_min, 10);
  const member_no = (req.body.member_no || '').trim();
  if (!court) return res.redirect('/reservar?date=' + date);
  const r = B.joinWaitlist({ court_id: court.id, court_name: court.name, date, start_min, member_no });
  const grid = B.gridFor(date, courts);
  const c = B.getConfig();
  res.renderPage('reservas/grid', {
    date, grid, config: c, today: B.todayStr(),
    prev: date > B.todayStr() ? B.addDays(date, -1) : null,
    next: date < B.addDays(B.todayStr(), c.days_ahead) ? B.addDays(date, 1) : null,
    noCourts: false, minToStr: B.minToStr,
    info: r.ok ? 'Te has apuntado a la lista de espera. Te guardamos la plaza ' + c.hold_min + ' minutos si se libera.' : null,
    error: r.error || null,
  });
});

module.exports = router;
