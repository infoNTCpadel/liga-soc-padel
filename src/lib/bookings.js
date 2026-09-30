// Módulo de reservas de pistas (fase 1) — web pública + gestión.
//
// Las tablas viven en `meta.db` (la BD de la liga a nivel de club, no en la
// de la temporada): así las reservas sobreviven a los cambios de temporada.
// - booking_config: horario de apertura/cierre, duración de franja, etc.
// - club_members: socios del club (nº de socio → nombre/teléfono/email).
// - bookings + booking_players: reservas con sus 4 jugadores.
// - booking_charges: cargos extra (p. ej. luz) con estado de pago.
// - court_blocks: bloqueos de pista (torneo, clase, mantenimiento).
// - waitlist: lista de espera con oferta automática y caducidad.
//
// Las pistas se leen de la BD de la temporada activa (tabla courts); aquí
// solo se guarda court_id + una copia del nombre para el histórico.

const { metaDb } = require('../db');

// `bdb` es el handle de reservas (apunta a meta.db, la BD del club).
const bdb = metaDb;
bdb.exec(`
CREATE TABLE IF NOT EXISTS booking_config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS club_members(
  member_no TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bookings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  court_id INTEGER NOT NULL,
  court_name TEXT NOT NULL,
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  titular_member_no TEXT NOT NULL,
  titular_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  payment_status TEXT NOT NULL DEFAULT 'ok',
  reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS booking_players(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  member_no TEXT NOT NULL DEFAULT '',
  is_guest INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS booking_charges(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS court_blocks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  court_id INTEGER NOT NULL,
  court_name TEXT NOT NULL,
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS waitlist(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  court_id INTEGER NOT NULL,
  court_name TEXT NOT NULL,
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  member_no TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'waiting',
  offered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_day ON bookings(date, court_id, status);
CREATE INDEX IF NOT EXISTS idx_blocks_day ON court_blocks(date, court_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_slot ON waitlist(date, court_id, start_min, status);
`);
// Migraciones para instalaciones que ya tenían las tablas sin estas columnas.
for (const sql of [
  'ALTER TABLE club_members ADD COLUMN email TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE bookings ADD COLUMN reminded_at TEXT',
]) {
  try { bdb.exec(sql); } catch (e) { /* ya existe */ }
}

// ------------------------------------------------------------ config
const DEFAULTS = {
  open_min: '480',        // 08:00
  close_min: '1380',      // 23:00
  slot_min: '90',         // duración de la franja de reserva
  days_ahead: '7',        // cuántos días adelante se puede reservar
  hold_min: '10',         // minutos que se guarda una plaza ofrecida de la lista de espera
  cancel_limit_h: '6',    // hasta cuántas horas antes puede anular el socio
  guest_price: '',        // precio de referencia del invitado (texto libre, p. ej. "6")
  reminders_enabled: '0', // recordatorios por email (requiere BREVO_API_KEY y MAIL_FROM)
  reminder_hours: '3',    // horas antes del inicio para enviar el recordatorio
};
function cfg(key) {
  const r = bdb.prepare('SELECT value FROM booking_config WHERE key = ?').get(key);
  return r ? r.value : DEFAULTS[key];
}
function setCfg(key, value) {
  bdb.prepare(`INSERT INTO booking_config(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}
function getConfig() {
  return {
    open_min: parseInt(cfg('open_min'), 10),
    close_min: parseInt(cfg('close_min'), 10),
    slot_min: parseInt(cfg('slot_min'), 10),
    days_ahead: parseInt(cfg('days_ahead'), 10),
    hold_min: parseInt(cfg('hold_min'), 10),
    cancel_limit_h: parseInt(cfg('cancel_limit_h'), 10),
    guest_price: cfg('guest_price'),
    reminders_enabled: cfg('reminders_enabled'),
    reminder_hours: parseInt(cfg('reminder_hours'), 10),
  };
}
// Valida la parrilla: sin huecos libres (el horario debe ser múltiplo exacto de la franja).
function validateGrid(open_min, close_min, slot_min) {
  if (!Number.isInteger(open_min) || !Number.isInteger(close_min) || !Number.isInteger(slot_min))
    return 'Los horarios y la franja deben ser números enteros.';
  if (open_min < 0 || close_min > 1440 || open_min >= close_min)
    return 'La apertura debe ser anterior al cierre (entre 00:00 y 24:00).';
  if (slot_min < 15 || slot_min > 240)
    return 'La franja debe estar entre 15 y 240 minutos.';
  if ((close_min - open_min) % slot_min !== 0)
    return 'El horario debe ser múltiplo exacto de la franja para no dejar huecos libres.';
  return null;
}

// ------------------------------------------------------------ fechas/horas
function minToStr(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
function strToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || '').trim());
  if (!m) return null;
  const v = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return v >= 0 && v <= 1440 ? v : null;
}
function todayStr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return todayStr(dt);
}
function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }

// ------------------------------------------------------------ socios
function getMember(no) {
  no = (no || '').trim();
  if (!no) return null;
  return bdb.prepare('SELECT * FROM club_members WHERE member_no = ?').get(no) || null;
}
function listMembers() {
  return bdb.prepare('SELECT * FROM club_members ORDER BY name').all();
}
function upsertMember(no, name, phone = '', email = '') {
  no = (no || '').trim();
  if (!no || !(name || '').trim()) return false;
  bdb.prepare(`INSERT INTO club_members(member_no, name, phone, email, active) VALUES(?, ?, ?, ?, 1)
    ON CONFLICT(member_no) DO UPDATE SET name = excluded.name, phone = excluded.phone,
      email = CASE WHEN excluded.email != '' THEN excluded.email ELSE club_members.email END`).run(
    no, name.trim(), (phone || '').trim(), (email || '').trim());
  return true;
}
function setMemberActive(no, active) {
  bdb.prepare('UPDATE club_members SET active = ? WHERE member_no = ?').run(active ? 1 : 0, no);
}
// Importa socios verificados de la temporada activa (filas {member_no, name, phone, email}).
function importMembers(rows) {
  let n = 0;
  for (const r of rows) {
    const no = (r.member_no || '').trim();
    if (!no || getMember(no)) continue;
    upsertMember(no, r.name || no, r.phone || '', r.email || '');
    n++;
  }
  return n;
}

// ------------------------------------------------------------ parrilla
function dayBookings(date) {
  return bdb.prepare(`SELECT * FROM bookings WHERE date = ? AND status = 'active' ORDER BY start_min`).all(date);
}
function dayBlocks(date) {
  return bdb.prepare(`SELECT * FROM court_blocks WHERE date = ? ORDER BY start_min`).all(date);
}
// Parrilla de un día: por pista, franjas con estado.
function gridFor(date, courts) {
  const c = getConfig();
  const bookings = dayBookings(date);
  const blocks = dayBlocks(date);
  const isToday = date === todayStr();
  const now = nowMin();
  const out = [];
  for (const court of courts) {
    const slots = [];
    for (let s = c.open_min; s < c.close_min; s += c.slot_min) {
      const e = s + c.slot_min;
      let status = 'free', booking = null, block = null;
      booking = bookings.find(b => b.court_id === court.id && overlaps(s, e, b.start_min, b.end_min)) || null;
      block = blocks.find(b => b.court_id === court.id && overlaps(s, e, b.start_min, b.end_min)) || null;
      if (block) status = 'blocked';
      else if (booking) status = 'booked';
      else if (isToday && e <= now) status = 'past';
      slots.push({ start_min: s, end_min: e, status, booking, block });
    }
    out.push({ court, slots });
  }
  return out;
}

// ------------------------------------------------------------ reservas
function validateNewBooking({ court_id, court_name, date, start_min, nslots, titular_member_no, players }) {
  const c = getConfig();
  const t = (titular_member_no || '').trim();
  const member = getMember(t);
  if (!member) return 'Indica un nº de socio válido para el titular.';
  if (!member.active) return 'Ese nº de socio está desactivado.';
  if (!Array.isArray(players) || players.length !== 4)
    return 'Hay que indicar los 4 jugadores.';
  for (const p of players) {
    if (!(p.name || '').trim()) return 'Falta el nombre de algún jugador.';
  }
  if (!Number.isInteger(start_min) || (start_min - c.open_min) % c.slot_min !== 0)
    return 'La hora de inicio debe coincidir con una franja de la parrilla.';
  const n = parseInt(nslots, 10) || 1;
  if (n < 1 || n > 8) return 'Número de franjas no válido.';
  const end_min = start_min + n * c.slot_min;
  if (end_min > c.close_min) return 'La reserva se sale del horario del club.';
  const today = todayStr();
  const maxDate = addDays(today, c.days_ahead);
  if (date < today || date > maxDate) return 'Fecha fuera del periodo de reserva.';
  if (date === today && start_min <= nowMin()) return 'Esa franja ya ha empezado.';
  const clash = bdb.prepare(
    `SELECT id FROM bookings WHERE date = ? AND court_id = ? AND status = 'active'
     AND start_min < ? AND ? < end_min LIMIT 1`).get(date, court_id, end_min, start_min);
  if (clash) return 'Esa pista ya está reservada en ese tramo.';
  const blocked = bdb.prepare(
    `SELECT reason FROM court_blocks WHERE date = ? AND court_id = ?
     AND start_min < ? AND ? < end_min LIMIT 1`).get(date, court_id, end_min, start_min);
  if (blocked) return 'Esa pista está bloqueada en ese tramo (' + (blocked.reason || 'bloqueo') + ').';
  const mine = bdb.prepare(
    `SELECT id FROM bookings WHERE date = ? AND titular_member_no = ? AND status = 'active'
     AND start_min < ? AND ? < end_min LIMIT 1`).get(date, t, end_min, start_min);
  if (mine) return 'Ya tienes otra reserva en ese tramo horario.';
  return null;
}

function createBooking({ court_id, court_name, date, start_min, nslots, titular_member_no, players }) {
  const err = validateNewBooking({ court_id, court_name, date, start_min, nslots, titular_member_no, players });
  if (err) return { error: err };
  const c = getConfig();
  const n = parseInt(nslots, 10) || 1;
  const end_min = start_min + n * c.slot_min;
  const t = titular_member_no.trim();
  const member = getMember(t);
  const normPlayers = players.map(p => {
    const mno = (p.member_no || '').trim();
    const m = mno ? getMember(mno) : null;
    // Un nº de socio inexistente o desactivado cuenta como invitado:
    // así un typo no cuela juego gratis y recepción lo ve pendiente.
    const isMember = !!(m && m.active);
    return { name: p.name.trim(), member_no: mno, is_guest: isMember ? 0 : 1 };
  });
  const payment_status = normPlayers.some(p => p.is_guest) ? 'pending' : 'ok';
  const r = bdb.prepare(
    `INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name, payment_status)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
    court_id, court_name, date, start_min, end_min, t, member.name, payment_status);
  const id = Number(r.lastInsertRowid);
  const ins = bdb.prepare('INSERT INTO booking_players(booking_id, name, member_no, is_guest) VALUES(?, ?, ?, ?)');
  for (const p of normPlayers) ins.run(id, p.name, p.member_no, p.is_guest);
  // Si había oferta de lista de espera para este socio en esta franja, se consume.
  bdb.prepare(`UPDATE waitlist SET status = 'done' WHERE member_no = ? AND date = ? AND court_id = ?
    AND start_min = ? AND status IN ('waiting', 'offered')`).run(t, date, court_id, start_min);
  return { id, payment_status };
}

function getBooking(id) {
  const b = bdb.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!b) return null;
  b.players = bdb.prepare('SELECT * FROM booking_players WHERE booking_id = ? ORDER BY id').all(id);
  b.charges = bdb.prepare('SELECT * FROM booking_charges WHERE booking_id = ? ORDER BY id').all(id);
  return b;
}

function cancelBooking(id, byStaff = false) {
  const b = bdb.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!b || b.status !== 'active') return { error: 'La reserva no existe o ya está anulada.' };
  if (!byStaff) {
    const c = getConfig();
    const start = new Date(b.date + 'T00:00:00');
    start.setMinutes(b.start_min);
    const hoursLeft = (start - new Date()) / 3600000;
    if (hoursLeft < c.cancel_limit_h)
      return { error: `Ya no se puede anular online (límite: ${c.cancel_limit_h} h antes). Contacta con recepción.` };
  }
  bdb.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(id);
  promoteWaitlist(b.court_id, b.date, b.start_min, b.end_min);
  return { ok: true };
}

// ------------------------------------------------------------ lista de espera
function expireOffers() {
  const c = getConfig();
  bdb.prepare(
    `UPDATE waitlist SET status = 'expired' WHERE status = 'offered'
     AND datetime(offered_at, '+' || ? || ' minutes') < datetime('now')`).run(c.hold_min);
}
// Al liberarse [start,end) en una pista: ofrece cada franja al primero en espera.
function promoteWaitlist(court_id, date, start_min, end_min) {
  expireOffers();
  const c = getConfig();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  for (let s = start_min; s < end_min; s += c.slot_min) {
    const w = bdb.prepare(
      `SELECT * FROM waitlist WHERE court_id = ? AND date = ? AND start_min = ?
       AND status = 'waiting' ORDER BY created_at LIMIT 1`).get(court_id, date, s);
    if (!w) continue;
    // Solo se ofrece si la franja sigue libre.
    const clash = bdb.prepare(
      `SELECT 1 FROM bookings WHERE date = ? AND court_id = ? AND status = 'active'
       AND start_min < ? AND ? < end_min LIMIT 1`).get(date, court_id, s + c.slot_min, s);
    const blocked = bdb.prepare(
      `SELECT 1 FROM court_blocks WHERE date = ? AND court_id = ?
       AND start_min < ? AND ? < end_min LIMIT 1`).get(date, court_id, s + c.slot_min, s);
    if (clash || blocked) continue;
    bdb.prepare("UPDATE waitlist SET status = 'offered', offered_at = ? WHERE id = ?").run(now, w.id);
  }
}

function joinWaitlist({ court_id, court_name, date, start_min, member_no }) {
  expireOffers();
  const c = getConfig();
  const t = (member_no || '').trim();
  const member = getMember(t);
  if (!member) return { error: 'Indica un nº de socio válido.' };
  if (!member.active) return { error: 'Ese nº de socio está desactivado.' };
  if ((start_min - c.open_min) % c.slot_min !== 0) return 'Franja no válida.';
  const end_min = start_min + c.slot_min;
  const today = todayStr();
  if (date < today || date > addDays(today, c.days_ahead)) return { error: 'Fecha fuera del periodo de reserva.' };
  if (date === today && start_min <= nowMin()) return { error: 'Esa franja ya ha empezado.' };
  const dup = bdb.prepare(
    `SELECT 1 FROM waitlist WHERE court_id = ? AND date = ? AND start_min = ? AND member_no = ?
     AND status IN ('waiting', 'offered') LIMIT 1`).get(court_id, date, start_min, t);
  if (dup) return { error: 'Ya estás en la lista de espera de esa franja.' };
  // Si está libre, que reserve directamente.
  const free = !bdb.prepare(
    `SELECT 1 FROM bookings WHERE date = ? AND court_id = ? AND status = 'active'
     AND start_min < ? AND ? < end_min LIMIT 1`).get(date, court_id, end_min, start_min)
    && !bdb.prepare(
    `SELECT 1 FROM court_blocks WHERE date = ? AND court_id = ?
     AND start_min < ? AND ? < end_min LIMIT 1`).get(date, court_id, end_min, start_min);
  if (free) return { error: 'Esa franja está libre: resérvala directamente.' };
  bdb.prepare(
    `INSERT INTO waitlist(court_id, court_name, date, start_min, end_min, member_no, name, phone)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(court_id, court_name, date, start_min, end_min, t, member.name, member.phone || '');
  return { ok: true };
}

function confirmOffer(waitlistId, member_no) {
  expireOffers();
  const w = bdb.prepare('SELECT * FROM waitlist WHERE id = ?').get(waitlistId);
  if (!w || w.status !== 'offered') return { error: 'La oferta ya no está disponible.' };
  if (w.member_no !== (member_no || '').trim()) return { error: 'Esa oferta no es para este socio.' };
  // La oferta se confirma creando la reserva (el socio es titular y jugador 1).
  const member = getMember(w.member_no);
  const players = [
    { name: member.name, member_no: member.member_no },
    { name: '', member_no: '' }, { name: '', member_no: '' }, { name: '', member_no: '' },
  ];
  // El formulario pedirá los otros 3; aquí validamos disponibilidad mínima.
  const err = validateNewBooking({
    court_id: w.court_id, court_name: w.court_name, date: w.date, start_min: w.start_min,
    nslots: 1, titular_member_no: w.member_no,
    players: [{ name: member.name, member_no: member.member_no },
              { name: 'Jugador 2', member_no: '' }, { name: 'Jugador 3', member_no: '' }, { name: 'Jugador 4', member_no: '' }],
  });
  if (err) {
    bdb.prepare("UPDATE waitlist SET status = 'expired' WHERE id = ?").run(w.id);
    return { error: 'La franja ya no está libre.' };
  }
  return { offer: w };
}

function leaveWaitlist(id, member_no) {
  bdb.prepare(`UPDATE waitlist SET status = 'cancelled' WHERE id = ? AND member_no = ?
    AND status IN ('waiting', 'offered')`).run(id, (member_no || '').trim());
}

function memberArea(member_no) {
  expireOffers();
  const t = (member_no || '').trim();
  const member = getMember(t);
  if (!member) return null;
  const today = todayStr();
  const bookings = bdb.prepare(
    `SELECT * FROM bookings WHERE titular_member_no = ? AND status = 'active' AND date >= ?
     ORDER BY date, start_min`).all(t, today).map(b => ({ ...b, players: bdb.prepare('SELECT * FROM booking_players WHERE booking_id = ? ORDER BY id').all(b.id) }));
  const offers = bdb.prepare(
    `SELECT * FROM waitlist WHERE member_no = ? AND status = 'offered' ORDER BY date, start_min`).all(t);
  const waiting = bdb.prepare(
    `SELECT * FROM waitlist WHERE member_no = ? AND status = 'waiting' ORDER BY date, start_min`).all(t);
  return { member, bookings, offers, waiting };
}

// ------------------------------------------------------------ bloqueos
function validateBlock({ court_id, date, start_min, end_min }) {
  const c = getConfig();
  if (!Number.isInteger(start_min) || !Number.isInteger(end_min) || start_min >= end_min)
    return 'Tramo no válido.';
  if ((start_min - c.open_min) % c.slot_min !== 0 || (end_min - c.open_min) % c.slot_min !== 0)
    return 'El bloqueo debe alinearse con las franjas de la parrilla.';
  if (start_min < c.open_min || end_min > c.close_min) return 'El bloqueo se sale del horario del club.';
  const today = todayStr();
  if (date < today || date > addDays(today, c.days_ahead)) return 'Fecha fuera del periodo de reserva.';
  const clash = bdb.prepare(
    `SELECT 1 FROM court_blocks WHERE date = ? AND court_id = ?
     AND start_min < ? AND ? < end_min LIMIT 1`).get(date, court_id, end_min, start_min);
  if (clash) return 'Ya hay un bloqueo en ese tramo.';
  return null;
}
function affectedBookings(court_id, date, start_min, end_min) {
  return bdb.prepare(
    `SELECT * FROM bookings WHERE date = ? AND court_id = ? AND status = 'active'
     AND start_min < ? AND ? < end_min ORDER BY start_min`).all(date, court_id, end_min, start_min);
}
function createBlock({ court_id, court_name, date, start_min, end_min, reason, notes, force }) {
  const err = validateBlock({ court_id, date, start_min, end_min });
  if (err) return { error: err };
  const affected = affectedBookings(court_id, date, start_min, end_min);
  if (affected.length && !force) return { conflict: affected };
  for (const b of affected) {
    bdb.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
    promoteWaitlist(b.court_id, b.date, b.start_min, b.end_min);
  }
  const r = bdb.prepare(
    `INSERT INTO court_blocks(court_id, court_name, date, start_min, end_min, reason, notes)
     VALUES(?, ?, ?, ?, ?, ?, ?)`).run(court_id, court_name, date, start_min, end_min, reason || '', notes || '');
  return { id: Number(r.lastInsertRowid), cancelled: affected.length };
}
function deleteBlock(id) {
  bdb.prepare('DELETE FROM court_blocks WHERE id = ?').run(id);
}
function listBlocks(fromDate) {
  return bdb.prepare('SELECT * FROM court_blocks WHERE date >= ? ORDER BY date, start_min').all(fromDate || todayStr());
}

// ------------------------------------------------------------ cobros de reservas
function setBookingPaid(id, paid) {
  bdb.prepare("UPDATE bookings SET payment_status = ? WHERE id = ?").run(paid ? 'ok' : 'pending', id);
}
function addCharge(booking_id, label, amount_cents) {
  if (!(label || '').trim()) return { error: 'Indica el concepto del cargo.' };
  const cents = Math.round(Number(amount_cents) || 0);
  if (cents < 0) return { error: 'Importe no válido.' };
  bdb.prepare('INSERT INTO booking_charges(booking_id, label, amount_cents) VALUES(?, ?, ?)')
    .run(booking_id, label.trim(), cents);
  return { ok: true };
}
function setChargePaid(id, paid) {
  bdb.prepare('UPDATE booking_charges SET paid = ? WHERE id = ?').run(paid ? 1 : 0, id);
}
function deleteCharge(id) {
  bdb.prepare('DELETE FROM booking_charges WHERE id = ?').run(id);
}
// Reservas de un día con jugadores y cargos (para recepción/admin).
function dayDetail(date) {
  const bookings = bdb.prepare(
    `SELECT * FROM bookings WHERE date = ? ORDER BY start_min`).all(date).map(b => ({
    ...b,
    players: bdb.prepare('SELECT * FROM booking_players WHERE booking_id = ? ORDER BY id').all(b.id),
    charges: bdb.prepare('SELECT * FROM booking_charges WHERE booking_id = ? ORDER BY id').all(b.id),
  }));
  const blocks = dayBlocks(date);
  return { bookings, blocks };
}
function pendingPayments(date) {
  return bdb.prepare(
    `SELECT * FROM bookings WHERE date = ? AND status = 'active' AND payment_status = 'pending'
     ORDER BY start_min`).all(date).map(b => ({
    ...b,
    players: bdb.prepare('SELECT * FROM booking_players WHERE booking_id = ? ORDER BY id').all(b.id),
  }));
}

// ------------------------------------------------------------ recordatorios por email
// Envía con Brevo (misma API que PadelVallès). Requiere BREVO_API_KEY y MAIL_FROM.
async function sendEmail(to, subject, html) {
  const key = process.env.BREVO_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) return { skipped: true };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: from, name: 'Reservas de pistas' },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error('Brevo respondió ' + res.status);
  return { ok: true };
}

// Reservas activas cuyo inicio cae dentro de la ventana de recordatorio,
// aún no avisadas y con email del titular conocido.
function dueReminders(now = new Date()) {
  const c = getConfig();
  if (c.reminders_enabled !== '1') return [];
  const limit = new Date(now.getTime() + c.reminder_hours * 3600000);
  const rows = bdb.prepare(
    `SELECT b.*, m.email AS titular_email FROM bookings b
     JOIN club_members m ON m.member_no = b.titular_member_no
     WHERE b.status = 'active' AND b.reminded_at IS NULL
       AND b.date >= ? AND b.date <= ?
       AND COALESCE(m.email, '') != ''
     ORDER BY b.date, b.start_min`).all(todayStr(now), todayStr(limit));
  return rows.filter(b => {
    const start = new Date(b.date + 'T00:00:00');
    start.setMinutes(b.start_min);
    return start > now && start <= limit;
  });
}

function reminderHtml(b) {
  const players = bdb.prepare('SELECT name, is_guest FROM booking_players WHERE booking_id = ? ORDER BY id').all(b.id);
  const list = players.map(p => `<li>${p.name}${p.is_guest ? ' (invitado: pagar en recepción)' : ''}</li>`).join('');
  return `<p>Hola ${b.titular_name},</p>
<p>Te recordamos tu reserva de pista:</p>
<p><strong>${b.court_name}</strong> · ${b.date.split('-').reverse().join('/')} · ${minToStr(b.start_min)}–${minToStr(b.end_min)}</p>
<ul>${list}</ul>
${b.payment_status === 'pending' ? '<p><strong>Hay invitados en tu reserva: deberán pagar en recepción antes de jugar.</strong></p>' : ''}
<p>Si no vas a venir, anula tu reserva desde "Mis reservas" para liberar la pista.</p>`;
}

async function checkReminders() {
  const due = dueReminders();
  for (const b of due) {
    try {
      const r = await sendEmail(
        b.titular_email,
        `Recordatorio: pista ${b.court_name} el ${b.date.split('-').reverse().join('/')} a las ${minToStr(b.start_min)}`,
        reminderHtml(b));
      if (r.ok) bdb.prepare("UPDATE bookings SET reminded_at = datetime('now') WHERE id = ?").run(b.id);
    } catch (e) {
      console.error('reminder', b.id, e.message);
    }
  }
  return due.length;
}

module.exports = {
  bdb, cfg, setCfg, getConfig, validateGrid,
  minToStr, strToMin, todayStr, addDays, nowMin, overlaps,
  getMember, listMembers, upsertMember, setMemberActive, importMembers,
  dayBookings, dayBlocks, gridFor,
  validateNewBooking, createBooking, getBooking, cancelBooking,
  expireOffers, promoteWaitlist, joinWaitlist, confirmOffer, leaveWaitlist, memberArea,
  validateBlock, affectedBookings, createBlock, deleteBlock, listBlocks,
  setBookingPaid, addCharge, setChargePaid, deleteCharge, dayDetail, pendingPayments,
  dueReminders, checkReminders, sendEmail,
};
