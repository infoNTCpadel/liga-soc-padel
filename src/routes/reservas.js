// Reserva web de pistas — acceso para socios identificados con PIN.
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
function me(req) {
  const no = req.session.bookingMemberNo;
  return no ? B.getMember(no) : null;
}
function requireMember(req, res, next) {
  if (me(req)) return next();
  res.redirect('/reservar/entrar?next=' + encodeURIComponent(req.originalUrl));
}
// Anti fuerza bruta del PIN (en memoria; la app es un solo proceso).
const pinFails = new Map(); // member_no -> { n, until }
function pinLocked(no) {
  const f = pinFails.get(no);
  return f && f.until > Date.now();
}
function pinFail(no) {
  const f = pinFails.get(no) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 15 * 60000; f.n = 0; }
  pinFails.set(no, f);
  return f.until > Date.now();
}

// ---- acceso con PIN ----
router.get('/entrar', (req, res) => {
  if (me(req)) return res.redirect('/reservar/mis');
  res.renderPage('reservas/entrar', { error: null, next: req.query.next || '/reservar/mis', member_no: '' });
});
router.post('/entrar', (req, res) => {
  const no = (req.body.member_no || '').trim();
  const next = req.body.next && req.body.next.startsWith('/') ? req.body.next : '/reservar/mis';
  const render = (error) => res.renderPage('reservas/entrar', { error, next, member_no: no });
  const m = B.getMember(no);
  if (!m || !m.active) return render('Nº de socio no encontrado o desactivado.');
  if (!B.hasPin(no)) return render('Aún no tienes PIN: usa "Activar mi acceso" primero.');
  if (pinLocked(no)) return render('Demasiados intentos: espera 15 minutos.');
  if (!B.checkPin(no, req.body.pin)) {
    const locked = pinFail(no);
    return render(locked ? 'Demasiados intentos: espera 15 minutos.' : 'PIN incorrecto.');
  }
  pinFails.delete(no);
  req.session.bookingMemberNo = no;
  res.redirect(next);
});
router.get('/activar', (req, res) => {
  if (me(req)) return res.redirect('/reservar/mis');
  res.renderPage('reservas/activar', { error: null, member_no: '', phone: '' });
});
router.post('/activar', (req, res) => {
  const no = (req.body.member_no || '').trim();
  const phone = (req.body.phone || '').trim();
  const render = (error) => res.renderPage('reservas/activar', { error, member_no: no, phone });
  const m = B.getMember(no);
  if (!m || !m.active) return render('Nº de socio no encontrado o desactivado.');
  if (B.hasPin(no)) return render('Ya tienes PIN: usa "Entrar".');
  if (!m.phone || B.normPhone(m.phone) !== B.normPhone(phone) || !B.normPhone(phone))
    return render('El teléfono no coincide con el que el club tiene en tu ficha. Pásate por recepción.');
  const pin = (req.body.pin || '').trim(), pin2 = (req.body.pin2 || '').trim();
  if (!B.validPin(pin)) return render('El PIN debe tener entre 4 y 8 dígitos.');
  if (pin !== pin2) return render('Los PIN no coinciden.');
  B.setPin(no, pin);
  req.session.bookingMemberNo = no;
  res.redirect('/reservar/mis');
});
router.get('/salir', (req, res) => {
  delete req.session.bookingMemberNo;
  res.redirect('/reservar');
});

// ---- mis datos: cambiar teléfono y PIN ----
router.get('/datos', requireMember, (req, res) => {
  res.renderPage('reservas/datos', { error: null, ok: null, member: me(req) });
});
router.post('/datos/telefono', requireMember, (req, res) => {
  const m = me(req);
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim();
  if (!B.normPhone(phone)) {
    return res.renderPage('reservas/datos', { error: 'Indica un teléfono válido.', ok: null, member: m });
  }
  B.updateMemberContact(m.member_no, phone, email);
  res.renderPage('reservas/datos', { error: null, ok: 'Datos actualizados.', member: me(req) });
});
router.post('/datos/pin', requireMember, (req, res) => {
  const m = me(req);
  const render = (error, okMsg) => res.renderPage('reservas/datos', { error: error || null, ok: okMsg || null, member: me(req) });
  if (!B.checkPin(m.member_no, req.body.pin_actual)) return render('El PIN actual no es correcto.');
  const pin = (req.body.pin || '').trim();
  if (!B.validPin(pin)) return render('El PIN debe tener entre 4 y 8 dígitos.');
  if (pin !== (req.body.pin2 || '').trim()) return render('Los PIN nuevos no coinciden.');
  B.setPin(m.member_no, pin);
  return render(null, 'PIN cambiado.');
});

// ---- parrilla de disponibilidad (pública) ----
router.get('/', (req, res) => {
  const c = B.getConfig();
  const date = clampDate(validDate(req.query.date));
  const courts = activeCourts();
  const grid = B.gridFor(date, courts);
  const today = B.todayStr();
  // Inicios potencialmente reservables por pista (para la lista de espera).
  const waitStarts = {};
  for (const court of courts) {
    const seen = new Set(), list = [];
    for (const g of B.freeSegments(court.id, date, { ignoreBookings: true })) {
      for (const v of B.validStarts(g.start, g.end)) {
        if (!seen.has(v.start_min)) { seen.add(v.start_min); list.push(v); }
      }
    }
    waitStarts[court.id] = list;
  }
  res.renderPage('reservas/grid', {
    date, grid, config: c, today, waitStarts,
    prev: date > today ? B.addDays(date, -1) : null,
    next: date < B.addDays(today, c.days_ahead) ? B.addDays(date, 1) : null,
    noCourts: courts.length === 0,
    minToStr: B.minToStr, member: me(req),
    info: req.query.ok ? 'Te has apuntado a la lista de espera. Te guardamos la plaza ' + c.hold_min + ' minutos si se libera.' : null,
    error: req.query.err || null,
  });
});

// ---- formulario de reserva ----
router.get('/nueva', requireMember, (req, res) => {
  const c = B.getConfig();
  const courts = activeCourts();
  const member = me(req);
  let offer = null;
  if (req.query.offer) {
    B.expireOffers();
    const w = B.bdb.prepare('SELECT * FROM waitlist WHERE id = ?').get(req.query.offer);
    if (w && w.status === 'offered' && w.member_no === member.member_no) offer = w;
  }
  if (offer) {
    const court = courts.find(x => x.id === offer.court_id);
    if (!court) return res.redirect('/reservar');
    return res.renderPage('reservas/nueva', {
      error: null, court, date: offer.date, offer,
      segStart: offer.start_min,
      starts: [{ start_min: offer.start_min, durations: [offer.duration_min] }],
      config: c, member, titularEmail: member.email || '', minToStr: B.minToStr,
    });
  }
  const date = clampDate(validDate(req.query.date));
  const court = courts.find(x => x.id === parseInt(req.query.court, 10));
  const desde = parseInt(req.query.desde, 10);
  if (!court || !Number.isInteger(desde)) return res.redirect('/reservar?date=' + date);
  const seg = B.freeSegments(court.id, date).find(g => desde >= g.start && desde < g.end);
  if (!seg) return res.redirect('/reservar?date=' + date);
  const starts = B.validStarts(seg.start, seg.end);
  if (!starts.length) return res.redirect('/reservar?date=' + date);
  res.renderPage('reservas/nueva', {
    error: null, court, date, offer: null, segStart: seg.start,
    starts, config: c, member, titularEmail: member.email || '', minToStr: B.minToStr,
  });
});

router.post('/nueva', requireMember, (req, res) => {
  const c = B.getConfig();
  const courts = activeCourts();
  const member = me(req);
  const offerId = req.body.offer_id ? parseInt(req.body.offer_id, 10) : null;
  let offerRow = null;
  if (offerId) {
    const chk = B.confirmOffer(offerId, member.member_no);
    if (chk.error) {
      return res.renderPage('reservas/nueva', {
        error: chk.error, court: {}, date: '', offer: null, segStart: 0, starts: [],
        config: c, member, titularEmail: member.email || '', minToStr: B.minToStr,
      });
    }
    offerRow = chk.offer;
  }
  const court = offerRow ? courts.find(x => x.id === offerRow.court_id) : courts.find(x => x.id === parseInt(req.body.court_id, 10));
  const date = offerRow ? offerRow.date : clampDate(validDate(req.body.date));
  const start_min = offerRow ? offerRow.start_min : parseInt(req.body.start_min, 10);
  const duration_min = offerRow ? offerRow.duration_min : parseInt(req.body.duration_min, 10);
  const players = [1, 2, 3].map(i => ({
    name: (req.body['p' + i + '_name'] || '').trim(),
    member_no: (req.body['p' + i + '_member'] || '').trim(),
  }));
  const render = (error) => {
    const seg = !offerRow && court ? B.freeSegments(court.id, date).find(g => start_min >= g.start && start_min < g.end) : null;
    res.renderPage('reservas/nueva', {
      error, court: court || {}, date, offer: offerRow, segStart: seg ? seg.start : start_min,
      starts: seg ? B.validStarts(seg.start, seg.end) : [],
      config: c, member, titularEmail: (req.body.titular_email || '').trim() || member.email || '',
      minToStr: B.minToStr,
    });
  };
  if (!court) return res.redirect('/reservar?date=' + date);
  const r = B.createBooking({
    court_id: court.id, court_name: court.name, date, start_min, duration_min,
    titular_member_no: member.member_no, players,
  });
  if (r.error) return render(r.error);
  const titularEmail = (req.body.titular_email || '').trim();
  if (titularEmail && titularEmail !== member.email) B.updateMemberContact(member.member_no, member.phone, titularEmail);
  res.redirect('/reservar/ok?id=' + r.id);
});

router.get('/ok', requireMember, (req, res) => {
  const member = me(req);
  const b = B.getBooking(parseInt(req.query.id, 10));
  if (!b || (b.titular_member_no !== member.member_no && !req.session.admin)) return res.redirect('/reservar');
  res.renderPage('reservas/ok', { b, config: B.getConfig(), minToStr: B.minToStr });
});

// ---- mis reservas ----
router.get('/mis', requireMember, (req, res) => {
  const member = me(req);
  res.renderPage('reservas/mis', {
    error: null, info: req.query.ok || null, area: B.memberArea(member.member_no),
    minToStr: B.minToStr, config: B.getConfig(), member,
  });
});
router.post('/anular', requireMember, (req, res) => {
  const member = me(req);
  const b = B.getBooking(parseInt(req.body.booking_id, 10));
  if (!b || b.titular_member_no !== member.member_no) return res.redirect('/reservar/mis');
  const r = B.cancelBooking(b.id, false);
  res.renderPage('reservas/mis', {
    error: r.error || null, info: r.ok ? 'Reserva anulada.' : null,
    area: B.memberArea(member.member_no), minToStr: B.minToStr, config: B.getConfig(), member,
  });
});
// Completar jugadores a posteriori (titular).
router.post('/jugadores', requireMember, (req, res) => {
  const member = me(req);
  const b = B.getBooking(parseInt(req.body.booking_id, 10));
  if (!b || b.titular_member_no !== member.member_no || b.status !== 'active')
    return res.redirect('/reservar/mis');
  const players = [1, 2, 3].map(i => ({
    name: (req.body['p' + i + '_name'] || '').trim(),
    member_no: (req.body['p' + i + '_member'] || '').trim(),
  }));
  const r = B.setPlayers(b.id, member.member_no, players);
  res.redirect('/reservar/mis' + (r.error ? '' : '?ok=' + encodeURIComponent('Jugadores actualizados.')));
});
router.post('/espera/salir', requireMember, (req, res) => {
  const member = me(req);
  B.leaveWaitlist(parseInt(req.body.wait_id, 10), member.member_no);
  res.redirect('/reservar/mis');
});

// Apuntarse a la lista de espera (hora + duración deseadas).
router.post('/espera', requireMember, (req, res) => {
  const member = me(req);
  const courts = activeCourts();
  const court = courts.find(x => x.id === parseInt(req.body.court_id, 10));
  const date = clampDate(validDate(req.body.date));
  const start_min = parseInt(req.body.start_min, 10);
  const duration_min = parseInt(req.body.duration_min, 10);
  if (!court) return res.redirect('/reservar?date=' + date);
  const r = B.joinWaitlist({ court_id: court.id, court_name: court.name, date, start_min, duration_min, member_no: member.member_no });
  if (r.error) return res.redirect('/reservar?date=' + date + '&err=' + encodeURIComponent(r.error));
  res.redirect('/reservar?date=' + date + '&ok=1');
});

module.exports = router;
