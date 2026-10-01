// Módulo de reservas de pistas (fase 1) — web pública + gestión.
//
// Las tablas viven en `meta.db` (la BD de la liga a nivel de club, no en la
// de la temporada): así las reservas sobreviven a los cambios de temporada.
// - booking_config: horario de apertura/cierre, duraciones de reserva, etc.
// - club_members: socios del club (nº de socio → nombre/teléfono/email + PIN).
// - bookings + booking_players: reservas con sus jugadores (el titular es el jugador 1).
// - booking_charges: cargos extra (p. ej. luz) con estado de pago.
// - court_blocks: bloqueos de pista (torneo, clase, mantenimiento), por rango de fechas.
// - waitlist: lista de espera con oferta automática y caducidad.
//
// Modelo de disponibilidad (sin huecos): el día por pista es una línea de
// tiempo [apertura, cierre] menos reservas y bloqueos = tramos libres. Una
// reserva nueva siempre empieza en un inicio "alcanzable": inicio del tramo
// libre + combinaciones de las duraciones configuradas (p. ej. 60/75). Así
// lo que queda antes del inicio es siempre rellenable y nunca quedan restos
// inservibles (ej.: libre desde 10:15 → se puede a las 10:15, 11:15, 11:30…,
// pero no a las 10:30).
//
// Las pistas se leen de la BD de la temporada activa (tabla courts); aquí
// solo se guarda court_id + una copia del nombre para el histórico.

const crypto = require('crypto');
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
CREATE TABLE IF NOT EXISTS member_blocks(
  blocker_member_no TEXT NOT NULL, blocked_member_no TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(blocker_member_no, blocked_member_no));
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
// Migraciones para instalaciones que ya tenían las tablas con el esquema anterior.
for (const sql of [
  'ALTER TABLE club_members ADD COLUMN email TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE bookings ADD COLUMN reminded_at TEXT',
  'ALTER TABLE club_members ADD COLUMN pin_hash TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE club_members ADD COLUMN level REAL',
  'ALTER TABLE bookings ADD COLUMN open_spots INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE court_blocks ADD COLUMN date_from TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE court_blocks ADD COLUMN date_to TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE waitlist ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 0',
]) {
  try { bdb.exec(sql); } catch (e) { /* ya existe */ }
}
try {
  bdb.exec("UPDATE court_blocks SET date_from = date, date_to = date WHERE date_from = ''");
  bdb.exec('UPDATE waitlist SET duration_min = end_min - start_min WHERE duration_min = 0');
  // La antigua franja única pasa a lista de duraciones (p. ej. 90 → "90").
  const hasDurs = bdb.prepare("SELECT 1 FROM booking_config WHERE key = 'slot_durations'").get();
  const oldSlot = bdb.prepare("SELECT value FROM booking_config WHERE key = 'slot_min'").get();
  if (!hasDurs && oldSlot) {
    bdb.prepare("INSERT INTO booking_config(key, value) VALUES('slot_durations', ?)").run(String(parseInt(oldSlot.value, 10) || 90));
  }
} catch (e) { /* instalación nueva o ya migrada */ }

// ------------------------------------------------------------ config
const DEFAULTS = {
  open_min: '480',        // 08:00
  close_min: '1380',      // 23:00
  slot_durations: '60,75', // duraciones de reserva permitidas (min), separadas por comas
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
function parseDurations(s) {
  const ds = String(s || '').split(',').map(x => parseInt(x.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 15 && n <= 240);
  return [...new Set(ds)].sort((a, b) => a - b);
}
function getConfig() {
  let durations = parseDurations(cfg('slot_durations'));
  if (!durations.length) durations = parseDurations(DEFAULTS.slot_durations);
  return {
    open_min: parseInt(cfg('open_min'), 10),
    close_min: parseInt(cfg('close_min'), 10),
    durations,
    slot_durations: durations.join(','),
    days_ahead: parseInt(cfg('days_ahead'), 10),
    hold_min: parseInt(cfg('hold_min'), 10),
    cancel_limit_h: parseInt(cfg('cancel_limit_h'), 10),
    guest_price: cfg('guest_price'),
    reminders_enabled: cfg('reminders_enabled'),
    reminder_hours: parseInt(cfg('reminder_hours'), 10),
  };
}
// Valida la configuración: horarios coherentes y al menos una duración válida.
function validateConfig(open_min, close_min, durationsStr) {
  if (!Number.isInteger(open_min) || !Number.isInteger(close_min))
    return 'Los horarios deben ser horas válidas.';
  if (open_min < 0 || close_min > 1440 || open_min >= close_min)
    return 'La apertura debe ser anterior al cierre (entre 00:00 y 24:00).';
  const ds = parseDurations(durationsStr);
  if (!ds.length) return 'Indica al menos una duración válida (15–240 min), p. ej. "60,75".';
  if (Math.min(...ds) > (close_min - open_min))
    return 'La duración mínima no cabe en el horario del club.';
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
function normPhone(s) { return String(s || '').replace(/\D/g, ''); }

// ------------------------------------------------------------ socios + PIN
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
function updateMemberContact(no, phone, email) {
  bdb.prepare('UPDATE club_members SET phone = ?, email = ? WHERE member_no = ?')
    .run((phone || '').trim(), (email || '').trim(), (no || '').trim());
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
// PIN de acceso para la reserva web (scrypt con sal). Independiente de la liga.
function validPin(pin) { return /^\d{4,8}$/.test(String(pin || '')); }
function setPin(member_no, pin) {
  if (!validPin(pin)) return false;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  bdb.prepare('UPDATE club_members SET pin_hash = ? WHERE member_no = ?')
    .run(salt + ':' + hash, (member_no || '').trim());
  return true;
}
function hasPin(member_no) {
  const m = getMember(member_no);
  return !!(m && m.pin_hash);
}
function checkPin(member_no, pin) {
  const m = getMember(member_no);
  if (!m || !m.pin_hash || !m.active) return false;
  const [salt, hash] = String(m.pin_hash).split(':');
  if (!salt || !hash) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      crypto.scryptSync(String(pin || ''), salt, 32));
  } catch (e) { return false; }
}
// Genera un PIN temporal (recepción se lo da en persona); el socio lo puede cambiar.
function resetPin(member_no) {
  const pin = String(100000 + crypto.randomInt(900000));
  setPin(member_no, pin);
  return pin;
}

// ------------------------------------------------------------ tramos libres e inicios válidos
function dayBookings(date) {
  return bdb.prepare(`SELECT * FROM bookings WHERE date = ? AND status = 'active' ORDER BY start_min`).all(date);
}
function dayBlocks(date) {
  return bdb.prepare(`SELECT * FROM court_blocks WHERE date_from <= ? AND date_to >= ? ORDER BY start_min`).all(date, date);
}
// Tramos libres de una pista y día: [apertura, cierre] menos reservas y bloqueos.
function freeSegments(court_id, date, { ignoreBookings = false } = {}) {
  const c = getConfig();
  let segs = [{ start: c.open_min, end: c.close_min }];
  const occ = [];
  if (!ignoreBookings) {
    for (const b of dayBookings(date)) if (b.court_id === court_id) occ.push([b.start_min, b.end_min]);
  }
  for (const b of dayBlocks(date)) if (b.court_id === court_id) occ.push([b.start_min, b.end_min]);
  occ.sort((x, y) => x[0] - y[0]);
  for (const [s, e] of occ) {
    const next = [];
    for (const g of segs) {
      if (e <= g.start || s >= g.end) { next.push(g); continue; }
      if (s > g.start) next.push({ start: g.start, end: s });
      if (e < g.end) next.push({ start: e, end: g.end });
    }
    segs = next;
  }
  if (date === todayStr()) {
    const n = nowMin();
    segs = segs.map(g => ({ start: Math.max(g.start, n), end: g.end })).filter(g => g.end > g.start);
  }
  return segs;
}
// Desplazamientos alcanzables desde el inicio de un tramo sumando duraciones.
function reachableSet(durations, maxLen) {
  const reach = new Set([0]);
  for (let o = 0; o <= maxLen; o++) {
    if (!reach.has(o)) continue;
    for (const d of durations) if (o + d <= maxLen) reach.add(o + d);
  }
  return reach;
}
// Inicios válidos dentro de un tramo libre: [{ start_min, durations: [d...] }].
function validStarts(segStart, segEnd, durations = null) {
  const ds = durations || getConfig().durations;
  const len = segEnd - segStart;
  if (len < Math.min(...ds)) return [];
  const reach = reachableSet(ds, len);
  const out = [];
  for (let o = 0; o < len; o++) {
    if (!reach.has(o)) continue;
    const s = segStart + o;
    const fits = ds.filter(d => s + d <= segEnd);
    if (fits.length) out.push({ start_min: s, durations: fits });
  }
  return out;
}
// ¿Se puede reservar (start, duration) ahora mismo? (para validar y para la espera)
function isBookable(court_id, date, start_min, duration_min) {
  const c = getConfig();
  const d = parseInt(duration_min, 10);
  if (!c.durations.includes(d)) return false;
  const today = todayStr();
  if (date < today || date > addDays(today, c.days_ahead)) return false;
  if (date === today && start_min <= nowMin()) return false;
  const end_min = start_min + d;
  return freeSegments(court_id, date).some(g =>
    start_min >= g.start && end_min <= g.end &&
    validStarts(g.start, g.end).some(v => v.start_min === start_min && v.durations.includes(d)));
}
// ¿Podría reservarse si no hubiera reservas? (para apuntarse a la lista de espera)
function isPotentiallyValid(court_id, date, start_min, duration_min) {
  const c = getConfig();
  const d = parseInt(duration_min, 10);
  if (!c.durations.includes(d)) return false;
  const today = todayStr();
  if (date < today || date > addDays(today, c.days_ahead)) return false;
  if (date === today && start_min <= nowMin()) return false;
  const end_min = start_min + d;
  return freeSegments(court_id, date, { ignoreBookings: true }).some(g =>
    start_min >= g.start && end_min <= g.end &&
    validStarts(g.start, g.end).some(v => v.start_min === start_min && v.durations.includes(d)));
}

// Parrilla de un día: por pista, segmentos libres/ocupados/bloqueados/pasados.
function gridFor(date, courts) {
  const bookings = dayBookings(date);
  const blocks = dayBlocks(date);
  const isToday = date === todayStr();
  const now = nowMin();
  const out = [];
  for (const court of courts) {
    const occ = [];
    for (const b of bookings) if (b.court_id === court.id) occ.push({ s: b.start_min, e: b.end_min, kind: 'booked', ref: b });
    for (const b of blocks) if (b.court_id === court.id) occ.push({ s: b.start_min, e: b.end_min, kind: 'blocked', ref: b });
    occ.sort((a, b) => a.s - b.s);
    const items = [];
    let cur = getConfig().open_min;
    const close = getConfig().close_min;
    for (const o of occ) {
      if (o.s > cur) items.push(mkFree(court.id, date, cur, o.s, isToday, now));
      items.push({ type: o.kind, start: o.s, end: o.e, booking: o.kind === 'booked' ? o.ref : null, block: o.kind === 'blocked' ? o.ref : null });
      cur = Math.max(cur, o.e);
    }
    if (cur < close) items.push(mkFree(court.id, date, cur, close, isToday, now));
    out.push({ court, items: items.filter(Boolean) });
  }
  return out;
}
function mkFree(court_id, date, s, e, isToday, now) {
  const start = isToday ? Math.max(s, now) : s;
  if (start >= e) return { type: 'past', start: s, end: e };
  return { type: 'free', start, end: e, starts: validStarts(start, e) };
}

// ------------------------------------------------------------ reservas
function validateNewBooking({ court_id, date, start_min, duration_min, titular_member_no, players }) {
  const c = getConfig();
  const t = (titular_member_no || '').trim();
  const member = getMember(t);
  if (!member) return 'Indica un nº de socio válido para el titular.';
  if (!member.active) return 'Ese nº de socio está desactivado.';
  const d = parseInt(duration_min, 10);
  if (!c.durations.includes(d)) return 'Duración no válida.';
  if (!Number.isInteger(start_min)) return 'Hora de inicio no válida.';
  const end_min = start_min + d;
  if (start_min < c.open_min || end_min > c.close_min) return 'La reserva se sale del horario del club.';
  const today = todayStr();
  const maxDate = addDays(today, c.days_ahead);
  if (date < today || date > maxDate) return 'Fecha fuera del periodo de reserva.';
  if (date === today && start_min <= nowMin()) return 'Esa hora ya ha pasado.';
  if (!isBookable(court_id, date, start_min, d))
    return 'Esa hora ya no está disponible (otro socio se ha adelantado o no encaja sin dejar huecos).';
  const mine = bdb.prepare(
    `SELECT id FROM bookings WHERE date = ? AND titular_member_no = ? AND status = 'active'
     AND start_min < ? AND ? < end_min LIMIT 1`).get(date, t, end_min, start_min);
  if (mine) return 'Ya tienes otra reserva en ese tramo horario.';
  return null;
}

// Normaliza jugadores: el titular es el jugador 1; hasta 3 acompañantes
// opcionales. Acompañante con nombre pero sin nº de socio válido = invitado.
function normalizePlayers(titular, extras) {
  const rows = [{ name: titular.name, member_no: titular.member_no, is_guest: 0 }];
  for (const p of (extras || []).slice(0, 3)) {
    const name = (p.name || '').trim();
    if (!name) continue;
    const mno = (p.member_no || '').trim();
    const m = mno ? getMember(mno) : null;
    rows.push({ name, member_no: mno, is_guest: (m && m.active) ? 0 : 1 });
  }
  return rows;
}
function recomputePayment(booking_id) {
  const guests = bdb.prepare(
    'SELECT 1 FROM booking_players WHERE booking_id = ? AND is_guest = 1 LIMIT 1').get(booking_id);
  bdb.prepare('UPDATE bookings SET payment_status = ? WHERE id = ?')
    .run(guests ? 'pending' : 'ok', booking_id);
  return guests ? 'pending' : 'ok';
}
// Sustituye los jugadores de una reserva (titular primero) y recalcula el pago.
function setPlayers(booking_id, titular_member_no, extras) {
  const titular = getMember(titular_member_no);
  if (!titular) return { error: 'Titular no válido.' };
  const rows = normalizePlayers(titular, extras);
  bdb.prepare('DELETE FROM booking_players WHERE booking_id = ?').run(booking_id);
  const ins = bdb.prepare('INSERT INTO booking_players(booking_id, name, member_no, is_guest) VALUES(?, ?, ?, ?)');
  for (const p of rows) ins.run(booking_id, p.name, p.member_no, p.is_guest);
  const payment_status = recomputePayment(booking_id);
  return { ok: true, payment_status, count: rows.length };
}

function createBooking({ court_id, court_name, date, start_min, duration_min, titular_member_no, players, open_spots = 0 }) {
  const err = validateNewBooking({ court_id, date, start_min, duration_min, titular_member_no, players });
  if (err) return { error: err };
  const d = parseInt(duration_min, 10);
  const end_min = start_min + d;
  const t = titular_member_no.trim();
  const member = getMember(t);
  const spots = Math.max(0, Math.min(3, open_spots | 0));
  const r = bdb.prepare(
    `INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name, payment_status, open_spots)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'ok', ?)`).run(
    court_id, court_name, date, start_min, end_min, t, member.name, spots);
  const id = Number(r.lastInsertRowid);
  setPlayers(id, t, players);
  const st = bdb.prepare('SELECT payment_status FROM bookings WHERE id = ?').get(id).payment_status;
  // Si había oferta de lista de espera para este socio en este inicio, se consume.
  bdb.prepare(`UPDATE waitlist SET status = 'done' WHERE member_no = ? AND date = ? AND court_id = ?
    AND start_min = ? AND status IN ('waiting', 'offered')`).run(t, date, court_id, start_min);
  return { id, payment_status: st };
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
  promoteWaitlist(b.court_id, b.date);
  return { ok: true };
}

// ------------------------------------------------------------ partidos abiertos
// Buscador de socios por nombre, nº de socio o móvil (para el formulario).
function searchMembers(q) {
  q = (q || '').trim();
  if (q.length < 2) return [];
  const like = '%' + q.replace(/[%_]/g, '') + '%';
  return bdb.prepare(
    `SELECT member_no, name, phone, level FROM club_members
     WHERE active = 1 AND (name LIKE ? OR member_no LIKE ? OR phone LIKE ?)
     ORDER BY name LIMIT 10`).all(like, like, like);
}
function validLevel(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 1 || n > 7) return undefined;
  return Math.round(n * 4) / 4;
}
function setLevel(member_no, level) {
  const v = validLevel(level);
  if (v === undefined) return { error: 'Nivel no válido (1.0 – 7.0).' };
  bdb.prepare('UPDATE club_members SET level = ? WHERE member_no = ?').run(v, member_no);
  return { ok: true, level: v };
}
const fmtLevel = n => String(Math.round(n * 100) / 100);
// Rango visible del partido abierto: nivel del titular ±1.
function levelRangeText(level) {
  if (level === null || level === undefined) return null;
  return fmtLevel(level - 1) + '–' + fmtLevel(level + 1);
}
// Bloqueos entre jugadores: blocker no quiere que blocked vea sus abiertos.
function addBlock(blocker, blocked) {
  if (blocker === blocked) return { error: 'No puedes bloquearte a ti mismo.' };
  if (!getMember(blocked)) return { error: 'Socio no encontrado.' };
  bdb.prepare('INSERT OR IGNORE INTO member_blocks(blocker_member_no, blocked_member_no) VALUES(?, ?)').run(blocker, blocked);
  return { ok: true };
}
function removeBlock(blocker, blocked) {
  bdb.prepare('DELETE FROM member_blocks WHERE blocker_member_no = ? AND blocked_member_no = ?').run(blocker, blocked);
  return { ok: true };
}
function getBlocks(blocker) {
  return bdb.prepare(
    `SELECT m.member_no, m.name FROM member_blocks b
     JOIN club_members m ON m.member_no = b.blocked_member_no
     WHERE b.blocker_member_no = ? ORDER BY m.name`).all(blocker);
}
function isBlockedBy(bookerNo, viewerNo) {
  if (!viewerNo) return false;
  return !!bdb.prepare(
    'SELECT 1 FROM member_blocks WHERE blocker_member_no = ? AND blocked_member_no = ?').get(bookerNo, viewerNo);
}
// ¿Puede viewer ver el partido abierto del titular? viewer = null → público:
// siempre visible (decisión de Mathius); el login solo se exige para apuntarse.
function openVisibleTo(bookerNo, bookerLevel, viewer) {
  if (!viewer) return true;
  if (isBlockedBy(bookerNo, viewer.member_no)) return false;
  if (viewer.level === null || viewer.level === undefined) return true;
  if (bookerLevel === null || bookerLevel === undefined) return true;
  return Math.abs(bookerLevel - viewer.level) <= 1;
}
// Apuntarse a un partido abierto.
function joinOpenMatch(booking_id, member) {
  const b = bdb.prepare('SELECT * FROM bookings WHERE id = ?').get(booking_id);
  if (!b || b.status !== 'active') return { error: 'Ese partido ya no está disponible.' };
  if (!(b.open_spots > 0)) return { error: 'Ese partido ya está cerrado.' };
  if (b.titular_member_no === member.member_no) return { error: 'Es tu propio partido.' };
  const booker = getMember(b.titular_member_no);
  if (!openVisibleTo(b.titular_member_no, booker && booker.level, member))
    return { error: 'No puedes ver este partido.' };
  const already = bdb.prepare(
    `SELECT 1 FROM booking_players WHERE booking_id = ?
     AND (member_no = ? OR lower(name) = lower(?)) LIMIT 1`).get(booking_id, member.member_no, member.name);
  if (already) return { error: 'Ya estás apuntado en este partido.' };
  const d = b.end_min - b.start_min;
  const clash = bdb.prepare(
    `SELECT 1 FROM bookings bk JOIN booking_players p ON p.booking_id = bk.id
     WHERE bk.date = ? AND bk.status = 'active' AND p.member_no = ?
     AND bk.start_min < ? AND ? < bk.end_min LIMIT 1`).get(b.date, member.member_no, b.end_min, b.start_min);
  if (clash) return { error: 'Tienes otra reserva en ese tramo horario.' };
  bdb.prepare('INSERT INTO booking_players(booking_id, name, member_no, is_guest) VALUES(?, ?, ?, 0)')
    .run(booking_id, member.name, member.member_no);
  bdb.prepare('UPDATE bookings SET open_spots = open_spots - 1 WHERE id = ?').run(booking_id);
  recomputePayment(booking_id);
  return { ok: true };
}
// Tras editar jugadores: si era abierto, las plazas se reajustan solas.
function syncOpenSpots(booking_id) {
  const b = bdb.prepare('SELECT open_spots FROM bookings WHERE id = ?').get(booking_id);
  if (!b || !(b.open_spots > 0)) return;
  const total = bdb.prepare('SELECT COUNT(*) c FROM booking_players WHERE booking_id = ?').get(booking_id).c;
  const spots = Math.max(0, 4 - total); // titular + acompañantes con nombre
  bdb.prepare('UPDATE bookings SET open_spots = ? WHERE id = ?').run(spots, booking_id);
}
function closeOpenMatch(booking_id) {
  bdb.prepare('UPDATE bookings SET open_spots = 0 WHERE id = ?').run(booking_id);
  return { ok: true };
}
// Franja de la parrilla = la duración más larga del ajuste (ej. 75 con 60,75).
function slotInterval() { return Math.max(...getConfig().durations); }
// Inicios de franja del día: open, open+franja, ... mientras quepa la duración mínima.
function slotStarts(date) {
  const c = getConfig();
  const step = slotInterval(), minD = Math.min(...c.durations);
  const out = [];
  for (let s = c.open_min; s + minD <= c.close_min; s += step) out.push(s);
  return out;
}
// Primera duración (de mayor a menor) que encaja en ese inicio, o null.
function fitDuration(court_id, date, start_min) {
  const ds = [...getConfig().durations].sort((a, b) => b - a);
  return ds.find(d => isBookable(court_id, date, start_min, d)) || null;
}
// ¿Qué hay en una pista a una hora de franja? → past / busy / open / free(duration) / unavailable
function slotCell(court_id, date, slot, viewer) {
  if (date === todayStr() && slot <= nowMin()) return { st: 'past' };
  const b = bdb.prepare(
    `SELECT bk.*, m.level AS booker_level FROM bookings bk
     LEFT JOIN club_members m ON m.member_no = bk.titular_member_no
     WHERE bk.date = ? AND bk.court_id = ? AND bk.status = 'active'
       AND bk.start_min <= ? AND ? < bk.end_min LIMIT 1`).get(date, court_id, slot, slot);
  if (b) {
    if (b.open_spots > 0 && openVisibleTo(b.titular_member_no, b.booker_level, viewer))
      return { st: 'open', booking: b, range: levelRangeText(b.booker_level) };
    return { st: 'busy' };
  }
  const bl = bdb.prepare(
    `SELECT 1 FROM court_blocks WHERE court_id = ? AND ? BETWEEN date_from AND date_to
     AND start_min <= ? AND ? < end_min LIMIT 1`).get(court_id, date, slot, slot);
  if (bl) return { st: 'busy' };
  const d = fitDuration(court_id, date, slot);
  return d ? { st: 'free', duration: d } : { st: 'unavailable' };
}
// Parrilla por franjas: [{ slot, cells: [{ court, cell }] }]
function slotDay(date, viewer, courts) {
  return slotStarts(date).map(slot => ({
    slot,
    cells: courts.map(court => ({ court, cell: slotCell(court.id, date, slot, viewer) })),
  }));
}

// ------------------------------------------------------------ lista de espera
function expireOffers() {
  const c = getConfig();
  bdb.prepare(
    `UPDATE waitlist SET status = 'expired' WHERE status = 'offered'
     AND datetime(offered_at, '+' || ? || ' minutes') < datetime('now')`).run(c.hold_min);
}
// Al liberarse algo en una pista/día: ofrece a cada socio en espera cuya
// hora+duración deseada vuelva a estar reservable (por orden de llegada).
function promoteWaitlist(court_id, date) {
  expireOffers();
  const c = getConfig();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const waiting = bdb.prepare(
    `SELECT * FROM waitlist WHERE court_id = ? AND date = ? AND status = 'waiting'
     ORDER BY created_at`).all(court_id, date);
  for (const w of waiting) {
    if (!isBookable(w.court_id, w.date, w.start_min, w.duration_min)) continue;
    bdb.prepare("UPDATE waitlist SET status = 'offered', offered_at = ? WHERE id = ?").run(now, w.id);
  }
}

function joinWaitlist({ court_id, court_name, date, start_min, duration_min, member_no }) {
  expireOffers();
  const t = (member_no || '').trim();
  const member = getMember(t);
  if (!member) return { error: 'Indica un nº de socio válido.' };
  if (!member.active) return { error: 'Ese nº de socio está desactivado.' };
  const d = parseInt(duration_min, 10);
  if (!getConfig().durations.includes(d)) return { error: 'Duración no válida.' };
  if (!Number.isInteger(start_min)) return { error: 'Hora no válida.' };
  if (!isPotentiallyValid(court_id, date, start_min, d))
    return { error: 'Esa hora no es reservable (no encaja sin dejar huecos o está bloqueada).' };
  const dup = bdb.prepare(
    `SELECT 1 FROM waitlist WHERE court_id = ? AND date = ? AND start_min = ? AND duration_min = ? AND member_no = ?
     AND status IN ('waiting', 'offered') LIMIT 1`).get(court_id, date, start_min, d, t);
  if (dup) return { error: 'Ya estás en la lista de espera de esa hora.' };
  if (isBookable(court_id, date, start_min, d))
    return { error: 'Esa hora está libre: resérvala directamente.' };
  bdb.prepare(
    `INSERT INTO waitlist(court_id, court_name, date, start_min, end_min, duration_min, member_no, name, phone)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(court_id, court_name, date, start_min, start_min + d, d, t, member.name, member.phone || '');
  return { ok: true };
}

function confirmOffer(waitlistId, member_no) {
  expireOffers();
  const w = bdb.prepare('SELECT * FROM waitlist WHERE id = ?').get(waitlistId);
  if (!w || w.status !== 'offered') return { error: 'La oferta ya no está disponible.' };
  if (w.member_no !== (member_no || '').trim()) return { error: 'Esa oferta no es para este socio.' };
  const member = getMember(w.member_no);
  const err = validateNewBooking({
    court_id: w.court_id, date: w.date, start_min: w.start_min, duration_min: w.duration_min,
    titular_member_no: w.member_no, players: [],
  });
  if (err) {
    bdb.prepare("UPDATE waitlist SET status = 'expired' WHERE id = ?").run(w.id);
    return { error: 'La hora ya no está libre.' };
  }
  return { offer: { ...w, titular_name: member.name } };
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

// ------------------------------------------------------------ bloqueos (por rango de fechas)
function validateBlock({ court_id, date_from, date_to, start_min, end_min }) {
  const c = getConfig();
  if (!Number.isInteger(start_min) || !Number.isInteger(end_min) || start_min >= end_min)
    return 'Tramo no válido.';
  if (start_min < c.open_min || end_min > c.close_min) return 'El bloqueo se sale del horario del club.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date_from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date_to || ''))
    return 'Fechas no válidas.';
  if (date_from > date_to) return 'La fecha de inicio debe ser anterior o igual a la de fin.';
  const today = todayStr();
  const maxDate = addDays(today, c.days_ahead);
  if (date_to < today || date_from > maxDate) return 'Fechas fuera del periodo de reserva.';
  const clash = bdb.prepare(
    `SELECT 1 FROM court_blocks WHERE court_id = ?
     AND date_from <= ? AND date_to >= ?
     AND start_min < ? AND ? < end_min LIMIT 1`)
    .get(court_id, date_to, date_from, end_min, start_min);
  if (clash) return 'Ya hay un bloqueo en ese tramo.';
  return null;
}
function affectedBookings(court_id, date_from, date_to, start_min, end_min) {
  return bdb.prepare(
    `SELECT * FROM bookings WHERE court_id = ? AND status = 'active'
     AND date >= ? AND date <= ? AND start_min < ? AND ? < end_min
     ORDER BY date, start_min`).all(court_id, date_from, date_to, end_min, start_min);
}
function createBlock({ court_id, court_name, date_from, date_to, start_min, end_min, reason, notes, force }) {
  const err = validateBlock({ court_id, date_from, date_to, start_min, end_min });
  if (err) return { error: err };
  const affected = affectedBookings(court_id, date_from, date_to, start_min, end_min);
  if (affected.length && !force) return { conflict: affected };
  for (const b of affected) {
    bdb.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
  }
  // La lista de espera se reevalúa por día afectado.
  const days = new Set(affected.map(b => b.date));
  for (const d of days) promoteWaitlist(court_id, d);
  const r = bdb.prepare(
    `INSERT INTO court_blocks(court_id, court_name, date, date_from, date_to, start_min, end_min, reason, notes)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(court_id, court_name, date_from, date_from, date_to, start_min, end_min, reason || '', notes || '');
  return { id: Number(r.lastInsertRowid), cancelled: affected.length };
}
function deleteBlock(id) {
  bdb.prepare('DELETE FROM court_blocks WHERE id = ?').run(id);
}
function listBlocks(fromDate) {
  return bdb.prepare('SELECT * FROM court_blocks WHERE date_to >= ? ORDER BY date_from, start_min').all(fromDate || todayStr());
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
  bdb, cfg, setCfg, getConfig, validateConfig, parseDurations,
  minToStr, strToMin, todayStr, addDays, nowMin, overlaps, normPhone,
  getMember, listMembers, upsertMember, setMemberActive, updateMemberContact, importMembers,
  validPin, setPin, hasPin, checkPin, resetPin,
  dayBookings, dayBlocks, freeSegments, reachableSet, validStarts,
  isBookable, isPotentiallyValid, gridFor,
  validateNewBooking, normalizePlayers, setPlayers, recomputePayment,
  createBooking, getBooking, cancelBooking,
  searchMembers, validLevel, setLevel, fmtLevel, levelRangeText,
  addBlock, removeBlock, getBlocks, isBlockedBy, openVisibleTo,
  joinOpenMatch, syncOpenSpots, closeOpenMatch,
  slotInterval, slotStarts, slotCell, slotDay, fitDuration,
  expireOffers, promoteWaitlist, joinWaitlist, confirmOffer, leaveWaitlist, memberArea,
  validateBlock, affectedBookings, createBlock, deleteBlock, listBlocks,
  setBookingPaid, addCharge, setChargePaid, deleteCharge, dayDetail, pendingPayments,
  dueReminders, checkReminders, sendEmail,
};
