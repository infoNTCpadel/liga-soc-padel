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
  let tid = data.tournament_id != null ? Number(data.tournament_id) : null;
  if (!tid) {
    const cur = currentTournament(mdb);
    if (!cur) throw new Error('No hay ninguna edición abierta para inscribir la pareja.');
    tid = cur.id;
  }
  const code = genCode(mdb);
  const r = mdb.prepare(
    `INSERT INTO midday_pairs(code, tournament_id, player1_name, player1_email, player1_phone,
       player2_name, player2_email, player2_phone, level1, level2, level_avg,
       slot_prefs, weekdays_off, blackout_dates, notes)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code, tid, data.player1_name, data.player1_email, data.player1_phone,
    data.player2_name, data.player2_email, data.player2_phone,
    data.level1, data.level2, data.level_avg,
    data.slot_prefs, data.weekdays_off, data.blackout_dates, data.notes);
  return { id: Number(r.lastInsertRowid), code, tournament_id: tid };
}

// Evita inscribir dos veces a la misma pareja (mismos dos móviles) dentro de una edición.
function pairExists(mdb, phone1, phone2, tournamentId = null) {
  let tid = tournamentId != null ? Number(tournamentId) : null;
  if (!tid) {
    const cur = currentTournament(mdb);
    if (!cur) return false;
    tid = cur.id;
  }
  const [a, b] = [phone1, phone2].sort();
  return !!mdb.prepare(
    `SELECT 1 FROM midday_pairs
     WHERE tournament_id = ? AND status != 'rejected'
       AND ((player1_phone < player2_phone AND player1_phone = ? AND player2_phone = ?)
         OR (player2_phone < player1_phone AND player2_phone = ? AND player1_phone = ?)
         OR (player1_phone = player2_phone AND player1_phone = ?))
     LIMIT 1`
  ).get(tid, a, b, a, b, a);
}

function listPairs(mdb, tournamentId = null) {
  let tid = tournamentId != null ? Number(tournamentId) : null;
  if (!tid) {
    const cur = currentTournament(mdb);
    if (!cur) return [];
    tid = cur.id;
  }
  return mdb.prepare('SELECT * FROM midday_pairs WHERE tournament_id = ? ORDER BY created_at, id')
    .all(tid).map(decorate);
}

function countPairs(mdb, tournamentId) {
  return mdb.prepare('SELECT COUNT(*) c FROM midday_pairs WHERE tournament_id = ?')
    .get(tournamentId).c;
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

// ---- ediciones (torneos) ----
// status: inscription (inscripción abierta) | active (en marcha) | finished.
const TOURNAMENT_STATUSES = ['inscription', 'active', 'finished'];
const TOURNAMENT_STATUS_NAMES = { inscription: 'Inscripción', active: 'En marcha', finished: 'Finalizada' };

function listTournaments(mdb) {
  return mdb.prepare('SELECT * FROM midday_tournaments ORDER BY id').all();
}

function getTournament(mdb, id) {
  return mdb.prepare('SELECT * FROM midday_tournaments WHERE id = ?').get(id) || null;
}

// Edición abierta actual: la no finalizada de mayor id (null si no hay).
function currentTournament(mdb) {
  return mdb.prepare(
    "SELECT * FROM midday_tournaments WHERE status != 'finished' ORDER BY id DESC LIMIT 1").get() || null;
}

// Crea una edición nueva copiando los ajustes de copyFromId (o de la edición
// abierta actual). La nueva queda en 'inscription' y solo puede haber una
// edición abierta a la vez: las demás no finalizadas se finalizan.
function createTournament(mdb, name, copyFromId, defaults) {
  const nm = String(name || '').trim();
  if (!nm) return { ok: false, error: 'El nombre de la edición no puede estar vacío.' };
  let srcId = copyFromId != null && copyFromId !== '' ? Number(copyFromId) : null;
  if (srcId && !getTournament(mdb, srcId))
    return { ok: false, error: 'La edición de origen no existe.' };
  if (!srcId) {
    const cur = currentTournament(mdb);
    srcId = cur ? cur.id : null;
  }
  const r = mdb.prepare("INSERT INTO midday_tournaments(name, status) VALUES(?, 'inscription')").run(nm);
  const tid = Number(r.lastInsertRowid);
  mdb.prepare("UPDATE midday_tournaments SET status = 'finished' WHERE id != ? AND status != 'finished'").run(tid);
  const ins = mdb.prepare('INSERT INTO midday_settings(tournament_id, key, value) VALUES(?, ?, ?)');
  if (srcId) {
    for (const row of mdb.prepare('SELECT key, value FROM midday_settings WHERE tournament_id = ?').all(srcId))
      ins.run(tid, row.key, row.value);
  } else if (defaults) {
    for (const [k, v] of Object.entries(defaults)) ins.run(tid, k, String(v));
  }
  return { ok: true, id: tid };
}

function renameTournament(mdb, id, name) {
  const nm = String(name || '').trim();
  if (!nm) return false;
  return mdb.prepare('UPDATE midday_tournaments SET name = ? WHERE id = ?').run(nm, id).changes > 0;
}

// Transiciones válidas: inscription → active | finished; active → finished.
// Al pasar a inscription/active, las demás ediciones abiertas se finalizan.
function setTournamentStatus(mdb, id, status) {
  const t = getTournament(mdb, id);
  if (!t) return { ok: false, error: 'La edición no existe.' };
  if (!TOURNAMENT_STATUSES.includes(status)) return { ok: false, error: 'Estado no válido.' };
  if (t.status === status) return { ok: true };
  const allowed = { inscription: ['active', 'finished'], active: ['finished'], finished: [] };
  if (!allowed[t.status].includes(status))
    return { ok: false, error: `No se puede pasar de "${TOURNAMENT_STATUS_NAMES[t.status]}" a "${TOURNAMENT_STATUS_NAMES[status]}".` };
  if (status === 'inscription' || status === 'active')
    mdb.prepare("UPDATE midday_tournaments SET status = 'finished' WHERE id != ? AND status != 'finished'").run(id);
  mdb.prepare('UPDATE midday_tournaments SET status = ? WHERE id = ?').run(status, id);
  return { ok: true };
}

// Solo se puede eliminar una edición sin parejas.
function deleteTournament(mdb, id) {
  const t = getTournament(mdb, id);
  if (!t) return { ok: false, error: 'La edición no existe.' };
  if (countPairs(mdb, id) > 0)
    return { ok: false, error: 'No se puede eliminar: la edición tiene parejas inscritas.' };
  mdb.prepare('DELETE FROM midday_settings WHERE tournament_id = ?').run(id);
  mdb.prepare('DELETE FROM midday_tournaments WHERE id = ?').run(id);
  return { ok: true };
}

// ---- datos de prueba ----
const TEST_FIRST = ['Ana', 'Luis', 'María', 'Jorge', 'Carmen', 'Pablo', 'Lucía', 'Miguel',
  'Sara', 'David', 'Elena', 'Javier', 'Marta', 'Diego', 'Paula', 'Andrés', 'Laura', 'Sergio'];
const TEST_LAST = ['López', 'Gil', 'Ruiz', 'Martí', 'Sanz', 'Torres', 'Vidal', 'Ferrer',
  'Roca', 'Sala', 'Puig', 'Costa', 'Sánchez', 'Pérez', 'Gómez', 'Fernández'];

function generateTestPairs(mdb, tournamentId, n = 8) {
  const tid = Number(tournamentId);
  if (!getTournament(mdb, tid)) throw new Error('La edición no existe.');
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const base = countTestPairs(mdb, tid);
  const created = [];
  for (let i = 0; i < n; i++) {
    const p1 = `${pick(TEST_FIRST)} ${pick(TEST_LAST)}`;
    let p2 = `${pick(TEST_FIRST)} ${pick(TEST_LAST)}`;
    if (p2 === p1) p2 = p2 + ' II';
    const phone = () => '6' + String(Math.floor(Math.random() * 90000000) + 10000000);
    let ph1 = phone(), ph2 = phone(), guard = 0;
    while (pairExists(mdb, ph1, ph2, tid) && guard++ < 30) { ph1 = phone(); ph2 = phone(); }
    const lvl = () => Math.min(7, Math.round((2 + Math.random() * 4.25) * 4) / 4);
    const l1 = lvl(), l2 = lvl();
    const slotPrefs = {};
    for (const s of ['s1', 's2']) slotPrefs[s] = ['pref', 'ok', 'ok', 'no'][Math.floor(Math.random() * 4)];
    if (!Object.values(slotPrefs).some(v => v !== 'no')) slotPrefs.s1 = 'ok';
    const weekdaysOff = Math.random() < 0.4 ? [WEEKDAY_IDS[Math.floor(Math.random() * WEEKDAY_IDS.length)]] : [];
    const seq = base + i + 1;
    const r = mdb.prepare(
      `INSERT INTO midday_pairs(code, tournament_id, player1_name, player1_email, player1_phone,
         player2_name, player2_email, player2_phone, level1, level2, level_avg,
         slot_prefs, weekdays_off, blackout_dates, status, is_test)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(genCode(mdb), tid, p1, `prueba${seq}a@ejemplo.com`, ph1,
      p2, `prueba${seq}b@ejemplo.com`, ph2,
      l1, l2, Math.round(((l1 + l2) / 2) * 100) / 100,
      JSON.stringify(slotPrefs), JSON.stringify(weekdaysOff), '[]',
      Math.random() < 0.5 ? 'approved' : 'pending');
    created.push({ id: Number(r.lastInsertRowid) });
  }
  return created;
}

function deleteTestPairs(mdb, tournamentId) {
  return mdb.prepare('DELETE FROM midday_pairs WHERE tournament_id = ? AND is_test = 1')
    .run(tournamentId).changes;
}

function countTestPairs(mdb, tournamentId) {
  return mdb.prepare('SELECT COUNT(*) c FROM midday_pairs WHERE tournament_id = ? AND is_test = 1')
    .get(tournamentId).c;
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
  createPair, pairExists, listPairs, countPairs, getPair, getPairByCode,
  setStatus, deletePair, updateLevels,
  fmtSlotPrefs, fmtWeekdaysOff, suggestLevel,
  TOURNAMENT_STATUSES, TOURNAMENT_STATUS_NAMES,
  listTournaments, getTournament, currentTournament,
  createTournament, renameTournament, setTournamentStatus, deleteTournament,
  generateTestPairs, deleteTestPairs, countTestPairs,
};
