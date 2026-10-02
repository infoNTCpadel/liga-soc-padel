// MEDIODÍA PADEL — Fase B: sorteo por bombos, calendario con restricciones,
// revisión del admin, publicación y avisos por email.
// Opera SOLO sobre midday.db (a través del handle que se le pasa).
const M = require('./midday');

// ---------- fechas (AAAA-MM-DD) ----------
function parseISODate(s) {
  s = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  const iso = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return iso === s ? iso : null;
}
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function diffDaysISO(a, b) {
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
}
function weekdayNum(iso) { return new Date(iso + 'T12:00:00').getDay(); } // 0=dom … 6=sáb
function isWeekdayISO(iso) { const w = weekdayNum(iso); return w >= 1 && w <= 5; }
const WD_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WD_SHORT = { mon: 'lun', tue: 'mar', wed: 'mié', thu: 'jue', fri: 'vie', sat: 'sáb', sun: 'dom' };
function fmtMatchDate(iso) {
  if (!iso || !parseISODate(iso)) return '—';
  const [, m, d] = iso.split('-');
  return `${WD_SHORT[WD_IDS[weekdayNum(iso)]]} ${d}/${m}`;
}

// ---------- bombos ----------
// 4 bombos lo más equilibrados posible; el bombo 1 reúne el nivel más alto.
function potSizes(n) {
  const base = Math.floor(n / 4), rem = n % 4;
  return [0, 1, 2, 3].map(i => base + (i < rem ? 1 : 0));
}
function buildPots(mdb, tournamentId) {
  const pairs = mdb.prepare(
    `SELECT id, player1_name, player2_name, level_avg FROM midday_pairs
     WHERE tournament_id = ? AND status = 'approved' ORDER BY level_avg DESC, id`).all(tournamentId);
  const sizes = potSizes(pairs.length);
  const pots = [];
  let i = 0;
  for (let p = 0; p < 4; p++) {
    const pot = { pot_no: p + 1, pairs: [] };
    for (let k = 0; k < sizes[p] && i < pairs.length; k++) pot.pairs.push(pairs[i++]);
    pots.push(pot);
  }
  return pots;
}

// ---------- emparejamientos (método del círculo) ----------
function shuffled(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
// Orden inicial: intercala los bombos (1,2,3,4,1,2,…) con aleatorio dentro
// de cada bombo, para que los rivales varíen en nivel desde la primera ronda.
function interleavePots(pots) {
  const sh = pots.map(p => shuffled(p.pairs.map(x => x.id)));
  const out = [];
  const maxLen = Math.max(0, ...sh.map(s => s.length));
  for (let i = 0; i < maxLen; i++)
    for (const s of sh) if (i < s.length) out.push(s[i]);
  return out;
}
// Una vuelta todos contra todos. Con N impar se añade un "bye" (null).
function circleRounds(ids) {
  const arr = ids.slice();
  if (arr.length % 2 === 1) arr.push(null);
  const n = arr.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const ms = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a != null && b != null) ms.push([a, b]);
    }
    rounds.push(ms);
    arr.splice(1, 0, arr.pop()); // el primero fijo, el resto rota
  }
  return rounds;
}

// Crea el sorteo (en borrador) con sus bombos y partidos (sin programar).
// R = rondas de una vuelta (N-1 si N par, N si N impar con bye).
// legs = 1 si R >= 6, 2 (ida y vuelta) en caso contrario.
// K = min(legs*R, 8): rondas generadas; cada pareja juega ≥ 6 partidos (N ≥ 4).
function buildDraw(mdb, tournamentId) {
  const t = mdb.prepare('SELECT * FROM midday_tournaments WHERE id = ?').get(tournamentId);
  if (!t) throw new Error('La edición no existe.');
  if (t.status !== 'active') throw new Error('La edición debe estar «En marcha» para generar el sorteo.');
  const pub = mdb.prepare("SELECT 1 FROM midday_draws WHERE tournament_id = ? AND status = 'published'").get(tournamentId);
  if (pub) throw new Error('Ya hay un calendario publicado para esta edición.');
  const approved = mdb.prepare("SELECT id FROM midday_pairs WHERE tournament_id = ? AND status = 'approved'").all(tournamentId);
  const N = approved.length;
  if (N < 4) throw new Error(`Se necesitan al menos 4 parejas confirmadas para el sorteo (hay ${N}).`);
  // Regenerar: se permite mientras el sorteo sea borrador (se sustituye).
  const old = mdb.prepare("SELECT id FROM midday_draws WHERE tournament_id = ? AND status = 'draft'").get(tournamentId);
  if (old) deleteDraw(mdb, old.id);

  const pots = buildPots(mdb, tournamentId);
  const leg1 = circleRounds(interleavePots(pots));
  const R = leg1.length;
  const legs = R >= 6 ? 1 : 2;
  const leg2 = leg1.map(rd => rd.map(([a, b]) => [b, a])); // vuelta: se invierte el orden
  const allRounds = (legs === 2 ? leg1.concat(leg2) : leg1).slice(0, Math.min(legs * R, 8));
  const K = allRounds.length;

  const params = {
    pots: pots.map(p => p.pairs.length), leg_rounds: R, rounds: K, legs,
    approved: N, generated_at: new Date().toISOString(),
  };
  const dr = mdb.prepare("INSERT INTO midday_draws(tournament_id, params, status) VALUES(?, ?, 'draft')")
    .run(tournamentId, JSON.stringify(params));
  const drawId = Number(dr.lastInsertRowid);
  const insPot = mdb.prepare('INSERT INTO midday_draw_pots(draw_id, pair_id, pot_no) VALUES(?, ?, ?)');
  for (const p of pots) for (const pr of p.pairs) insPot.run(drawId, pr.id, p.pot_no);
  const insM = mdb.prepare('INSERT INTO midday_matches(draw_id, tournament_id, round_no, pair1_id, pair2_id) VALUES(?, ?, ?, ?, ?)');
  allRounds.forEach((rd, ri) => { for (const [a, b] of rd) insM.run(drawId, tournamentId, ri + 1, a, b); });
  // Calendario propuesto con las restricciones de la edición.
  const sched = scheduleDraw(mdb, drawId, M.getSettings(mdb, tournamentId));
  params.scheduled = sched.scheduled;
  params.unscheduled = sched.unscheduled.length;
  mdb.prepare('UPDATE midday_draws SET params = ? WHERE id = ?').run(JSON.stringify(params), drawId);
  return { id: drawId, rounds: K, legs, pairs: N, legRounds: R, scheduled: sched.scheduled, unscheduled: sched.unscheduled };
}

function deleteDraw(mdb, drawId) {
  mdb.prepare('DELETE FROM midday_matches WHERE draw_id = ?').run(drawId);
  mdb.prepare('DELETE FROM midday_draw_pots WHERE draw_id = ?').run(drawId);
  mdb.prepare('DELETE FROM midday_draws WHERE id = ?').run(drawId);
}

function parseParams(row) {
  let params = {};
  try { params = JSON.parse(row.params || '{}'); } catch (e) { /* noop */ }
  return { ...row, params };
}
function getDraw(mdb, drawId) {
  const r = mdb.prepare('SELECT * FROM midday_draws WHERE id = ?').get(drawId);
  return r ? parseParams(r) : null;
}
// Sorteo más reciente de la edición (borrador o publicado).
function drawForTournament(mdb, tournamentId) {
  const r = mdb.prepare('SELECT * FROM midday_draws WHERE tournament_id = ? ORDER BY id DESC LIMIT 1').get(tournamentId);
  return r ? parseParams(r) : null;
}
function drawPots(mdb, drawId) {
  const rows = mdb.prepare(
    `SELECT dp.pot_no, p.id, p.player1_name, p.player2_name, p.level_avg
     FROM midday_draw_pots dp JOIN midday_pairs p ON p.id = dp.pair_id
     WHERE dp.draw_id = ? ORDER BY dp.pot_no, p.level_avg DESC, p.id`).all(drawId);
  const pots = [];
  for (const r of rows) {
    let pot = pots.find(p => p.pot_no === r.pot_no);
    if (!pot) { pot = { pot_no: r.pot_no, pairs: [] }; pots.push(pot); }
    pot.pairs.push(r);
  }
  return pots;
}
function drawMatches(mdb, drawId) {
  return mdb.prepare(
    `SELECT m.*, p1.player1_name n1a, p1.player2_name n1b, p2.player1_name n2a, p2.player2_name n2b
     FROM midday_matches m
     JOIN midday_pairs p1 ON p1.id = m.pair1_id
     JOIN midday_pairs p2 ON p2.id = m.pair2_id
     WHERE m.draw_id = ? ORDER BY m.round_no, m.id`).all(drawId);
}
function pairMatches(mdb, drawId, pairId) {
  return mdb.prepare(
    `SELECT m.*, p1.player1_name n1a, p1.player2_name n1b, p2.player1_name n2a, p2.player2_name n2b
     FROM midday_matches m
     JOIN midday_pairs p1 ON p1.id = m.pair1_id
     JOIN midday_pairs p2 ON p2.id = m.pair2_id
     WHERE m.draw_id = ? AND (m.pair1_id = ? OR m.pair2_id = ?)
     ORDER BY m.round_no`).all(drawId, pairId, pairId);
}

// ---------- calendario con restricciones ----------
// ¿Puede jugar la pareja ese día en esa franja?
function canPlayOn(p, iso, slotId) {
  const pref = (p.slotPrefs && p.slotPrefs[slotId]) || 'ok';
  if (pref === 'no') return false;
  if ((p.weekdaysOff || []).includes(WD_IDS[weekdayNum(iso)])) return false;
  if ((p.blackoutDates || []).includes(iso)) return false;
  return true;
}
function tooClose(dates, iso, minDays) {
  if (!minDays || minDays <= 0) return false;
  return (dates || []).some(d => Math.abs(diffDaysISO(d, iso)) < minDays);
}
// Franjas ordenadas: primero donde ambas marcaron 'pref', luego orden configurado.
function orderSlotsByPref(slots, p1, p2) {
  const score = (s) => ((p1.slotPrefs || {})[s.id] === 'pref' ? 1 : 0) + ((p2.slotPrefs || {})[s.id] === 'pref' ? 1 : 0);
  return slots.map((s, i) => ({ s, i })).sort((a, b) => score(b.s) - score(a.s) || a.i - b.i).map(x => x.s);
}

// Programa los partidos del sorteo. settings = { slots, courts, minDays, startDate }.
// Determinista: recorre fechas y franjas en orden y asigna el primer hueco válido.
function scheduleDraw(mdb, drawId, settings) {
  const draw = getDraw(mdb, drawId);
  if (!draw) throw new Error('Sorteo no encontrado.');
  const { slots, courts, minDays, startDate } = settings;
  if (!slots.length) throw new Error('No hay franjas horarias configuradas.');
  if (!parseISODate(startDate)) throw new Error('La fecha de inicio no es válida.');
  const pairsById = {};
  for (const p of M.listPairs(mdb, draw.tournament_id)) pairsById[p.id] = p;

  const matches = mdb.prepare('SELECT * FROM midday_matches WHERE draw_id = ? ORDER BY round_no, id').all(drawId);
  const pairDates = {};   // pairId -> [iso]
  const courtUse = {};    // "iso|slotId" -> Set(court_no)
  const unscheduled = [];
  const upd = mdb.prepare('UPDATE midday_matches SET match_date = ?, slot_id = ?, court_no = ? WHERE id = ?');

  for (const mt of matches) {
    const p1 = pairsById[mt.pair1_id], p2 = pairsById[mt.pair2_id];
    if (!p1 || !p2) { unscheduled.push(mt.id); continue; }
    let placed = false;
    for (let d = 0; d < 84 && !placed; d++) { // horizonte: 12 semanas
      const iso = addDaysISO(startDate, d);
      if (!isWeekdayISO(iso)) continue;
      for (const s of orderSlotsByPref(slots, p1, p2)) {
        if (!canPlayOn(p1, iso, s.id) || !canPlayOn(p2, iso, s.id)) continue;
        if (tooClose(pairDates[p1.id], iso, minDays) || tooClose(pairDates[p2.id], iso, minDays)) continue;
        const key = iso + '|' + s.id;
        const used = courtUse[key] || (courtUse[key] = new Set());
        let free = null;
        for (let cn = 1; cn <= courts; cn++) if (!used.has(cn)) { free = cn; break; }
        if (free == null) continue;
        upd.run(iso, s.id, free, mt.id);
        used.add(free);
        (pairDates[p1.id] = pairDates[p1.id] || []).push(iso);
        (pairDates[p2.id] = pairDates[p2.id] || []).push(iso);
        placed = true;
        break;
      }
    }
    if (!placed) unscheduled.push(mt.id);
  }
  return { scheduled: matches.length - unscheduled.length, total: matches.length, unscheduled };
}

// Reprograma un partido del borrador validando restricciones.
// opts: { force } (el admin pasa por alto las preferencias de las parejas,
//         ya habladas con ellas) y { customTime } ('HH:MM': hora libre fuera
//         de las franjas configuradas; también es un ajuste manual).
// Duras (siempre): fecha válida, lun–vie, pista válida y no ocupada.
// Blandas (se omiten con force): preferencias de franja/días/fechas y descanso mínimo.
function rescheduleMatch(mdb, matchId, iso, slotId, courtNo, settings, opts = {}) {
  const { force = false, customTime = null } = opts;
  const mt = mdb.prepare('SELECT * FROM midday_matches WHERE id = ?').get(matchId);
  if (!mt) return { ok: false, error: 'Partido no encontrado.' };
  const draw = getDraw(mdb, mt.draw_id);
  if (!draw) return { ok: false, error: 'Sorteo no encontrado.' };
  if (draw.status !== 'draft') return { ok: false, error: 'Solo se puede modificar el calendario en borrador.' };
  if (!parseISODate(iso)) return { ok: false, error: 'Fecha no válida (AAAA-MM-DD).' };
  if (!isWeekdayISO(iso)) return { ok: false, error: 'Solo se juega de lunes a viernes.' };
  const { slots, courts, minDays } = settings;
  const cTime = (customTime || '').trim() || null;
  if (cTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(cTime))
    return { ok: false, error: 'Hora no válida (formato HH:MM).' };
  if (!cTime && !slots.some(s => s.id === slotId)) return { ok: false, error: 'Franja no válida.' };
  const cn = Number(courtNo);
  if (!Number.isInteger(cn) || cn < 1 || cn > courts)
    return { ok: false, error: `Pista no válida (1–${courts}).` };
  const pairsById = {};
  for (const p of M.listPairs(mdb, draw.tournament_id)) pairsById[p.id] = p;
  const p1 = pairsById[mt.pair1_id], p2 = pairsById[mt.pair2_id];
  if (!p1 || !p2) return { ok: false, error: 'Pareja no encontrada.' };
  const pname = (p) => `${p.player1_name} / ${p.player2_name}`;
  const effSlot = cTime ? null : slotId; // con hora libre no se aplican prefs de franja
  if (!force && !cTime) {
    if (!canPlayOn(p1, iso, slotId))
      return { ok: false, soft: true, error: `${pname(p1)} no puede jugar ese día en esa franja. Marca «Programar igualmente» si ya lo has hablado con ellos.` };
    if (!canPlayOn(p2, iso, slotId))
      return { ok: false, soft: true, error: `${pname(p2)} no puede jugar ese día en esa franja. Marca «Programar igualmente» si ya lo has hablado con ellos.` };
  }
  if (!force && minDays > 0) {
    const others = mdb.prepare(
      `SELECT * FROM midday_matches WHERE draw_id = ? AND id != ? AND match_date IS NOT NULL
       AND (pair1_id IN (?, ?) OR pair2_id IN (?, ?))`).all(draw.id, matchId, p1.id, p2.id, p1.id, p2.id);
    for (const o of others) {
      if (Math.abs(diffDaysISO(o.match_date, iso)) < minDays)
        return { ok: false, soft: true, error: `Choca con el descanso mínimo de ${minDays} días (hay partido el ${fmtMatchDate(o.match_date)}). Marca «Programar igualmente» para pasarlo por alto.` };
    }
  }
  // Pista ocupada: mismo día, misma pista y misma hora efectiva (franja u hora libre).
  const keyOf = (m) => (m.slot_id || '') + '|' + (m.custom_time || '');
  const myKey = (effSlot || '') + '|' + (cTime || '');
  const clash = mdb.prepare(
    'SELECT slot_id, custom_time FROM midday_matches WHERE draw_id = ? AND id != ? AND match_date = ? AND court_no = ?'
  ).all(draw.id, matchId, iso, cn).some(m => keyOf(m) === myKey);
  if (clash) return { ok: false, error: 'Esa pista ya está ocupada en esa fecha y hora.' };
  mdb.prepare('UPDATE midday_matches SET match_date = ?, slot_id = ?, custom_time = ?, court_no = ?, manual = 1 WHERE id = ?')
    .run(iso, effSlot, cTime, cn, matchId);
  return { ok: true, forced: force || !!cTime };
}

// Avisos para la revisión del admin: partidos sin programar y parejas con
// restricciones que impiden programar (todas las franjas en 'no').
// Explica por qué un partido no encontró hueco (para mostrarlo en el panel).
function diagnoseUnscheduled(p1, p2, settings) {
  const slots = settings.slots || [];
  const avail = (p) => slots.filter(s => ((p.slotPrefs || {})[s.id] || 'ok') !== 'no');
  const aA = avail(p1), aB = avail(p2);
  const common = aA.filter(s => aB.some(x => x.id === s.id));
  const lbl = (arr) => arr.length ? arr.map(s => s.label).join(' y ') : 'ninguna';
  const pn = (p) => `${p.player1_name} / ${p.player2_name}`;
  if (!common.length)
    return `${pn(p1)} solo puede en ${lbl(aA)} y ${pn(p2)} solo en ${lbl(aB)}: no comparten franja. Habla con ellos para flexibilizar alguna franja o muévelo a mano.`;
  const wd = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const aW = wd.filter(w => !(p1.weekdaysOff || []).includes(w));
  const bW = wd.filter(w => !(p2.weekdaysOff || []).includes(w));
  const commonW = aW.filter(w => bW.includes(w));
  if (!commonW.length)
    return `${pn(p1)} y ${pn(p2)} no comparten ningún día de semana por sus días vetados.`;
  return `Con las franjas y días disponibles no se encontró hueco en 12 semanas (descanso mínimo de ${settings.minDays || 0} días entre partidos y ocupación de pistas). Intenta moverlo a mano.`;
}
function drawWarnings(mdb, drawId, settings) {
  const draw = getDraw(mdb, drawId);
  const matches = draw ? drawMatches(mdb, drawId) : [];
  const pairsById = {};
  if (draw) for (const p of M.listPairs(mdb, draw.tournament_id)) pairsById[p.id] = p;
  const unscheduled = matches.filter(m => !m.match_date).map(m => ({
    ...m,
    reason: (pairsById[m.pair1_id] && pairsById[m.pair2_id])
      ? diagnoseUnscheduled(pairsById[m.pair1_id], pairsById[m.pair2_id], settings)
      : 'Pareja no encontrada.',
  }));
  const hard = [];
  if (draw && settings.slots.length) {
    for (const p of M.listPairs(mdb, draw.tournament_id)) {
      if (p.status !== 'approved') continue;
      const allNo = settings.slots.every(s => ((p.slotPrefs || {})[s.id] || 'ok') === 'no');
      if (allNo) hard.push({ pair: p, reason: 'ha marcado todas las franjas como imposibles' });
    }
  }
  return { unscheduled, hard };
}

function publishDraw(mdb, drawId) {
  const draw = getDraw(mdb, drawId);
  if (!draw) return { ok: false, error: 'Sorteo no encontrado.' };
  if (draw.status === 'published') return { ok: false, error: 'El calendario ya está publicado.' };
  const params = { ...(draw.params || {}), published_at: new Date().toISOString() };
  mdb.prepare("UPDATE midday_draws SET status = 'published', params = ? WHERE id = ?")
    .run(JSON.stringify(params), drawId);
  return { ok: true };
}
function setDrawEmailSummary(mdb, drawId, summary) {
  const draw = getDraw(mdb, drawId);
  if (!draw) return;
  const params = { ...(draw.params || {}), email_summary: summary };
  mdb.prepare('UPDATE midday_draws SET params = ? WHERE id = ?').run(JSON.stringify(params), drawId);
}

// ---------- email (Brevo; mismo mecanismo que los recordatorios de reservas) ----------
// NOTA: helper propio del módulo de mediodía para no tocar el de reservas;
// usa las mismas variables de entorno (BREVO_API_KEY, MAIL_FROM).
// Para probar sin enviar correos reales: MIDDAY_EMAIL_LOG=/ruta/fichero.log
// vuelca cada email como una línea JSON en vez de llamar a Brevo.
async function sendMiddayEmail(to, subject, html) {
  const logFile = process.env.MIDDAY_EMAIL_LOG;
  if (logFile) {
    require('fs').appendFileSync(logFile,
      JSON.stringify({ to, subject, html, at: new Date().toISOString() }) + '\n');
    return { ok: true, logged: true };
  }
  const key = process.env.BREVO_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) return { skipped: true };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: from, name: 'MEDIODÍA PADEL' },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error('Brevo respondió ' + res.status);
  return { ok: true };
}

// Orden de revisión para el admin: primero los sin programar (los que
// necesitan su atención), luego por ronda y fecha.
function compareForReview(a, b) {
  const pa = a.match_date ? 1 : 0, pb = b.match_date ? 1 : 0;
  if (pa !== pb) return pa - pb;
  if (a.round_no !== b.round_no) return a.round_no - b.round_no;
  const da = a.match_date || '', db = b.match_date || '';
  if (da !== db) return da < db ? -1 : 1;
  return a.id - b.id;
}
// Etiqueta de hora de un partido: hora libre manual o etiqueta de la franja.
function matchSlotLabel(m, slots) {
  if (m && m.custom_time) return m.custom_time;
  const s = (slots || []).find(x => x.id === (m && m.slot_id));
  return s ? s.label : ((m && m.slot_id) || '—');
}
// Guarda en bloque los retoques del admin: changes = [{ id, iso, slotId,
// customTime, courtNo }]. Las filas sin fecha se dejan como están y las que
// no cambian se omiten. Devuelve resultados por partido para mostrarlos en
// la vista (los que van bien y los que dan error).
function bulkReschedule(mdb, drawId, changes, settings, opts = {}) {
  const { force = false } = opts;
  const byId = {};
  for (const m of mdb.prepare('SELECT * FROM midday_matches WHERE draw_id = ?').all(drawId)) byId[m.id] = m;
  const results = {};
  let changed = 0, okCount = 0;
  for (const c of changes) {
    const cur = byId[c.id];
    if (!cur) { results[c.id] = { ok: false, error: 'Partido no encontrado.' }; continue; }
    const iso = (c.iso || '').trim();
    if (!iso) continue; // sin fecha = no tocar
    const cTime = (c.customTime || '').trim() || null;
    const slotId = cTime ? null : (c.slotId || cur.slot_id);
    const courtNo = (c.courtNo === undefined || c.courtNo === '' || c.courtNo === null) ? cur.court_no : c.courtNo;
    const same = cur.match_date === iso && (cur.slot_id || null) === (slotId || null) &&
      (cur.custom_time || null) === cTime && Number(cur.court_no) === Number(courtNo);
    if (same) continue;
    changed++;
    const r = rescheduleMatch(mdb, c.id, iso, slotId, courtNo, settings, { force, customTime: cTime });
    results[c.id] = r;
    if (r.ok) okCount++;
  }
  return { results, changed, ok: okCount, errors: changed - okCount };
}
module.exports = {
  parseISODate, addDaysISO, diffDaysISO, weekdayNum, isWeekdayISO, fmtMatchDate,
  potSizes, buildPots, circleRounds, interleavePots,
  buildDraw, deleteDraw, getDraw, drawForTournament, drawPots, drawMatches, pairMatches,
  canPlayOn, scheduleDraw, rescheduleMatch, bulkReschedule, drawWarnings, matchSlotLabel, compareForReview,
  publishDraw, setDrawEmailSummary, sendMiddayEmail,
};
