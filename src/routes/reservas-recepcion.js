// Recepción: reservas del día, cobro a invitados y cargos extra (p. ej. luz).
// Misma sesión que /recepcion.
const express = require('express');
const { db, getReceptionHash } = require('../db');
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
function activeCourts() {
  try {
    return db.prepare('SELECT id, name FROM courts WHERE active = 1 ORDER BY name').all();
  } catch (e) { return []; }
}

router.get('/', (req, res) => {
  if (!getReceptionHash() && !req.session.admin) return res.redirect('/recepcion/login');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : B.todayStr();
  const { bookings, blocks } = B.dayDetail(date);
  const pending = bookings.filter(b => b.status === 'active' && (b.payment_status === 'pending' || b.charges.some(c => !c.paid)));
  const unpaidCharges = [];
  for (const b of bookings) for (const ch of b.charges) if (!ch.paid) unpaidCharges.push({ ...ch, booking: b });
  res.renderPage('recepcion/reservas', {
    date, bookings, blocks, pending, unpaidCharges, eur, minToStr: B.minToStr,
    info: req.query.ok || null, error: req.query.error || null,
    prev: B.addDays(date, -1), next: B.addDays(date, 1),
  });
});
router.post('/:id/pago', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = B.getBooking(id);
  const st = B.setBookingPaid(id, req.body.paid === '1');
  if (req.body.json === '1' || req.headers.accept === 'application/json')
    return res.json({ ok: true, payment_status: st });
  res.redirect('/recepcion/reservas?date=' + (b ? b.date : B.todayStr()) + '&ok=' + encodeURIComponent('Pago actualizado.'));
});
router.post('/:id/anadir-jugador', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = B.addPlayer(id, req.body.name, req.body.member_no);
  if (r.error) return res.json({ ok: false, error: r.error });
  res.json({ ok: true, booking: B.getBooking(id) });
});
router.post('/:id/cargo', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = B.getBooking(id);
  const cents = Math.round(parseFloat(String(req.body.amount || '').replace(',', '.')) * 100) || 0;
  const r = B.addCharge(id, req.body.label || '', cents, req.body.player_id || null);
  const date = b ? b.date : B.todayStr();
  res.redirect('/recepcion/reservas?date=' + date + (r.error
    ? '&error=' + encodeURIComponent(r.error)
    : '&ok=' + encodeURIComponent('Cargo añadido.')));
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
// Completar jugadores de una reserva (el titular cuenta como 1).
router.post('/:id/jugadores', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = B.getBooking(id);
  if (b && b.status === 'active') {
    const players = [1, 2, 3].map(i => ({
      name: (req.body['p' + i + '_name'] || '').trim(),
      member_no: (req.body['p' + i + '_member'] || '').trim(),
    }));
    B.setPlayers(id, b.titular_member_no, players);
    B.syncOpenSpots(id); // si se completaron los 4, el partido se cierra solo
  }
  res.redirect('/recepcion/reservas?date=' + (b ? b.date : B.todayStr()) + '&ok=' + encodeURIComponent('Jugadores actualizados.'));
});

// ---- nueva reserva (personal) ----
router.get('/socios/buscar', (req, res) => {
  res.json(B.searchMembers(req.query.q || ''));
});
// Parrilla visual para el personal: la misma tabla de franjas que ven los socios,
// con los colores de la app. Las franjas libres abren el formulario de nueva
// reserva con pista, fecha y tramo listos; las ocupadas muestran la máxima
// información y al pulsarlas se abre el detalle en grande debajo.
router.get('/parrilla', (req, res) => {
  const c = B.getConfig();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : B.todayStr();
  const courts = activeCourts();
  const rows = B.slotDay(date, null, courts);
  res.renderPage('reservas/grid', {
    date, rows, courts, config: c, waitStarts: {},
    noCourts: courts.length === 0,
    closed: !B.dayHours(date),
    member: null,
    joinedIds: new Set(),
    staffMode: true,
    info: req.query.ok || null, error: req.query.error || null,
    ...B.staffGrid(date, {
      staffBase: '/recepcion/reservas', staffDay: '/recepcion/reservas', anularPrefix: '/recepcion/reservas/',
    }, courts),
  });
});
router.get('/nueva', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : B.todayStr();
  const courts = activeCourts();
  const court = courts.find(x => x.id === parseInt(req.query.court, 10)) || null;
  const desde = parseInt(req.query.desde, 10);
  const durQ = parseInt(req.query.duracion, 10);
  const d = {
    action: '/recepcion/reservas/nueva', backUrl: '/recepcion/reservas?date=' + date,
    error: null, date, courts, court, config: B.getConfig(), minToStr: B.minToStr,
    desde: Number.isInteger(desde) ? desde : null,
    duracion: B.getConfig().durations.includes(durQ) ? durQ : null,
    segs: court && !Number.isInteger(desde) ? B.freeSegments(court.id, date) : null,
    seg: null, starts: null,
  };
  if (court && Number.isInteger(desde)) {
    const seg = B.freeSegments(court.id, date).find(g => desde >= g.start && desde < g.end);
    if (!seg) return res.redirect('/recepcion/reservas/nueva?date=' + date + '&court=' + court.id);
    d.seg = seg; d.starts = B.bookableStarts(seg.start, seg.end, date);
  }
  res.renderPage('reservas/staff-nueva', d);
});
router.post('/rapida', (req, res) => {
  const courts = activeCourts();
  const court = courts.find(x => x.id === parseInt(req.body.court_id, 10));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : B.todayStr();
  const back = '/recepcion/reservas/parrilla?date=' + date;
  const fail = (msg) => res.redirect(back + '&error=' + encodeURIComponent(msg));
  const tno = (req.body.titular_member_no || '').trim();
  if (!court || !tno) return fail('Falta la pista o el titular.');
  const wantOpen = req.body.abrir === '1';
  const r = B.quickBook({
    court_id: court.id, court_name: court.name, date,
    start_min: parseInt(req.body.start_min, 10),
    duration_min: parseInt(req.body.duration_min, 10),
    titular_member_no: tno, players: [], open: wantOpen, byStaff: true,
  });
  if (r.error) return fail(r.error);
  res.redirect(back + '&ok=' + encodeURIComponent('Reserva creada para ' + tno + '.'));
});
router.post('/nueva', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : B.todayStr();
  const courts = activeCourts();
  const court = courts.find(x => x.id === parseInt(req.body.court_id, 10));
  const desde = parseInt(req.body.desde, 10);
  const render = (error) => {
    const seg = court && Number.isInteger(desde) ? B.freeSegments(court.id, date).find(g => desde >= g.start && desde < g.end) : null;
    const durB = parseInt(req.body.duration_min, 10);
    res.renderPage('reservas/staff-nueva', {
      action: '/recepcion/reservas/nueva', backUrl: '/recepcion/reservas?date=' + date,
      error, date, courts, court: court || null, config: B.getConfig(), minToStr: B.minToStr,
      desde: Number.isInteger(desde) ? desde : null,
      duracion: B.getConfig().durations.includes(durB) ? durB : null,
      segs: null, seg, starts: seg ? B.bookableStarts(seg.start, seg.end, date) : null,
    });
  };
  const t = (req.body.titular_member_no || '').trim();
  if (!court) return render('Elige una pista.');
  if (!B.getMember(t)) return render('Nº de socio del titular no válido.');
  const players = [1, 2, 3].map(i => ({
    name: (req.body['p' + i + '_name'] || '').trim(),
    member_no: (req.body['p' + i + '_member'] || '').trim(),
  }));
  for (const p of players) {
    if (p.member_no && !B.getMember(p.member_no))
      return render(`El nº de socio ${p.member_no} no existe. Corrige el jugador o quita el número para dejarlo como invitado.`);
  }
  const r = B.createBooking({
    court_id: court.id, court_name: court.name, date,
    start_min: parseInt(req.body.start_min, 10), duration_min: parseInt(req.body.duration_min, 10),
    titular_member_no: t, players, open_spots: parseInt(req.body.open_spots, 10) || 0, byStaff: true,
  });
  if (r.error) return render(r.error);
  res.redirect('/recepcion/reservas?date=' + date + '&ok=' + encodeURIComponent('Reserva creada.'));
});

module.exports = router;
