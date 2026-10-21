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
try {
  edb.exec(`ALTER TABLE events ADD COLUMN status TEXT NOT NULL DEFAULT 'abierta'`);
  // Los que tenían la inscripción cerrada pasan al estado equivalente
  edb.exec(`UPDATE events SET status = 'cerrada' WHERE inscriptions_open = 0`);
} catch (e) { /* ya existe */ }
try { edb.exec(`ALTER TABLE events ADD COLUMN poster TEXT NOT NULL DEFAULT ''`); } catch (e) { /* ya existe */ }
// Doble precio: price_cents = socios; price_nonmember_cents NULL = mismo precio para todos
try { edb.exec(`ALTER TABLE events ADD COLUMN price_nonmember_cents INTEGER`); } catch (e) { /* ya existe */ }
// Precio congelado por inscrito (el que le tocaba al inscribirse) + si era socio
try { edb.exec(`ALTER TABLE event_inscriptions ADD COLUMN price_cents INTEGER`); } catch (e) { /* ya existe */ }
try { edb.exec(`ALTER TABLE event_inscriptions ADD COLUMN is_member INTEGER`); } catch (e) { /* ya existe */ }
// Slugs antiguos: al renombrar un evento, el enlace viejo redirige al nuevo
edb.exec(`
CREATE TABLE IF NOT EXISTS event_slug_redirects(
  old_slug TEXT PRIMARY KEY,
  event_id INTEGER NOT NULL
);
`);

const FORMATS = { americana: 'Americana', quedada: 'Quedada', torneo: 'Torneo' };
function formatName(f) { return FORMATS[f] || f; }
const MODES = { individual: 'Individual', pairs: 'Parejas', mixed: 'Mixto (individual o parejas)' };
function modeName(m) { return MODES[m] || MODES.individual; }
function validMode(m) { return MODES[m] ? m : 'individual'; }
// Estados visibles para el admin: abierta, en_juego, cerrada, finalizada, oculta
const STATUSES = {
  abierta: 'Inscripción abierta',
  en_juego: 'En juego',
  cerrada: 'Inscripción cerrada',
  finalizada: 'Finalizado',
  oculta: 'No visible',
};
function statusName(s) { return STATUSES[s] || STATUSES.abierta; }
function validStatus(s) { return STATUSES[s] ? s : 'abierta'; }

function slugify(name) {
  let s = (name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  if (!s) s = 'evento';
  let slug = s, i = 2;
  while (edb.prepare('SELECT 1 FROM events WHERE slug = ?').get(slug)) slug = s + '-' + (i++);
  return slug;
}
// Normaliza un slug escrito a mano por el admin (minúsculas, sin acentos, guiones)
function normalizeSlug(raw) {
  return (raw || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
// Valida un slug para un evento (excludeId = el propio evento al editar).
// Devuelve mensaje de error o null si vale.
function validateSlug(raw, excludeId = null) {
  const s = normalizeSlug(raw);
  if (s.length < 3) return 'La dirección (slug) debe tener al menos 3 caracteres: letras, números y guiones.';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)) return 'La dirección (slug) solo puede llevar letras, números y guiones.';
  const other = edb.prepare('SELECT id FROM events WHERE slug = ?').get(s);
  if (other && Number(other.id) !== Number(excludeId)) return 'Esa dirección ya la usa otro evento.';
  const red = edb.prepare('SELECT event_id FROM event_slug_redirects WHERE old_slug = ?').get(s);
  if (red && Number(red.event_id) !== Number(excludeId)) return 'Esa dirección fue de otro evento y redirige a él; elige otra.';
  return null;
}
// Resuelve un slug antiguo → evento actual (para redirigir enlaces ya compartidos)
function eventForOldSlug(oldSlug) {
  const r = edb.prepare('SELECT event_id FROM event_slug_redirects WHERE old_slug = ?').get(oldSlug || '');
  return r ? getEventById(r.event_id) : null;
}

function listEvents() {
  return edb.prepare('SELECT * FROM events ORDER BY event_date DESC, id DESC').all();
}
// Eventos visibles en la web pública (los ocultos no salen)
function publicEvents() {
  const upcoming = edb.prepare(`SELECT * FROM events
    WHERE status IN ('abierta', 'en_juego', 'cerrada') ORDER BY event_date ASC, id ASC`).all();
  const past = edb.prepare(`SELECT * FROM events
    WHERE status = 'finalizada' ORDER BY event_date DESC, id DESC LIMIT 12`).all();
  return { upcoming, past };
}
function getEvent(slug) {
  return edb.prepare('SELECT * FROM events WHERE slug = ?').get(slug) || null;
}
function getEventById(id) {
  return edb.prepare('SELECT * FROM events WHERE id = ?').get(id) || null;
}
// --- Precios socios / no socios ---
// price_cents = precio de socio. price_nonmember_cents NULL = precio único.
function hasDualPrice(ev) {
  return ev && ev.price_nonmember_cents != null && Number(ev.price_nonmember_cents) !== Number(ev.price_cents);
}
// Socio = nº de socio real del directorio; NV-* = ficha sin nº (no socio)
function isMemberNo(memberNo) {
  const no = String(memberNo || '').trim();
  return !!no && !no.startsWith('NV-');
}
// Precio que toca a una persona según sea socia o no
function priceFor(ev, memberNo) {
  const member = isMemberNo(memberNo);
  const cents = (!member && hasDualPrice(ev)) ? Number(ev.price_nonmember_cents) : Number(ev.price_cents || 0);
  return { cents, is_member: member ? 1 : 0 };
}
// Precio a mostrar de un inscrito: el congelado al inscribirse; si es antiguo (NULL), se calcula
function inscPrice(ev, r) {
  if (r && r.price_cents != null) return { cents: Number(r.price_cents), is_member: r.is_member == null ? (isMemberNo(r.member_no) ? 1 : 0) : Number(r.is_member) };
  return priceFor(ev, r && r.member_no);
}
// Texto de precios para la web: "10,00 €" o "Socios 10,00 € · No socios 15,00 €"
function priceLabel(ev) {
  if (!ev) return '';
  if (hasDualPrice(ev)) return `Socios ${eur(ev.price_cents)} · No socios ${eur(ev.price_nonmember_cents)}`;
  return Number(ev.price_cents || 0) > 0 ? eur(ev.price_cents) : 'Gratis';
}

function createEvent({ name, description, event_date, event_time, format, price_cents, price_nonmember_cents, max_players, mode, status, slug }) {
  let finalSlug = slug ? normalizeSlug(slug) : '';
  if (!finalSlug) finalSlug = slugify(name);
  const r = edb.prepare(`INSERT INTO events(slug, name, description, event_date, event_time, format, price_cents, price_nonmember_cents, max_players, inscription_mode, status)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(finalSlug, (name || '').trim(), (description || '').trim(), event_date, (event_time || '').trim(),
      FORMATS[format] ? format : 'americana', Math.max(0, parseInt(price_cents, 10) || 0),
      price_nonmember_cents == null || price_nonmember_cents === '' ? null : Math.max(0, parseInt(price_nonmember_cents, 10) || 0),
      Math.max(0, parseInt(max_players, 10) || 0),
      validMode(mode), validStatus(status));
  return getEventById(Number(r.lastInsertRowid));
}
function updateEvent(id, fields) {
  const e = getEventById(id);
  if (!e) return null;
  // Slug: si cambia, el antiguo queda como redirección al nuevo
  let newSlug = e.slug;
  if (fields.slug != null && String(fields.slug).trim() !== '') {
    const cand = normalizeSlug(fields.slug);
    if (cand && cand !== e.slug) {
      edb.prepare('INSERT OR REPLACE INTO event_slug_redirects(old_slug, event_id) VALUES(?, ?)').run(e.slug, id);
      edb.prepare('DELETE FROM event_slug_redirects WHERE old_slug = ?').run(cand); // renombrar "hacia atrás"
      newSlug = cand;
    }
  }
  const nm = fields.price_nonmember_cents;
  edb.prepare(`UPDATE events SET slug = ?, name = ?, description = ?, event_date = ?, event_time = ?,
    format = ?, price_cents = ?, price_nonmember_cents = ?, max_players = ?, inscription_mode = ?, status = ? WHERE id = ?`)
    .run(newSlug, (fields.name || e.name).trim(), (fields.description || '').trim(), fields.event_date || e.event_date,
      (fields.event_time || '').trim(), FORMATS[fields.format] ? fields.format : e.format,
      Math.max(0, parseInt(fields.price_cents, 10) || 0),
      nm === undefined ? e.price_nonmember_cents : (nm === null || nm === '' ? null : Math.max(0, parseInt(nm, 10) || 0)),
      Math.max(0, parseInt(fields.max_players, 10) || 0),
      validMode(fields.mode || e.inscription_mode), validStatus(fields.status || e.status), id);
  return getEventById(id);
}
function setStatus(id, status) {
  edb.prepare('UPDATE events SET status = ? WHERE id = ?').run(validStatus(status), id);
}
function deleteEvent(id) {
  try { require('./upload').removePoster(id); } catch (e) { /* sin cartel */ }
  edb.prepare('DELETE FROM event_slug_redirects WHERE event_id = ?').run(id);
  edb.prepare('DELETE FROM event_inscriptions WHERE event_id = ?').run(id);
  edb.prepare('DELETE FROM events WHERE id = ?').run(id);
}
function setPoster(id, filename) {
  edb.prepare('UPDATE events SET poster = ? WHERE id = ?').run(filename || '', id);
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
  if (ev.status !== 'abierta') return { error: 'Las inscripciones no están abiertas en este momento.' };
  const left = spotsLeft(ev);
  if (left !== null && left <= 0) return { error: 'Ya no quedan plazas.' };
  const no = B.upsertMemberByPhone({ phone, name, member_no, email, level, gender });
  if (!no) return { error: 'El teléfono no parece un móvil válido.' };
  const pr = priceFor(ev, no);
  try {
    edb.prepare(`INSERT INTO event_inscriptions(event_id, member_no, name, phone, level, price_cents, is_member)
                 VALUES(?, ?, ?, ?, ?, ?, ?)`)
      .run(eventId, no, (name || '').trim(), (phone || '').trim(), level == null || level === '' ? null : Number(level), pr.cents, pr.is_member);
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
  if (ev.status !== 'abierta') return { error: 'Las inscripciones no están abiertas en este momento.' };
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
  const pr1 = priceFor(ev, no1), pr2 = priceFor(ev, no2);
  try {
    const ins = edb.prepare(`INSERT INTO event_inscriptions(event_id, member_no, name, phone, level, pair_key, price_cents, is_member)
                             VALUES(?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run(eventId, no1, (p1.name || '').trim(), (p1.phone || '').trim(), p1.level == null || p1.level === '' ? null : Number(p1.level), key, pr1.cents, pr1.is_member);
    ins.run(eventId, no2, (p2.name || '').trim(), (p2.phone || '').trim(), p2.level == null || p2.level === '' ? null : Number(p2.level), key, pr2.cents, pr2.is_member);
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
// Corrige el tipo de un inscrito (socio ↔ no socio) y le aplica el precio actual del evento
function setInscriptionMemberType(eventId, inscId, isMember) {
  const ev = getEventById(eventId);
  const r = edb.prepare('SELECT * FROM event_inscriptions WHERE id = ? AND event_id = ?').get(inscId, eventId);
  if (!ev || !r) return false;
  const cents = isMember ? Number(ev.price_cents || 0)
    : (hasDualPrice(ev) ? Number(ev.price_nonmember_cents) : Number(ev.price_cents || 0));
  edb.prepare('UPDATE event_inscriptions SET is_member = ?, price_cents = ? WHERE id = ?')
    .run(isMember ? 1 : 0, cents, inscId);
  return true;
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
  FORMATS, formatName, MODES, modeName, validMode, STATUSES, statusName, validStatus,
  normalizeSlug, validateSlug, eventForOldSlug,
  hasDualPrice, isMemberNo, priceFor, inscPrice, priceLabel,
  listEvents, publicEvents, getEvent, getEventById,
  createEvent, updateEvent, setStatus, deleteEvent, setPoster, countInscriptions, spotsLeft,
  inscribe, inscribePair, listInscriptions, inscriptionsWithPairs, pairUp, unpair,
  setPaid, setInscriptionMemberType, removeInscription, eur, fmtDate,
};
