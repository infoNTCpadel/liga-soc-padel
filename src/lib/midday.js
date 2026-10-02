// MEDIODÍA PADEL — lógica de la competición paralela (Fase A: inscripción).
// Todo lo de este módulo opera sobre `midday.db`; NUNCA escribe en meta.db
// ni en las temporadas de la liga social (solo lecturas para sugerir niveles).

const WEEKDAYS = [
  { id: 'mon', name: 'Lunes' },
  { id: 'tue', name: 'Martes' },
  { id: 'wed', name: 'Miércoles' },
  { id: 'thu', name: 'Jueves' },
  { id: 'fri', name: 'Viernes' },
];
const WEEKDAY_IDS = WEEKDAYS.map(w => w.id);

const SLOT_VALUES = ['pref', 'ok', 'no']; // preferida | me va bien | imposible

function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());
}

function normEmail(s) { return String(s || '').trim().toLowerCase(); }

// Código de acceso de 6 caracteres (mismo alfabeto que la liga social).
function genCode(mdb) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (mdb.prepare('SELECT 1 FROM midday_pairs WHERE code = ?').get(code));
  return code;
}

// Escala de la liga social (0–6 Playtomic) → escala oficial del club (1–7).
function playtomicToMidday(lvl) {
  const v = Number(lvl);
  if (!Number.isFinite(v)) return null;
  return Math.min(7, Math.max(1, Math.round((v + 1) * 4) / 4));
}

function validLevel(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 7 && Math.round(n * 4) === n * 4;
}

// Franjas desde settings: '[{"id":"s1","label":"13:00"},...]'
function parseSlots(raw) {
  let arr;
  try { arr = JSON.parse(raw || '[]'); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(s => s && typeof s.label === 'string' && s.label.trim())
    .map((s, i) => ({ id: String(s.id || `s${i + 1}`), label: s.label.trim() }));
}

// "2026-11-05, 2026-12-08" → { dates: [...], error: null | msg }
function parseBlackout(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return { dates: [], error: null };
  const parts = txt.split(/[,;\n]+/).map(p => p.trim()).filter(Boolean);
  const dates = [];
  for (const p of parts) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p)) return { dates: [], error: `Fecha no válida: "${p}". Usa el formato AAAA-MM-DD.` };
    const d = new Date(p + 'T12:00:00');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== p)
      return { dates: [], error: `Fecha inexistente: "${p}".` };
    if (!dates.includes(p)) dates.push(p);
  }
  dates.sort();
  return { dates, error: null };
}

// Valida el formulario de inscripción. Devuelve { ok, errors[], data }.
// `data` ya lleva los campos limpios listos para createPair().
function validateInscription(body, slots) {
  const errors = [];
  const b = body || {};
  const t = (v) => String(v || '').trim();

  const p1 = { name: t(b.p1_name), email: t(b.p1_email), phone: t(b.p1_phone), level: b.p1_level };
  const p2 = { name: t(b.p2_name), email: t(b.p2_email), phone: t(b.p2_phone), level: b.p2_level };

  [['Jugador 1', p1], ['Jugador 2', p2]].forEach(([tag, p]) => {
    if (!p.name) errors.push(`${tag}: falta el nombre.`);
    if (!validEmail(p.email)) errors.push(`${tag}: el email no es válido.`);
    if (!/^[67]\d{8}$/.test(p.phone.replace(/[\s.-]/g, ''))) errors.push(`${tag}: el móvil no es válido (9 dígitos, empieza por 6 o 7).`);
    if (!validLevel(p.level)) errors.push(`${tag}: el nivel debe estar entre 1 y 7 (en pasos de 0,25).`);
  });
  if (p1.name && p2.name && p1.name.toLowerCase() === p2.name.toLowerCase())
    errors.push('Los dos jugadores no pueden tener el mismo nombre.');
  const ph1 = p1.phone.replace(/[\s.-]/g, ''), ph2 = p2.phone.replace(/[\s.-]/g, '');
  if (ph1 && ph2 && ph1 === ph2) errors.push('Los dos jugadores no pueden tener el mismo móvil.');

  // Preferencias de franja
  const slotPrefs = {};
  for (const s of slots) {
    const v = SLOT_VALUES.includes(b[`slot_${s.id}`]) ? b[`slot_${s.id}`] : 'ok';
    slotPrefs[s.id] = v;
  }
  if (slots.length && !Object.values(slotPrefs).some(v => v !== 'no'))
    errors.push('Tenéis que poder jugar en al menos una franja horaria.');

  // Días de la semana vetados
  const weekdaysOff = WEEKDAY_IDS.filter(id => b[`off_${id}`]);
  // Fechas sueltas
  const { dates: blackoutDates, error: blackoutError } = parseBlackout(b.blackout);
  if (blackoutError) errors.push(blackoutError);

  if (!b.normativa) errors.push('Debes aceptar la normativa para inscribirte.');

  if (errors.length) return { ok: false, errors, data: null };

  const level1 = Math.round(Number(p1.level) * 4) / 4;
  const level2 = Math.round(Number(p2.level) * 4) / 4;
  const data = {
    player1_name: p1.name, player1_email: normEmail(p1.email), player1_phone: ph1,
    player2_name: p2.name, player2_email: normEmail(p2.email), player2_phone: ph2,
    level1, level2,
    level_avg: Math.round(((level1 + level2) / 2) * 100) / 100,
    slot_prefs: JSON.stringify(slotPrefs),
    weekdays_off: JSON.stringify(weekdaysOff),
    blackout_dates: JSON.stringify(blackoutDates),
    notes: t(b.notes),
  };
  return { ok: true, errors: [], data };
}

// ---- operaciones sobre midday.db ----
function createPair(mdb, data) {
  const code = genCode(mdb);
  const r = mdb.prepare(
    `INSERT INTO midday_pairs(code, player1_name, player1_email, player1_phone,
       player2_name, player2_email, player2_phone, level1, level2, level_avg,
       slot_prefs, weekdays_off, blackout_dates, notes)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code, data.player1_name, data.player1_email, data.player1_phone,
    data.player2_name, data.player2_email, data.player2_phone,
    data.level1, data.level2, data.level_avg,
    data.slot_prefs, data.weekdays_off, data.blackout_dates, data.notes);
  return { id: Number(r.lastInsertRowid), code };
}

// Evita inscribir dos veces a la misma pareja (mismos dos móviles).
function pairExists(mdb, phone1, phone2) {
  const [a, b] = [phone1, phone2].sort();
  return !!mdb.prepare(
    `SELECT 1 FROM midday_pairs
     WHERE status != 'rejected'
       AND ((player1_phone < player2_phone AND player1_phone = ? AND player2_phone = ?)
         OR (player2_phone < player1_phone AND player2_phone = ? AND player1_phone = ?)
         OR (player1_phone = player2_phone AND player1_phone = ?))
     LIMIT 1`
  ).get(a, b, a, b, a);
}

function listPairs(mdb) {
  return mdb.prepare('SELECT * FROM midday_pairs ORDER BY created_at, id').all().map(decorate);
}

function getPair(mdb, id) {
  const r = mdb.prepare('SELECT * FROM midday_pairs WHERE id = ?').get(id);
  return r ? decorate(r) : null;
}

function getPairByCode(mdb, code) {
  const r = mdb.prepare('SELECT * FROM midday_pairs WHERE code = ?').get(String(code || '').trim().toUpperCase());
  return r ? decorate(r) : null;
}

function decorate(r) {
  let slotPrefs = {}, weekdaysOff = [], blackoutDates = [];
  try { slotPrefs = JSON.parse(r.slot_prefs || '{}'); } catch (e) { /* noop */ }
  try { weekdaysOff = JSON.parse(r.weekdays_off || '[]'); } catch (e) { /* noop */ }
  try { blackoutDates = JSON.parse(r.blackout_dates || '[]'); } catch (e) { /* noop */ }
  return { ...r, slotPrefs, weekdaysOff, blackoutDates };
}

function setStatus(mdb, id, status) {
  if (!['pending', 'approved', 'rejected'].includes(status)) return false;
  const r = mdb.prepare('UPDATE midday_pairs SET status = ? WHERE id = ?').run(status, id);
  return r.changes > 0;
}

function deletePair(mdb, id) {
  return mdb.prepare('DELETE FROM midday_pairs WHERE id = ?').run(id).changes > 0;
}

function updateLevels(mdb, id, level1, level2) {
  if (!validLevel(level1) || !validLevel(level2)) return false;
  const l1 = Math.round(Number(level1) * 4) / 4;
  const l2 = Math.round(Number(level2) * 4) / 4;
  const avg = Math.round(((l1 + l2) / 2) * 100) / 100;
  const r = mdb.prepare('UPDATE midday_pairs SET level1 = ?, level2 = ?, level_avg = ? WHERE id = ?')
    .run(l1, l2, avg, id);
  return r.changes > 0;
}

// Resumen legible de preferencias de franja: "13:00 ★ · 14:30 ✓"
function fmtSlotPrefs(slotPrefs, slots) {
  return slots.map(s => {
    const v = (slotPrefs || {})[s.id] || 'ok';
    const mark = v === 'pref' ? ' ★' : v === 'no' ? ' ✗' : ' ✓';
    return s.label + mark;
  }).join(' · ');
}

function fmtWeekdaysOff(ids) {
  return WEEKDAYS.filter(w => (ids || []).includes(w.id)).map(w => w.name).join(', ') || '—';
}

// ---- sugerencia de nivel (SOLO LECTURA sobre meta.db y la temporada activa) ----
// Prioridad: 1) socios del club (escala 1–7 oficial), 2) liga social (0–6 → convertido).
function suggestLevel(metaDb, seasonDb, email, phone) {
  const em = normEmail(email);
  const ph = String(phone || '').replace(/[\s.-]/g, '');
  try {
    const members = metaDb.prepare(
      'SELECT email, phone, level FROM club_members WHERE active = 1').all();
    const m = members.find(r =>
      (em && r.email && normEmail(r.email) === em) ||
      (ph && r.phone && String(r.phone).replace(/[\s.-]/g, '') === ph));
    if (m && Number(m.level) >= 1 && Number(m.level) <= 7)
      return { level: Math.round(Number(m.level) * 4) / 4, source: 'socios del club' };
  } catch (e) { /* tabla ausente: se sigue */ }
  try {
    const players = seasonDb.prepare('SELECT email, phone, level FROM players').all();
    const p = players.find(r =>
      (em && r.email && normEmail(r.email) === em) ||
      (ph && r.phone && String(r.phone).replace(/[\s.-]/g, '') === ph));
    if (p) {
      const conv = playtomicToMidday(p.level);
      if (conv) return { level: conv, source: 'liga social' };
    }
  } catch (e) { /* noop */ }
  return null;
}

module.exports = {
  WEEKDAYS, WEEKDAY_IDS, SLOT_VALUES,
  validEmail, normEmail, genCode, playtomicToMidday, validLevel,
  parseSlots, parseBlackout, validateInscription,
  createPair, pairExists, listPairs, getPair, getPairByCode,
  setStatus, deletePair, updateLevels,
  fmtSlotPrefs, fmtWeekdaysOff, suggestLevel,
};
