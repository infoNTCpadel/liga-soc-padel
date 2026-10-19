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
  inscription_mode TEXT NOT NULL DEFAULT 'individual',
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
  pair_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, member_no)
);
CREATE INDEX IF NOT EXISTS idx_insc_event ON event_inscriptions(event_id);
`);
try { edb.exec(`ALTER TABLE events ADD COLUMN inscription_mode TEXT NOT NULL DEFAULT 'individual'`); } catch (e) { /* ya existe */ }
try { edb.exec(`ALTER TABLE event_inscriptions ADD COLUMN pair_key TEXT NOT NULL DEFAULT ''`); } catch (e) { /* ya existe */ }

const FORMATS = { americana: 'Americana', quedada: 'Quedada', torneo: 'Torneo' };
function formatName(f) { return FORMATS[f] || f; }
const MODES = { individual: 'Individual', pairs: 'Parejas', mixed: 'Mixto (individual o parejas)' };
function modeName(m) { return MODES[m] || MODES.individual; }
function validMode(m) { return MODES[m] ? m : 'individual'; }

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
function createEvent({ name, description, event_date, event_time, format, price_cents, max_players, mode }) {
  const slug = slugify(name);
  const r = edb.prepare(`INSERT INTO events(slug, name, description, event_date, event_time, format, price_cents, max_players, inscription_mode)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(slug, (name || '').trim(), (description || '').trim(), event_date, (event_time || '').trim(),
      FORMATS[format] ? format : 'americana', Math.max(0, parseInt(price_cents, 10) || 0), Math.max(0, parseInt(max_players, 10) || 0),
      validMode(mode));
  return getEventById(Number(r.lastInsertRowid));
}
function updateEvent(id, fields) {
  const e = getEventById(id);
  if (!e) return null;
  edb.prepare(`UPDATE events SET name = ?, description = ?, event_date = ?, event_time = ?,
    format = ?, price_cents = ?, max_players = ?, inscription_mode = ? WHERE id = ?`)
    .run((fields.name || e.name).trim(), (fields.description || '').trim(), fields.event_date || e.event_date,
      (fields.event_time || '').trim(), FORMATS[fields.format] ? fields.format : e.format,
      Math.max(0, parseInt(fields.price_cents, 10) || 0), Math.max(0, parseInt(fields.max_players, 10) || 0),
      validMode(fields.mode || e.inscription_mode), id);
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
// Inscripciones con su pareja resuelta (partner = la otra fila con el mismo pair_key)
function inscriptionsWithPairs(eventId) {
  const rows = listInscriptions(eventId);
  const byKey = {};
  for (const r of rows) if (r.pair_key) (byKey[r.pair_key] = byKey[r.pair_key] || []).push(r);
  return rows.map(r => ({
    ...r,
    partner: r.pair_key ? (byKey[r.pair_key] || []).find(x => x.id !== r.id) || null : null,
  }));
}
function newPairKey() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
// Inscribe una PAREJA (dos personas vinculadas). Devuelve {member_nos} o {error}.
function inscribePair(eventId, { p1, p2 }) {
  const ev = getEventById(eventId);
  if (!ev) return { error: 'Evento no encontrado.' };
  if (!['pairs', 'mixed'].includes(ev.inscription_mode)) return { error: 'Este evento no admite inscripción por parejas.' };
  if (!ev.inscriptions_open) return { error: 'Las inscripciones están cerradas.' };
  const left = spotsLeft(ev);
  if (left !== null && left < 2) return { error: left <= 0 ? 'Ya no quedan plazas.' : 'Solo queda 1 plaza libre.' };
  const pn1 = (p1.phone || '').replace(/\D/g, ''), pn2 = (p2.phone || '').replace(/\D/g, '');
  if (pn1 && pn1 === pn2) return { error: 'Los dos jugadores no pueden compartir teléfono.' };
  const no1 = B.upsertMemberByPhone({ phone: p1.phone, name: p1.name, member_no: p1.member_no, email: p1.email, level: p1.level, gender: p1.gender });
  const no2 = B.upsertMemberByPhone({ phone: p2.phone, name: p2.name, member_no: p2.member_no, email: p2.email, level: p2.level, gender: p2.gender });
  if (!no1 || !no2) return { error: 'Revisa los teléfonos de la pareja.' };
  if (no1 === no2) return { error: 'Los dos jugadores no pueden ser la misma persona.' };
  const dup = edb.prepare('SELECT COUNT(*) c FROM event_inscriptions WHERE event_id = ? AND member_no IN (?, ?)')
    .get(eventId, no1, no2).c;
  if (dup > 0) return { error: 'Uno de los dos ya está inscrito en este evento.' };
  const key = newPairKey();
  try {
    const ins = edb.prepare(`INSERT INTO event_inscriptions(event_id, member_no, name, phone, level, pair_key)
                             VALUES(?, ?, ?, ?, ?, ?)`);
    ins.run(eventId, no1, (p1.name || '').trim(), (p1.phone || '').trim(), p1.level == null || p1.level === '' ? null : Number(p1.level), key);
    ins.run(eventId, no2, (p2.name || '').trim(), (p2.phone || '').trim(), p2.level == null || p2.level === '' ? null : Number(p2.level), key);
  } catch (e) {
    edb.prepare('DELETE FROM event_inscriptions WHERE event_id = ? AND pair_key = ?').run(eventId, key);
    return { error: 'No se pudo completar la inscripción de la pareja.' };
  }
  return { member_nos: [no1, no2] };
}
// Empareja manualmente dos inscritos individuales (para americanas). Devuelve true/false.
function pairUp(eventId, inscId1, inscId2) {
  const a = edb.prepare('SELECT * FROM event_inscriptions WHERE id = ? AND event_id = ?').get(inscId1, eventId);
  const b = edb.prepare('SELECT * FROM event_inscriptions WHERE id = ? AND event_id = ?').get(inscId2, eventId);
  if (!a || !b || a.id === b.id) return false;
  if (a.pair_key || b.pair_key) return false; // ya emparejados
  if (a.member_no === b.member_no) return false;
  const key = newPairKey();
  edb.prepare('UPDATE event_inscriptions SET pair_key = ? WHERE id IN (?, ?)').run(key, a.id, b.id);
  return true;
}
function unpair(inscId) {
  const r = edb.prepare('SELECT * FROM event_inscriptions WHERE id = ?').get(inscId);
  if (!r || !r.pair_key) return false;
  edb.prepare('UPDATE event_inscriptions SET pair_key = ? WHERE pair_key = ? AND event_id = ?').run('', r.pair_key, r.event_id);
  return true;
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
  FORMATS, formatName, MODES, modeName, validMode, listEvents, upcomingEvents, getEvent, getEventById,
  createEvent, updateEvent, setEventOpen, deleteEvent, countInscriptions, spotsLeft,
  inscribe, inscribePair, listInscriptions, inscriptionsWithPairs, pairUp, unpair,
  setPaid, removeInscription, eur, fmtDate,
};
