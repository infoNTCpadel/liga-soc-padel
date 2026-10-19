// Eventos del club (quedadas, americanas): landing pública + inscripciones.
// Las personas viven en el DIRECTORIO ÚNICO (club_members, vía bookings.js):
// una persona = un teléfono normalizado, sin duplicados. Este módulo solo
// crea eventos e inscripciones; nunca duplica personas.
const { metaDb } = require('../db');
const B = require('./bookings');

const edb = metaDb;
edb.exec(`
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL,
  event_time TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'americana',
  price_cents INTEGER NOT NULL DEFAULT 0,
  max_players INTEGER NOT NULL DEFAULT 0,
  inscriptions_open INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS event_inscriptions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_no TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  level REAL,
  paid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, member_no)
);
CREATE INDEX IF NOT EXISTS idx_insc_event ON event_inscriptions(event_id);
`);

const FORMATS = { americana: 'Americana', quedada: 'Quedada', torneo: 'Torneo' };
function formatName(f) { return FORMATS[f] || f; }

function slugify(name) {
  let s = (name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  if (!s) s = 'evento';
  let slug = s, i = 2;
  while (edb.prepare('SELECT 1 FROM events WHERE slug = ?').get(slug)) slug = s + '-' + (i++);
  return slug;
}

function listEvents() {
  return edb.prepare('SELECT * FROM events ORDER BY event_date DESC, id DESC').all();
}
function upcomingEvents() {
  const today = new Date().toISOString().slice(0, 10);
  return edb.prepare(`SELECT * FROM events WHERE event_date >= ? ORDER BY event_date ASC, id ASC`).all(today);
}
function getEvent(slug) {
  return edb.prepare('SELECT * FROM events WHERE slug = ?').get(slug) || null;
}
function getEventById(id) {
  return edb.prepare('SELECT * FROM events WHERE id = ?').get(id) || null;
}
function createEvent({ name, description, event_date, event_time, format, price_cents, max_players }) {
  const slug = slugify(name);
  const r = edb.prepare(`INSERT INTO events(slug, name, description, event_date, event_time, format, price_cents, max_players)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(slug, (name || '').trim(), (description || '').trim(), event_date, (event_time || '').trim(),
      FORMATS[format] ? format : 'americana', Math.max(0, parseInt(price_cents, 10) || 0), Math.max(0, parseInt(max_players, 10) || 0));
  return getEventById(Number(r.lastInsertRowid));
}
function updateEvent(id, fields) {
  const e = getEventById(id);
  if (!e) return null;
  edb.prepare(`UPDATE events SET name = ?, description = ?, event_date = ?, event_time = ?,
    format = ?, price_cents = ?, max_players = ? WHERE id = ?`)
    .run((fields.name || e.name).trim(), (fields.description || '').trim(), fields.event_date || e.event_date,
      (fields.event_time || '').trim(), FORMATS[fields.format] ? fields.format : e.format,
      Math.max(0, parseInt(fields.price_cents, 10) || 0), Math.max(0, parseInt(fields.max_players, 10) || 0), id);
  return getEventById(id);
}
function setEventOpen(id, open) {
  edb.prepare('UPDATE events SET inscriptions_open = ? WHERE id = ?').run(open ? 1 : 0, id);
}
function deleteEvent(id) {
  edb.prepare('DELETE FROM event_inscriptions WHERE event_id = ?').run(id);
  edb.prepare('DELETE FROM events WHERE id = ?').run(id);
}
function countInscriptions(eventId) {
  return edb.prepare('SELECT COUNT(*) c FROM event_inscriptions WHERE event_id = ?').get(eventId).c;
}
function spotsLeft(ev) {
  if (!ev.max_players) return null;
  return Math.max(0, ev.max_players - countInscriptions(ev.id));
}
// Inscribe a una persona en un evento. Crea/actualiza su ficha en el directorio
// único (sin duplicar por teléfono). Devuelve {member_no} o {error}.
function inscribe(eventId, { phone, name, member_no, email, level, gender }) {
  const ev = getEventById(eventId);
  if (!ev) return { error: 'Evento no encontrado.' };
  if (!ev.inscriptions_open) return { error: 'Las inscripciones están cerradas.' };
  const left = spotsLeft(ev);
  if (left !== null && left <= 0) return { error: 'Ya no quedan plazas.' };
  const no = B.upsertMemberByPhone({ phone, name, member_no, email, level, gender });
  if (!no) return { error: 'El teléfono no parece un móvil válido.' };
  try {
    edb.prepare(`INSERT INTO event_inscriptions(event_id, member_no, name, phone, level)
                 VALUES(?, ?, ?, ?, ?)`)
      .run(eventId, no, (name || '').trim(), (phone || '').trim(), level == null || level === '' ? null : Number(level));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return { error: 'Este teléfono ya está inscrito en el evento.', member_no: no };
    throw e;
  }
  return { member_no: no };
}
function listInscriptions(eventId) {
  const rows = edb.prepare('SELECT * FROM event_inscriptions WHERE event_id = ? ORDER BY created_at, id').all(eventId);
  const members = {};
  for (const r of rows) {
    if (!members[r.member_no]) members[r.member_no] = B.getMember(r.member_no);
  }
  return rows.map(r => ({ ...r, member: members[r.member_no] || null }));
}
function setPaid(inscId, paid) {
  edb.prepare('UPDATE event_inscriptions SET paid = ? WHERE id = ?').run(paid ? 1 : 0, inscId);
}
function removeInscription(inscId) {
  edb.prepare('DELETE FROM event_inscriptions WHERE id = ?').run(inscId);
}
function eur(cents) { return (Number(cents || 0) / 100).toFixed(2).replace('.', ',') + ' €'; }
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}/${y}`;
}

module.exports = {
  FORMATS, formatName, listEvents, upcomingEvents, getEvent, getEventById,
  createEvent, updateEvent, setEventOpen, deleteEvent, countInscriptions, spotsLeft,
  inscribe, listInscriptions, setPaid, removeInscription, eur, fmtDate,
};
