// Equipos Federados KNB — inscripción de socios y reparto por equipos.
// Fase 1: inscripción pública + admin (reparto, equipos, ajustes) + recepción (cobros).
// Las personas viven en el DIRECTORIO ÚNICO (club_members, vía bookings.js):
// la inscripción EXIGE ser socio y que nº de socio + móvil coincidan con la
// misma ficha (misma regla que el reconocimiento de Eventos). Aquí NO se
// crea ni se actualiza ninguna ficha: sin coincidencia, error y fuera.
// Las tablas viven en `meta.db` (como eventos y reservas), no en la BD de la
// temporada: los equipos sobreviven a los cambios de temporada.
// Equipación/ropa: Fase 2 — no se recoge talla aquí; el diseño no lo impide
// (la ropa colgará de team_registrations.member_no + temporada).
const { metaDb } = require('../db');
const B = require('./bookings');
const L = require('./league');

const edb = metaDb;
edb.exec(`
CREATE TABLE IF NOT EXISTS team_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teams(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  modality TEXT NOT NULL DEFAULT 'absoluto',
  sex TEXT NOT NULL DEFAULT 'M',
  category TEXT NOT NULL DEFAULT '',
  fcp_group TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS team_captains(
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_no TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'capitan',
  PRIMARY KEY (team_id, member_no)
);
CREATE TABLE IF NOT EXISTS team_registrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season TEXT NOT NULL DEFAULT '2027',
  member_no TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  modality TEXT NOT NULL DEFAULT 'absoluto',
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  second_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  level REAL,
  licence_mode TEXT NOT NULL DEFAULT 'recepcion',
  licence_done INTEGER NOT NULL DEFAULT 0,
  fee_mode TEXT NOT NULL DEFAULT 'efectivo',
  fee_paid INTEGER NOT NULL DEFAULT 0,
  comments TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pendiente',
  assigned_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  assigned_second_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(member_no, season)
);
CREATE INDEX IF NOT EXISTS idx_teamreg_status ON team_registrations(status);
CREATE INDEX IF NOT EXISTS idx_teamreg_team ON team_registrations(assigned_team_id);
`);

// ---- ajustes de temporada ----
const DEFAULTS = {
  season: '2027',
  inscription_open: '1',
  open_date: '',
  close_date: '',
  fee_one_cents: '2500',
  fee_two_cents: '3000',
  licence_price_cents: '5600',
  pay_deadline: '2027-02-01',
};
function getSetting(key, fallback = null) {
  if (key in DEFAULTS && fallback === null) fallback = DEFAULTS[key];
  const r = edb.prepare('SELECT value FROM team_settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  edb.prepare(`INSERT INTO team_settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value == null ? '' : value));
}
function getSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = getSetting(k);
  return out;
}
function eur(cents) { return (Number(cents || 0) / 100).toFixed(2).replace('.', ',') + ' €'; }
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
// ¿Está abierta la inscripción hoy? (interruptor + ventana de fechas)
function inscriptionOpen() {
  if (getSetting('inscription_open') !== '1') return false;
  const today = new Date().toISOString().slice(0, 10);
  const open = getSetting('open_date'), close = getSetting('close_date');
  if (open && today < open) return false;
  if (close && today > close) return false;
  return true;
}

// ---- equipos ----
const MODALITIES = { absoluto: 'Absoluto', veteranos: 'Veteranos' };
function modalityName(m) { return MODALITIES[m] || m; }
const SEXES = { M: 'Masculino', F: 'Femenino' };
function sexName(s) { return SEXES[s] || s; }

function slugify(name) {
  let s = (name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  if (!s) s = 'equipo';
  let slug = s, i = 2;
  while (edb.prepare('SELECT 1 FROM teams WHERE slug = ?').get(slug)) slug = s + '-' + (i++);
  return slug;
}
function validateSlug(raw, excludeId = null) {
  const s = (raw || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (s.length < 3) return { error: 'La dirección (slug) debe tener al menos 3 caracteres: letras, números y guiones.' };
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)) return { error: 'La dirección (slug) solo puede llevar letras, números y guiones.' };
  const other = edb.prepare('SELECT id FROM teams WHERE slug = ?').get(s);
  if (other && Number(other.id) !== Number(excludeId)) return { error: 'Esa dirección ya la usa otro equipo.' };
  return { slug: s };
}
function listTeams(activeOnly = false) {
  const sql = activeOnly
    ? 'SELECT * FROM teams WHERE active = 1 ORDER BY modality, sex, name'
    : 'SELECT * FROM teams ORDER BY active DESC, modality, sex, name';
  return edb.prepare(sql).all();
}
function getTeam(id) {
  return edb.prepare('SELECT * FROM teams WHERE id = ?').get(id) || null;
}
function getTeamBySlug(slug) {
  return edb.prepare('SELECT * FROM teams WHERE slug = ?').get(slug) || null;
}
function createTeam({ name, modality, sex, category, fcp_group, slug }) {
  const s = slug ? validateSlug(slug, null) : { slug: slugify(name) };
  if (s.error) return { error: s.error };
  const r = edb.prepare(`INSERT INTO teams(name, slug, modality, sex, category, fcp_group)
    VALUES(?, ?, ?, ?, ?, ?)`).run((name || '').trim(), s.slug, modality, sex, (category || '').trim(), (fcp_group || '').trim());
  return { id: Number(r.lastInsertRowid) };
}
function updateTeam(id, { name, modality, sex, category, fcp_group, slug }) {
  const s = slug ? validateSlug(slug, id) : null;
  if (s && s.error) return { error: s.error };
  edb.prepare(`UPDATE teams SET name = ?, modality = ?, sex = ?, category = ?, fcp_group = ?
    ${s ? ', slug = ?' : ''} WHERE id = ?`)
    .run((name || '').trim(), modality, sex, (category || '').trim(), (fcp_group || '').trim(),
      ...(s ? [s.slug] : []), id);
  return { ok: true };
}
function setTeamActive(id, active) {
  edb.prepare('UPDATE teams SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}
function deleteTeam(id) {
  const refs = edb.prepare(
    'SELECT COUNT(*) c FROM team_registrations WHERE team_id = ? OR second_team_id = ? OR assigned_team_id = ? OR assigned_second_team_id = ?'
  ).get(id, id, id, id).c;
  if (refs > 0) return { error: 'El equipo tiene inscripciones asociadas: desactívalo en lugar de borrarlo.' };
  edb.prepare('DELETE FROM team_captains WHERE team_id = ?').run(id);
  edb.prepare('DELETE FROM teams WHERE id = ?').run(id);
  return { ok: true };
}
// Equipos iniciales del formulario 2026 (solo si la tabla está vacía).
(function seedTeams() {
  if (edb.prepare('SELECT COUNT(*) c FROM teams').get().c > 0) return;
  const seed = [
    ['Femenino A', 'absoluto', 'F', '3ª'], ['Femenino B', 'absoluto', 'F', '5ª'],
    ['Masculino A', 'absoluto', 'M', '2ª'], ['Masculino B', 'absoluto', 'M', '5ª'],
    ['Masculino C', 'absoluto', 'M', '7ª'], ['Masculino D', 'absoluto', 'M', '7ª'],
    ['Veteranas A', 'veteranos', 'F', '1ª'],
    ['Veteranos A', 'veteranos', 'M', '1ª'], ['Veteranos B', 'veteranos', 'M', '3ª'],
    ['Veteranos C', 'veteranos', 'M', '5ª'],
  ];
  for (const [name, modality, sex, category] of seed) {
    edb.prepare('INSERT INTO teams(name, slug, modality, sex, category) VALUES(?, ?, ?, ?, ?)')
      .run(name, slugify(name), modality, sex, category);
  }
})();

// ---- capitanes / subcapitanes ----
// Una persona puede ser capitana de varios equipos (también de 2).
function listCaptains(teamId) {
  const rows = edb.prepare(
    "SELECT member_no, role FROM team_captains WHERE team_id = ? ORDER BY role = 'subcapitan', member_no"
  ).all(teamId);
  return rows.map(r => ({ ...r, member: B.getMember(r.member_no) || null }));
}
function addCaptain(teamId, memberNo, role) {
  const m = B.getMember((memberNo || '').trim());
  if (!m) return { error: 'Ese nº de socio no existe en el directorio.' };
  if (!['capitan', 'subcapitan'].includes(role)) role = 'capitan';
  edb.prepare(`INSERT INTO team_captains(team_id, member_no, role) VALUES(?, ?, ?)
    ON CONFLICT(team_id, member_no) DO UPDATE SET role = excluded.role`)
    .run(teamId, m.member_no, role);
  return { ok: true };
}
function removeCaptain(teamId, memberNo) {
  edb.prepare('DELETE FROM team_captains WHERE team_id = ? AND member_no = ?').run(teamId, memberNo);
}

// ---- inscripciones ----
// Verificación de socio: nº de socio + móvil deben coincidir con la MISMA
// ficha del directorio (misma regla que /eventos/api/reconocer). Los nº
// NV-* (fichas sin nº real) no valen como clave.
function memberNoMatches(member, given) {
  const real = String((member && member.member_no) || '').trim();
  if (!real || real.startsWith('NV-')) return false;
  return real.toLowerCase() === String(given || '').trim().toLowerCase();
}
function verifyMember(memberNo, phone) {
  const m = B.getMemberByPhone(phone);
  if (!m || !m.active) return { error: 'No consta ningún socio con ese móvil. Revisa el móvil o contacta con recepción.' };
  if (!memberNoMatches(m, memberNo)) return { error: 'El nº de socio no coincide con ese móvil. Revisa los datos o contacta con recepción.' };
  return { member: m };
}

const LICENCE_MODES = {
  recepcion: 'En recepción, en efectivo',
  domiciliada: 'Ya la tengo domiciliada con la FCP',
  tpv: 'La tramito yo en la web de la FCP (TPV)',
};
const FEE_MODES = {
  efectivo: 'En efectivo, en recepción',
  cuota: 'Con la cuota del club',
};
const STATUSES = {
  pendiente: 'Pendiente de asignar',
  asignado: 'Asignado',
  lista_espera: 'Lista de espera',
  rechazado: 'Rechazado',
};
function statusName(s) { return STATUSES[s] || s; }
function feeDueCents(reg) {
  const s = getSettings();
  const two = reg.second_team_id || reg.assigned_second_team_id;
  return Number(two ? s.fee_two_cents : s.fee_one_cents);
}
function teamName(id) {
  if (!id) return '';
  const t = getTeam(id);
  return t ? t.name : '';
}

// Inscribe a un socio. Devuelve {id, waitlist} o {error}.
// Si la inscripción está cerrada, la inscripción entra en lista de espera.
function register(data) {
  const season = getSetting('season');
  const name = (data.name || '').trim();
  const phone = (data.phone || '').trim();
  const memberNo = (data.member_no || '').trim();
  const email = (data.email || '').trim();
  const modality = data.modality === 'veteranos' ? 'veteranos' : 'absoluto';
  const level = parseFloat(data.level);
  if (!name) return { error: 'Falta tu nombre y apellidos.' };
  if (!L.validSpanishMobile(phone)) return { error: 'El teléfono no parece un móvil válido (9 dígitos, empieza por 6 o 7).' };
  if (!memberNo) return { error: 'Falta tu nº de socio.' };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'El email no parece válido.' };
  if (!(level >= 1 && level <= 7)) return { error: 'Indica tu nivel (de 1 a 7).' };
  if (data.consent !== '1') return { error: 'Tienes que aceptar el tratamiento de tus datos para inscribirte.' };
  const v = verifyMember(memberNo, phone);
  if (v.error) return { error: v.error };
  const teamId = data.team_id ? Number(data.team_id) : null;
  const secondTeamId = data.second_team_id ? Number(data.second_team_id) : null;
  if (teamId) {
    const t = getTeam(teamId);
    if (!t || !t.active) return { error: 'El equipo elegido no existe o no está activo.' };
    if (t.modality !== modality) return { error: 'El equipo elegido no es de esa modalidad.' };
  }
  if (secondTeamId) {
    const t = getTeam(secondTeamId);
    if (!t || !t.active) return { error: 'El segundo equipo elegido no existe o no está activo.' };
    if (secondTeamId === teamId) return { error: 'El segundo equipo tiene que ser distinto del primero.' };
  }
  if (!LICENCE_MODES[data.licence_mode]) return { error: 'Indica cómo tramitarás la licencia.' };
  if (!FEE_MODES[data.fee_mode]) return { error: 'Indica cómo pagarás la cuota.' };
  const dup = edb.prepare('SELECT 1 FROM team_registrations WHERE member_no = ? AND season = ?')
    .get(v.member.member_no, season);
  if (dup) return { error: 'Ya estás inscrito/a en los equipos federados esta temporada. Si quieres cambiar algo, contacta con recepción.' };
  const waitlist = !inscriptionOpen();
  try {
    const r = edb.prepare(`INSERT INTO team_registrations
      (season, member_no, name, phone, email, modality, team_id, second_team_id, level,
       licence_mode, fee_mode, comments, status)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(season, v.member.member_no, name, phone, email, modality, teamId, secondTeamId,
        Math.round(level * 4) / 4, data.licence_mode, data.fee_mode,
        (data.comments || '').trim(), waitlist ? 'lista_espera' : 'pendiente');
    return { id: Number(r.lastInsertRowid), waitlist };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return { error: 'Ya estás inscrito/a en los equipos federados esta temporada. Si quieres cambiar algo, contacta con recepción.' };
    throw e;
  }
}
function getRegistration(id) {
  return edb.prepare('SELECT * FROM team_registrations WHERE id = ?').get(id) || null;
}
function listRegistrations({ f = 'todos', q = '', modality = '', team = '' } = {}) {
  let sql = 'SELECT * FROM team_registrations WHERE season = ?';
  const params = [getSetting('season')];
  if (f === 'pendientes') sql += " AND status = 'pendiente'";
  if (f === 'sin_equipo') sql += " AND status = 'pendiente' AND assigned_team_id IS NULL";
  if (f === 'sin_licencia') sql += ' AND licence_done = 0';
  if (f === 'sin_pagar') sql += ' AND fee_paid = 0';
  if (f === 'lista_espera') sql += " AND status = 'lista_espera'";
  if (f === 'asignados') sql += " AND status = 'asignado'";
  if (modality) { sql += ' AND modality = ?'; params.push(modality); }
  if (team) {
    sql += ' AND (team_id = ? OR second_team_id = ? OR assigned_team_id = ? OR assigned_second_team_id = ?)';
    params.push(team, team, team, team);
  }
  if (q) {
    sql += ' AND (name LIKE ? OR member_no LIKE ? OR phone LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY name';
  return edb.prepare(sql).all(...params).map(r => ({
    ...r,
    teamName: teamName(r.team_id), secondTeamName: teamName(r.second_team_id),
    assignedName: teamName(r.assigned_team_id), assignedSecondName: teamName(r.assigned_second_team_id),
    feeDue: feeDueCents(r),
  }));
}
function counts() {
  const season = getSetting('season');
  const c = (where, p = []) => edb.prepare(
    `SELECT COUNT(*) c FROM team_registrations WHERE season = ? ${where}`).get(season, ...p).c;
  return {
    total: c(''), pendientes: c("AND status = 'pendiente'"),
    asignados: c("AND status = 'asignado'"),
    sinLicencia: c('AND licence_done = 0'), sinPagar: c('AND fee_paid = 0'),
    listaEspera: c("AND status = 'lista_espera'"),
  };
}
// Reparto (solo Mathius, desde admin): asigna a un equipo (y opcionalmente
// a un segundo) y marca la inscripción como asignada.
function assign(id, teamId, secondTeamId) {
  const reg = getRegistration(id);
  if (!reg) return { error: 'Inscripción no encontrada.' };
  const t = teamId ? getTeam(Number(teamId)) : null;
  if (teamId && (!t || !t.active)) return { error: 'El equipo no existe o no está activo.' };
  const t2 = secondTeamId ? getTeam(Number(secondTeamId)) : null;
  if (secondTeamId && (!t2 || !t2.active)) return { error: 'El segundo equipo no existe o no está activo.' };
  if (t2 && t && t2.id === t.id) return { error: 'El segundo equipo tiene que ser distinto del primero.' };
  edb.prepare(`UPDATE team_registrations SET assigned_team_id = ?, assigned_second_team_id = ?,
    status = ? WHERE id = ?`)
    .run(t ? t.id : null, t2 ? t2.id : null, t ? 'asignado' : 'pendiente', id);
  return { ok: true };
}
function setStatus(id, status) {
  if (!STATUSES[status]) return { error: 'Estado no válido.' };
  const reg = getRegistration(id);
  if (!reg) return { error: 'Inscripción no encontrada.' };
  // Al rechazar o pasar a lista de espera se quita la asignación.
  if (status === 'rechazado' || status === 'lista_espera') {
    edb.prepare("UPDATE team_registrations SET status = ?, assigned_team_id = NULL, assigned_second_team_id = NULL WHERE id = ?").run(status, id);
  } else if (status === 'pendiente') {
    edb.prepare("UPDATE team_registrations SET status = 'pendiente', assigned_team_id = NULL, assigned_second_team_id = NULL WHERE id = ?").run(id);
  } else {
    edb.prepare('UPDATE team_registrations SET status = ? WHERE id = ?').run(status, id);
  }
  return { ok: true };
}
function setLicence(id, done) {
  edb.prepare('UPDATE team_registrations SET licence_done = ? WHERE id = ?').run(done ? 1 : 0, id);
}
function setFeePaid(id, paid) {
  edb.prepare('UPDATE team_registrations SET fee_paid = ? WHERE id = ?').run(paid ? 1 : 0, id);
}
function removeRegistration(id) {
  edb.prepare('DELETE FROM team_registrations WHERE id = ?').run(id);
}
// Plantilla de un equipo: asignados (equipo principal o segundo).
function roster(teamId) {
  return edb.prepare(`SELECT * FROM team_registrations
    WHERE season = ? AND status = 'asignado' AND (assigned_team_id = ? OR assigned_second_team_id = ?)
    ORDER BY name`).all(getSetting('season'), teamId, teamId);
}
function countAssigned(teamId) {
  return edb.prepare(`SELECT COUNT(*) c FROM team_registrations
    WHERE season = ? AND status = 'asignado' AND (assigned_team_id = ? OR assigned_second_team_id = ?)`)
    .get(getSetting('season'), teamId, teamId).c;
}

module.exports = {
  getSetting, setSetting, getSettings, eur, fmtDate, inscriptionOpen,
  MODALITIES, modalityName, SEXES, sexName,
  listTeams, getTeam, getTeamBySlug, createTeam, updateTeam, setTeamActive, deleteTeam, validateSlug,
  listCaptains, addCaptain, removeCaptain,
  memberNoMatches, verifyMember,
  LICENCE_MODES, FEE_MODES, STATUSES, statusName, feeDueCents,
  register, getRegistration, listRegistrations, counts, assign, setStatus, setLicence, setFeePaid,
  removeRegistration, roster, countAssigned,
};
