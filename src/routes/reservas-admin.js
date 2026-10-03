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

// Estado del formulario de horarios por día: filas Lun–Dom y texto de fechas especiales.
function hoursFormState(config) {
  let h = {};
  try { h = JSON.parse(config.hours_json || '{}'); } catch (e) { h = {}; }
  const names = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const rows = [1, 2, 3, 4, 5, 6, 0].map(wd => {
    const ov = h.weekday ? h.weekday[String(wd)] : undefined;
    const eff = ov === null ? null : (ov ? { o: ov[0], c: ov[1] } : { o: config.open_min, c: config.close_min });
    return {
      wd, name: names[wd], custom: ov !== undefined,
      closed: eff === null,
      open: B.minToStr(eff ? eff.o : config.open_min),
      close: B.minToStr(eff ? eff.c : config.close_min),
    };
  });
  const dates = (h.dates) || {};
  const specialText = Object.keys(dates).sort().map(d => {
    const v = dates[d];
    return v ? `${d} ${B.minToStr(v[0])}-${B.minToStr(v[1])}` : d;
  }).join('\n');
  return { dayRows: rows, specialText };
}

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
      staffBase: '/admin/reservas', staffDay: '/admin/reservas/dia', anularPrefix: '/admin/reservas/reservas/',
    }, courts),
  });
});
router.post('/rapida', (req, res) => {
  const courts = activeCourts();
  const court = courts.find(x => x.id === parseInt(req.body.court_id, 10));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : B.todayStr();
  const back = '/admin/reservas/parrilla?date=' + date;
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
router.post('/reservas/:id/anular', (req, res) => {
  const b = B.getBooking(parseInt(req.params.id, 10));
  const date = b ? b.date : B.todayStr();
  B.cancelBooking(parseInt(req.params.id, 10), true);
  res.redirect('/admin/reservas/dia?date=' + date + '&ok=' + encodeURIComponent('Reserva anulada.'));
});
router.post('/reservas/:id/pago', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = B.getBooking(id);
  const st = B.setBookingPaid(id, req.body.paid === '1');
  if (req.body.json === '1' || req.headers.accept === 'application/json')
    return res.json({ ok: true, payment_status: st });
  const date = b ? b.date : B.todayStr();
  res.redirect('/admin/reservas/dia?date=' + date + '&ok=' + encodeURIComponent('Pago actualizado.'));
});
// Añadir un jugador desde el panel de la parrilla (JSON).
router.post('/reservas/:id/anadir-jugador', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = B.addPlayer(id, req.body.name, req.body.member_no);
  if (r.error) return res.json({ ok: false, error: r.error });
  res.json({ ok: true, booking: B.getBooking(id) });
});
// Quitar un jugador desde el panel de la parrilla (JSON).
router.post('/reservas/:id/quitar-jugador', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = B.removePlayer(id, parseInt(req.body.player_id, 10));
  if (r.error) return res.json({ ok: false, error: r.error });
  res.json({ ok: true, booking: B.getBooking(id) });
});
// Abrir un partido cerrado con jugadores incompletos para buscar jugadores.
router.post('/reservas/:id/abrir', (req, res) => {
  const b = B.getBooking(parseInt(req.params.id, 10));
  const date = b ? b.date : B.todayStr();
  const r = b ? B.openMatchForPlayers(b.id) : { error: 'No encontrada.' };
  res.redirect('/admin/reservas/dia?date=' + date + (r.error ? '' : '&ok=' + encodeURIComponent('Partido abierto: otros socios del nivel podrán apuntarse.')));
});
router.post('/reservas/:id/cargo', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = B.getBooking(id);
  const date = b ? b.date : B.todayStr();
  const cents = Math.round(parseFloat(String(req.body.amount || '').replace(',', '.')) * 100) || 0;
  const r = B.addCharge(id, req.body.label || '', cents, req.body.player_id || null);
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
// Completar jugadores de una reserva (el titular cuenta como 1).
router.post('/reservas/:id/jugadores', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = B.getBooking(id);
  const date = b ? b.date : B.todayStr();
  if (b && b.status === 'active') {
    const players = [1, 2, 3].map(i => ({
      name: (req.body['p' + i + '_name'] || '').trim(),
      member_no: (req.body['p' + i + '_member'] || '').trim(),
    }));
    B.setPlayers(id, b.titular_member_no, players);
    B.syncOpenSpots(id); // si se completaron los 4, el partido se cierra solo
  }
  res.redirect('/admin/reservas/dia?date=' + date + '&ok=' + encodeURIComponent('Jugadores actualizados.'));
});

// ---- nueva reserva (personal) ----
router.get('/nueva', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : B.todayStr();
  const courts = activeCourts();
  const court = courts.find(x => x.id === parseInt(req.query.court, 10)) || null;
  const desde = parseInt(req.query.desde, 10);
  const durQ = parseInt(req.query.duracion, 10);
  const d = {
    action: '/admin/reservas/nueva', backUrl: '/admin/reservas/dia?date=' + date,
    error: null, date, courts, court, config: B.getConfig(), minToStr: B.minToStr,
    desde: Number.isInteger(desde) ? desde : null,
    duracion: B.getConfig().durations.includes(durQ) ? durQ : null,
    segs: court && !Number.isInteger(desde) ? B.freeSegments(court.id, date) : null,
    seg: null, starts: null,
  };
  if (court && Number.isInteger(desde)) {
    const seg = B.freeSegments(court.id, date).find(g => desde >= g.start && desde < g.end);
    if (!seg) return res.redirect('/admin/reservas/nueva?date=' + date + '&court=' + court.id);
    d.seg = seg; d.starts = B.bookableStarts(seg.start, seg.end, date);
  }
  res.renderPage('reservas/staff-nueva', d);
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
      action: '/admin/reservas/nueva', backUrl: '/admin/reservas/dia?date=' + date,
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
  res.redirect('/admin/reservas/dia?date=' + date + '&ok=' + encodeURIComponent('Reserva creada.'));
});

// ---- configuración ----
router.get('/config', (req, res) => {
  const config = B.getConfig();
  res.renderPage('reservas-admin/config', { error: null, ok: null, config, minToStr: B.minToStr, ...hoursFormState(config) });
});
router.post('/config', (req, res) => {
  const open_min = B.strToMin(req.body.open) ?? 480;
  const close_min = B.strToMin(req.body.close) ?? 1380;
  const durationsStr = (req.body.slot_durations || '').trim();
  const days_ahead = Math.min(90, Math.max(1, parseInt(req.body.days_ahead, 10) || 14));
  const hold_min = Math.min(120, Math.max(5, parseInt(req.body.hold_min, 10) || 10));
  const cancel_limit_h = Math.min(72, Math.max(0, parseInt(req.body.cancel_limit_h, 10) || 0));
  const _mab = parseInt(req.body.max_active_bookings, 10);
  const max_active_bookings = Number.isInteger(_mab) ? Math.min(20, Math.max(0, _mab)) : B.getConfig().max_active_bookings;
  const err = B.validateConfig(open_min, close_min, durationsStr);
  const renderErr = (msg) => {
    const config = B.getConfig();
    return res.renderPage('reservas-admin/config', { error: msg, ok: null, config, minToStr: B.minToStr, ...hoursFormState(config) });
  };
  if (err) return renderErr(err);
  // Horarios por día de la semana: solo se guarda lo que difiera del horario general.
  // (Si el formulario no trae estos campos —p. ej. clientes antiguos—, no se tocan.)
  const wdVals = {};
  const hasWdFields = [0, 1, 2, 3, 4, 5, 6].some(wd => req.body['wd' + wd + '_open'] !== undefined || req.body['wd' + wd + '_closed'] !== undefined);
  if (hasWdFields) for (const wd of [0, 1, 2, 3, 4, 5, 6]) {
    if (req.body['wd' + wd + '_closed'] === '1') { wdVals[String(wd)] = null; continue; }
    const o = B.strToMin(req.body['wd' + wd + '_open']);
    const c = B.strToMin(req.body['wd' + wd + '_close']);
    if (o === null || c === null) return renderErr('Revisa los horarios por día: hay horas no válidas.');
    if (o >= c) return renderErr('Revisa los horarios por día: la apertura debe ser anterior al cierre.');
    if (o !== open_min || c !== close_min) wdVals[String(wd)] = [o, c];
  }
  // Fechas especiales: "AAAA-MM-DD" (cerrado) o "AAAA-MM-DD HH:MM-HH:MM".
  const datesVals = {};
  for (const line of (req.body.special_dates || '').split('\n').map(l => l.trim()).filter(Boolean)) {
    const m = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2}))?$/.exec(line);
    if (!m) return renderErr(`Fecha especial no válida: "${line}". Usa AAAA-MM-DD o AAAA-MM-DD HH:MM-HH:MM.`);
    if (m[2]) {
      const o = B.strToMin(m[2]), c = B.strToMin(m[3]);
      if (o === null || c === null || o >= c) return renderErr(`Horario no válido en: "${line}".`);
      datesVals[m[1]] = [o, c];
    } else datesVals[m[1]] = null;
  }
  const hv = B.validateHoursJson(JSON.stringify({ weekday: wdVals, dates: datesVals }));
  if (hv.error) return renderErr(hv.error);
  B.setCfg('open_min', open_min); B.setCfg('close_min', close_min);
  B.setCfg('slot_durations', B.parseDurations(durationsStr).join(','));
  B.setCfg('days_ahead', days_ahead); B.setCfg('hold_min', hold_min); B.setCfg('cancel_limit_h', cancel_limit_h);
  B.setCfg('max_active_bookings', max_active_bookings);
  B.setCfg('guest_price', (req.body.guest_price || '').trim());
  B.setCfg('reminders_enabled', req.body.reminders_enabled === '1' ? '1' : '0');
  B.setCfg('reminder_hours', Math.min(24, Math.max(1, parseInt(req.body.reminder_hours, 10) || 3)));
  // Solo se tocan los horarios por día si el formulario los traía (no borrar overrides con un POST antiguo).
  if (hasWdFields || req.body.special_dates !== undefined) B.setCfg('hours_json', JSON.stringify(hv.value));
  // Aviso si se cierra una fecha especial que ya tiene reservas activas.
  const config = B.getConfig();
  const bookedClosed = Object.keys(datesVals).filter(d => datesVals[d] === null && d >= B.todayStr() && B.dayBookings(d).length > 0);
  const okMsg = bookedClosed.length
    ? `Configuración guardada. Ojo: hay reservas activas en día cerrado (${bookedClosed.join(', ')}); anúlalas o avisa a los socios.`
    : 'Configuración guardada.';
  res.renderPage('reservas-admin/config', { error: null, ok: okMsg, config, minToStr: B.minToStr, ...hoursFormState(config) });
});

// ---- socios ----
router.get('/socios/buscar', (req, res) => {
  res.json(B.searchMembers(req.query.q || ''));
});
router.get('/socios', (req, res) => {
  res.renderPage('reservas-admin/socios', {
    members: B.listMembers(), ok: req.query.ok || null, error: null, newPin: req.query.pin || null,
  });
});
router.post('/socios', (req, res) => {
  const ok = B.upsertMember(req.body.member_no, req.body.name, req.body.phone, req.body.email);
  res.redirect('/admin/reservas/socios' + (ok ? '?ok=' + encodeURIComponent('Socio guardado.') : ''));
});
router.post('/socios/toggle', (req, res) => {
  B.setMemberActive(req.body.member_no, req.body.active === '1');
  res.redirect('/admin/reservas/socios');
});
router.post('/socios/pin', (req, res) => {
  const no = (req.body.member_no || '').trim();
  if (!B.getMember(no)) return res.redirect('/admin/reservas/socios');
  const pin = B.resetPin(no);
  res.redirect('/admin/reservas/socios?ok=' + encodeURIComponent('Nuevo PIN temporal para el socio ' + no + '.') + '&pin=' + pin);
});
router.post('/socios/importar', (req, res) => {
  let rows = [];
  try {
    // Todos los jugadores inscritos (parejas activas o pendientes) con nº de socio, con su nivel.
    // El nivel solo rellena los vacíos, nunca sobrescribe.
    rows = db.prepare(
      `SELECT TRIM(p.member_no) AS member_no, MAX(p.name) AS name, MAX(p.phone) AS phone,
              MAX(p.email) AS email, MAX(p.level) AS level
       FROM players p
       JOIN pairs pa ON pa.player1_id = p.id OR pa.player2_id = p.id
       WHERE p.member_no IS NOT NULL AND TRIM(p.member_no) != '' AND pa.status IN ('pending','active')
       GROUP BY TRIM(p.member_no)`).all();
  } catch (e) { rows = []; }
  const { imported, levels } = B.importMembers(rows);
  const msg = (imported || levels)
    ? `${imported} socio(s) importados, ${levels} nivel(es) sincronizados de la liga.`
    : 'No había socios nuevos ni niveles que sincronizar.';
  res.redirect('/admin/reservas/socios?ok=' + encodeURIComponent(msg));
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
  const ids = [].concat(req.body.court_ids || req.body.court_id || [])
    .map(x => parseInt(x, 10)).filter(x => courts.some(c => c.id === x));
  const date_from = req.body.date_from, date_to = req.body.date_to || req.body.date_from;
  const start_min = B.strToMin(req.body.start);
  const end_min = B.strToMin(req.body.end);
  const reason = req.body.reason || '';
  const notes = (req.body.notes || '').trim();
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '';
  const render = (error) => res.renderPage('reservas-admin/bloqueos', {
    blocks: B.listBlocks(), courts, config: B.getConfig(), error, minToStr: B.minToStr, today: B.todayStr(),
  });
  if (!ids.length || !/^\d{4}-\d{2}-\d{2}$/.test(date_from || '')) return render('Pista o fecha no válidos.');
  // Fase 1: validar todas las pistas sin crear nada todavía.
  const plan = [];
  for (const id of ids) {
    const court = courts.find(x => x.id === id);
    const err = B.validateBlock({ court_id: id, date_from, date_to, start_min, end_min });
    if (err) return render(court.name + ': ' + err);
    plan.push({ court, affected: B.affectedBookings(id, date_from, date_to, start_min, end_min) });
  }
  const withConflict = plan.filter(p => p.affected.length);
  if (withConflict.length && req.body.force !== '1') {
    return res.renderPage('reservas-admin/bloqueo-conflicto', {
      courts: plan.map(p => p.court), courtIds: ids,
      date_from, date_to, start_min, end_min, reason, notes, color,
      affected: withConflict.flatMap(p => p.affected.map(b => ({ ...b, court_name: p.court.name }))),
      minToStr: B.minToStr,
    });
  }
  // Fase 2: crear los bloqueos (con force si se confirmó el conflicto).
  for (const p of plan) {
    B.createBlock({
      court_id: p.court.id, court_name: p.court.name, date_from, date_to,
      start_min, end_min, reason, notes, color, force: true,
    });
  }
  res.redirect('/admin/reservas/bloqueos');
});
router.post('/bloqueos/:id/eliminar', (req, res) => {
  B.deleteBlock(parseInt(req.params.id, 10));
  res.redirect('/admin/reservas/bloqueos');
});

module.exports = router;
