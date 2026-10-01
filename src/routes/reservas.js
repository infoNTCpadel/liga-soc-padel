// Reserva web de pistas — acceso para socios identificados con PIN.
const express = require('express');
const { db } = require('../db');
const B = require('../lib/bookings');
const Chat = require('../lib/chatAgent');

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
  const m = me(req);
  res.renderPage('reservas/datos', { error: null, ok: null, member: m, blocks: B.getBlocks(m.member_no) });
});
const renderDatos = (req, res, error, okMsg) =>
  res.renderPage('reservas/datos', { error: error || null, ok: okMsg || null, member: me(req), blocks: B.getBlocks(me(req).member_no) });
router.post('/datos/telefono', requireMember, (req, res) => {
  const m = me(req);
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim();
  if (!B.normPhone(phone)) return renderDatos(req, res, 'Indica un teléfono válido.');
  B.updateMemberContact(m.member_no, phone, email);
  renderDatos(req, res, null, 'Datos actualizados.');
});
router.post('/datos/pin', requireMember, (req, res) => {
  const m = me(req);
  if (!B.checkPin(m.member_no, req.body.pin_actual)) return renderDatos(req, res, 'El PIN actual no es correcto.');
  const pin = (req.body.pin || '').trim();
  if (!B.validPin(pin)) return renderDatos(req, res, 'El PIN debe tener entre 4 y 8 dígitos.');
  if (pin !== (req.body.pin2 || '').trim()) return renderDatos(req, res, 'Los PIN nuevos no coinciden.');
  B.setPin(m.member_no, pin);
  return renderDatos(req, res, null, 'PIN cambiado.');
});
router.post('/datos/nivel', requireMember, (req, res) => {
  const r = B.setLevel(me(req).member_no, req.body.level);
  if (r.error) return renderDatos(req, res, r.error);
  renderDatos(req, res, null, 'Nivel actualizado.');
});
router.post('/datos/bloqueos', requireMember, (req, res) => {
  const m = me(req);
  const r = B.addBlock(m.member_no, (req.body.member_no || '').trim());
  if (r.error) return renderDatos(req, res, r.error);
  renderDatos(req, res, null, 'Jugador bloqueado: no verá tus partidos abiertos.');
});
router.post('/datos/bloqueos/eliminar', requireMember, (req, res) => {
  B.removeBlock(me(req).member_no, (req.body.member_no || '').trim());
  renderDatos(req, res, null, 'Bloqueo eliminado.');
});

// ---- parrilla de disponibilidad (pública) ----
router.get('/', (req, res) => {
  const c = B.getConfig();
  const date = clampDate(validDate(req.query.date));
  const member = me(req);
  const viewer = member ? { member_no: member.member_no, level: member.level } : null;
  const courts = activeCourts();
  const rows = B.slotDay(date, viewer, courts);
  const today = B.todayStr();
  const maxDate = B.addDays(today, c.days_ahead);
  const tabs = [];
  for (let d = today, i = 0; d <= maxDate && i < 14; d = B.addDays(d, 1), i++) tabs.push(d);
  const wd = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const tabLabel = (d) => {
    if (d === today) return 'Hoy';
    if (d === B.addDays(today, 1)) return 'Mañana';
    const dt = new Date(d + 'T12:00:00');
    return wd[dt.getDay()] + ' ' + dt.getDate();
  };
  // Inicios potencialmente reservables por pista (lista de espera).
  const waitStarts = {};
  for (const court of courts) {
    const seen = new Set(), list = [];
    for (const g of B.freeSegments(court.id, date, { ignoreBookings: true })) {
      for (const v of B.validStarts(g.start, g.end)) {
        if (!seen.has(v.start_min)) { seen.add(v.start_min); list.push(v.start_min); }
      }
    }
    waitStarts[court.id] = list;
  }
  res.renderPage('reservas/grid', {
    date, rows, courts, config: c, today, tabs, tabLabel, waitStarts,
    prev: date > today ? B.addDays(date, -1) : null,
    next: date < maxDate ? B.addDays(date, 1) : null,
    noCourts: courts.length === 0,
    minToStr: B.minToStr, member,
    chatEnabled: Chat.chatConfig().enabled,
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
      chosenStart: offer.start_min, chosenDur: offer.duration_min,
      config: c, member, titularEmail: member.email || '', minToStr: B.minToStr,
    });
  }
  const date = clampDate(validDate(req.query.date));
  const court = courts.find(x => x.id === parseInt(req.query.court, 10));
  const desde = parseInt(req.query.desde, 10);
  const durQ = parseInt(req.query.duracion, 10);
  if (!court || !Number.isInteger(desde)) return res.redirect('/reservar?date=' + date);
  const seg = B.freeSegments(court.id, date).find(g => desde >= g.start && desde < g.end);
  if (!seg) return res.redirect('/reservar?date=' + date);
  const starts = B.validStarts(seg.start, seg.end);
  if (!starts.length) return res.redirect('/reservar?date=' + date);
  // Prefiere la franja pulsada si es válida; si no, la primera válida posterior.
  const chosen = starts.find(v => v.start_min === desde) || starts.find(v => v.start_min > desde);
  if (!chosen) return res.redirect('/reservar?date=' + date);
  // Duración automática sin preguntar: la pedida si encaja, si no la mayor que quepa.
  const dursDesc = [...c.durations].sort((a, b) => b - a);
  const chosenDur = (dursDesc.includes(durQ) && chosen.durations.includes(durQ))
    ? durQ : dursDesc.find(d => chosen.durations.includes(d));
  res.renderPage('reservas/nueva', {
    error: null, court, date, offer: null, segStart: seg.start,
    starts, chosenStart: chosen.start_min, chosenDur,
    config: c, member, titularEmail: member.email || '', minToStr: B.minToStr,
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
    const rstarts = seg ? B.validStarts(seg.start, seg.end) : [];
    const pick = offerRow ? null : (rstarts.find(v => v.start_min === start_min) || rstarts[0]);
    res.renderPage('reservas/nueva', {
      error, court: court || {}, date, offer: offerRow, segStart: seg ? seg.start : start_min,
      starts: rstarts,
      chosenStart: offerRow ? offerRow.start_min : (pick ? pick.start_min : start_min),
      chosenDur: offerRow ? offerRow.duration_min : duration_min,
      config: c, member, titularEmail: (req.body.titular_email || '').trim() || member.email || '',
      minToStr: B.minToStr,
    });
  };
  if (!court) return res.redirect('/reservar?date=' + date);
  const filled = players.filter(p => p.name).length;
  // Si faltan jugadores y no viene de lista de espera: validar y preguntar si abrir el partido.
  if (!offerRow && filled < 3) {
    const verr = B.validateNewBooking({ court_id: court.id, date, start_min, duration_min, titular_member_no: member.member_no, players });
    if (verr) return render(verr);
    req.session.pendingOpen = {
      mode: 'new', court_id: court.id, court_name: court.name, date, start_min, duration_min,
      players, titular_email: (req.body.titular_email || '').trim(),
      missing: 3 - filled,
    };
    return res.renderPage('reservas/abrir', {
      error: null, mode: 'new', missing: 3 - filled,
      level: member.level, levelRange: B.levelRangeText(member.level),
      minToStr: B.minToStr, member,
      when: B.minToStr(start_min) + '–' + B.minToStr(start_min + duration_min) + ' · ' + court.name,
    });
  }
  const r = B.createBooking({
    court_id: court.id, court_name: court.name, date, start_min, duration_min,
    titular_member_no: member.member_no, players,
  });
  if (r.error) return render(r.error);
  const titularEmail = (req.body.titular_email || '').trim();
  if (titularEmail && titularEmail !== member.email) B.updateMemberContact(member.member_no, member.phone, titularEmail);
  res.redirect('/reservar/ok?id=' + r.id);
});

// Confirmación de partido abierto (al crear o al quitar un jugador).
router.post('/abrir/confirmar', requireMember, (req, res) => {
  const member = me(req);
  const pend = req.session.pendingOpen;
  if (!pend) return res.redirect('/reservar');
  delete req.session.pendingOpen;
  const wantOpen = req.body.abrir === '1';
  if (pend.mode === 'new') {
    const r = B.createBooking({
      court_id: pend.court_id, court_name: pend.court_name, date: pend.date,
      start_min: pend.start_min, duration_min: pend.duration_min,
      titular_member_no: member.member_no, players: pend.players,
      open_spots: wantOpen ? pend.missing : 0,
    });
    if (r.error) return res.renderPage('reservas/abrir', {
      error: r.error, mode: 'new', missing: pend.missing,
      level: member.level, levelRange: B.levelRangeText(member.level),
      minToStr: B.minToStr, member, when: '',
    });
    if (pend.titular_email && pend.titular_email !== member.email)
      B.updateMemberContact(member.member_no, member.phone, pend.titular_email);
    return res.redirect('/reservar/ok?id=' + r.id);
  }
  // mode 'existing': quitar jugador de un partido cerrado
  const b = B.getBooking(pend.booking_id);
  if (!b || b.titular_member_no !== member.member_no) return res.redirect('/reservar/mis');
  B.setPlayers(b.id, member.member_no, pend.players);
  if (wantOpen) {
    const total = B.getBooking(b.id).players.length;
    B.bdb.prepare('UPDATE bookings SET open_spots = ? WHERE id = ?').run(Math.max(0, 4 - total), b.id);
  }
  res.redirect('/reservar/mis?ok=' + encodeURIComponent('Jugadores actualizados.'));
});

// ---- partido abierto: detalle y unirse ----
router.get('/abierto/:id', (req, res) => {
  const member = me(req);
  const viewer = member ? { member_no: member.member_no, level: member.level } : null;
  const b = B.getBooking(parseInt(req.params.id, 10));
  if (!b || b.status !== 'active' || !(b.open_spots > 0)) return res.redirect('/reservar');
  const booker = B.getMember(b.titular_member_no);
  const mine = member && b.titular_member_no === member.member_no;
  if (!mine && !B.openVisibleTo(b.titular_member_no, booker && booker.level, viewer))
    return res.redirect('/reservar');
  const already = member && b.players.some(p => p.member_no === member.member_no);
  res.renderPage('reservas/abierto', {
    b, booker, mine, already, member,
    range: B.levelRangeText(booker && booker.level),
    minToStr: B.minToStr, error: req.query.err || null,
  });
});
router.post('/abierto/:id/unirse', requireMember, (req, res) => {
  const member = me(req);
  const r = B.joinOpenMatch(parseInt(req.params.id, 10), member);
  if (r.error) return res.redirect('/reservar/abierto/' + req.params.id + '?err=' + encodeURIComponent(r.error));
  res.redirect('/reservar/mis?ok=' + encodeURIComponent('Te has apuntado al partido.'));
});
router.post('/abierto/:id/cerrar', requireMember, (req, res) => {
  const member = me(req);
  const b = B.getBooking(parseInt(req.params.id, 10));
  if (!b || (b.titular_member_no !== member.member_no && !req.session.admin)) return res.redirect('/reservar/mis');
  B.closeOpenMatch(b.id);
  res.redirect('/reservar/mis?ok=' + encodeURIComponent('Partido cerrado.'));
});

// Buscador de socios (nombre, nº de socio o móvil) para el formulario.
router.get('/socios/buscar', requireMember, (req, res) => {
  res.json(B.searchMembers(req.query.q || ''));
});

// ---- chat conversacional de reservas ----
router.post('/chat', async (req, res) => {
  const message = (req.body.message || '').toString().slice(0, 500);
  if (!message.trim()) return res.json({ reply: 'Escríbeme tu pregunta y te ayudo con la reserva.' });
  try {
    const r = await Chat.runChat({ message, session: req.session });
    res.json({ reply: r.reply, identified: r.identified === true });
  } catch (e) {
    console.error('chat', e.message);
    res.json({ reply: 'Se me ha atragantado la respuesta. Prueba de nuevo o usa la parrilla.' });
  }
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
// Completar o quitar jugadores a posteriori (titular).
router.post('/jugadores', requireMember, (req, res) => {
  const member = me(req);
  const b = B.getBooking(parseInt(req.body.booking_id, 10));
  if (!b || b.titular_member_no !== member.member_no || b.status !== 'active')
    return res.redirect('/reservar/mis');
  const players = [1, 2, 3].map(i => ({
    name: (req.body['p' + i + '_name'] || '').trim(),
    member_no: (req.body['p' + i + '_member'] || '').trim(),
  }));
  const prevFilled = b.players.length - 1;
  const newFilled = players.filter(p => p.name).length;
  const r = B.setPlayers(b.id, member.member_no, players);
  if (r.error) return res.redirect('/reservar/mis');
  B.syncOpenSpots(b.id);
  // Partido cerrado al que le quitan un jugador: preguntar si abrirlo.
  const upd = B.getBooking(b.id);
  if (!(upd.open_spots > 0) && newFilled < prevFilled && newFilled < 3) {
    req.session.pendingOpen = { mode: 'existing', booking_id: b.id, players, missing: 3 - newFilled };
    return res.renderPage('reservas/abrir', {
      error: null, mode: 'existing', missing: 3 - newFilled,
      level: member.level, levelRange: B.levelRangeText(member.level),
      minToStr: B.minToStr, member,
      when: B.minToStr(b.start_min) + '–' + B.minToStr(b.end_min) + ' · ' + b.court_name,
    });
  }
  res.redirect('/reservar/mis?ok=' + encodeURIComponent('Jugadores actualizados.'));
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
