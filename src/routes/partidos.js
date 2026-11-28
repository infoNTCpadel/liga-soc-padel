// Módulo de partidos abiertos (fase 1: publicar, ver lista y apuntarse a mano).
// EN PRUEBAS: mientras partidos_public sea '0', solo lo ve el admin.
// Cuando Mathius lo active en Admin → Reservas → Configuración, lo verán los socios.
const express = require('express');
const { db } = require('../db');
const B = require('../lib/bookings');

const router = express.Router();
router.use((req, res, next) => {
  res.locals.section = 'public'; res.locals.sub = 'partidos';
  res.locals.partidosPublic = B.getConfig().partidos_public === '1' || !!req.session.admin;
  next();
});

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
// Puerta del módulo: público solo si está activado; en pruebas, solo admin.
function gatePartidos(req, res, next) {
  if (res.locals.partidosPublic) return next();
  res.redirect('/reservar');
}

// ---- lista de partidos abiertos ----
router.get('/', gatePartidos, (req, res) => {
  const member = me(req);
  const viewer = member ? { member_no: member.member_no, level: member.level } : null;
  const all = B.listOpenMatches(viewer);
  const dia = ['hoy', 'manana', 'semana', 'todos'].includes(req.query.dia) ? req.query.dia : 'semana';
  const today = B.todayStr();
  const in7 = B.addDays(today, 7);
  const list = all.filter(b => {
    if (dia === 'hoy') return b.date === today;
    if (dia === 'manana') return b.date === B.addDays(today, 1);
    if (dia === 'todos') return true;
    return b.date <= in7;
  });
  const mine = member
    ? all.filter(b => b.titular_member_no === member.member_no || b.players.some(p => p.member_no === member.member_no))
    : [];
  res.renderPage('partidos/lista', {
    list, mine, dia, member, minToStr: B.minToStr,
    error: req.query.err || null, info: req.query.ok || null,
  });
});

// ---- crear un partido abierto ----
router.get('/nuevo', gatePartidos, requireMember, (req, res) => {
  const member = me(req);
  const courts = activeCourts();
  const date = validDate(req.query.date) ? clampDate(req.query.date) : B.addDays(B.todayStr(), 1);
  const court = courts.find(x => x.id === parseInt(req.query.court_id, 10)) || courts[0] || null;
  let starts = [];
  if (court) {
    for (const g of B.freeSegments(court.id, date)) {
      for (const s of B.bookableStarts(g.start, g.end, date)) starts.push(s);
    }
  }
  res.renderPage('partidos/nuevo', {
    member, courts, court, date, starts, config: B.getConfig(),
    minToStr: B.minToStr, error: req.query.err || null,
  });
});
router.post('/nuevo', gatePartidos, requireMember, (req, res) => {
  const member = me(req);
  const court = activeCourts().find(x => x.id === parseInt(req.body.court_id, 10));
  const date = clampDate(validDate(req.body.date));
  const fail = (msg) => res.redirect('/partidos/nuevo?date=' + date + (court ? '&court_id=' + court.id : '') + '&err=' + encodeURIComponent(msg));
  if (!court) return fail('Pista no válida.');
  const start_min = parseInt(req.body.start_min, 10);
  const duration_min = parseInt(req.body.duration_min, 10);
  const players = [1, 2, 3].map(i => ({
    name: (req.body['p' + i + '_name'] || '').trim(),
    member_no: (req.body['p' + i + '_member'] || '').trim(),
  }));
  const filled = players.filter(p => p.name).length;
  // Igual que la reserva normal: si faltan jugadores, se publica como abierto.
  const r = B.quickBook({
    court_id: court.id, court_name: court.name, date, start_min, duration_min,
    titular_member_no: member.member_no, players, open: filled < 3,
  });
  if (r.error) return fail(r.error);
  res.redirect('/reservar/abierto/' + r.id + '?from=partidos');
});

// ---- detalle: reutiliza la vista de partido abierto ----
router.get('/:id', gatePartidos, (req, res) => {
  res.redirect('/reservar/abierto/' + req.params.id + '?from=partidos');
});

module.exports = router;
