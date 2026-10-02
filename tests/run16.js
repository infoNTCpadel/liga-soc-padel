// MEDIODÍA PADEL — Fase B: sorteo por bombos + calendario + publicación + email de pruebas.
// Uso: node tests/run16.js
// Fija DATA_DIR a directorios temporales; no toca data/ real.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const LIB_DIR = '/tmp/mid16-lib';
const HTTP_DIR = '/tmp/mid16-http';
const EMAIL_LOG = '/tmp/mid16-emails.log';
for (const d of [LIB_DIR, HTTP_DIR]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
fs.rmSync(EMAIL_LOG, { force: true });

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + ` (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`);

process.env.DATA_DIR = LIB_DIR;
const DB = require('../src/db');
const M = require('../src/lib/midday');
const D = require('../src/lib/midday-draw');
const bcrypt = require('bcryptjs');
DB.setAdminHash(bcrypt.hashSync('test1234', 8));
const mdb = DB.middayDb;

// ---------- 1. Tablas nuevas + ajustes nuevos ----------
for (const t of ['midday_draws', 'midday_draw_pots', 'midday_matches']) {
  ok(!!mdb.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), `tabla ${t} existe`);
}
const sd = DB.middayGet('start_date', '', 1);
const nm = DB.nextMondayISO();
eq(sd, nm, 'start_date se siembra con el próximo lunes por defecto');
{
  const [y, mo, da] = nm.split('-').map(Number);
  ok(new Date(y, mo - 1, da).getDay() === 1, 'start_date es lunes');
  ok(nm > new Date().toISOString().slice(0, 10), 'start_date es futura');
}
eq(DB.middayGet('test_email', '', 1), '', 'test_email vacío por defecto');
M.setTournamentStatus(mdb, 1, 'active');

// ---------- 2. Helper para crear parejas aprobadas ----------
let pairSeq = 0;
function mkPair(avg, opts = {}) {
  pairSeq++;
  const lvl = Math.round(avg * 4) / 4; // paso de 0,5
  const code = 'T16' + String(pairSeq).padStart(4, '0');
  const r = mdb.prepare(`INSERT INTO midday_pairs(code, tournament_id, player1_name, player1_email, player1_phone,
    player2_name, player2_email, player2_phone, level1, level2, level_avg, slot_prefs, weekdays_off, blackout_dates, status)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, 1, opts.n1 || ('Jug' + pairSeq + 'A'), opts.e1 || '', '600' + String(10000 + pairSeq),
      opts.n2 || ('Jug' + pairSeq + 'B'), opts.e2 || '', '611' + String(10000 + pairSeq),
      lvl, lvl, lvl,
      JSON.stringify(opts.slotPrefs || {}), JSON.stringify(opts.weekdaysOff || []), JSON.stringify(opts.blackout || []),
      opts.status || 'approved');
  return Number(r.lastInsertRowid);
}

// ---------- 3. Bombos: 8 parejas → 4×2, bombo 1 = más nivel ----------
const avgs = [7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5];
for (const a of avgs) mkPair(a);
const pots = D.buildPots(mdb, 1);
eq(pots.map(p => p.pairs.length), [2, 2, 2, 2], 'bombos 4×2');
{
  const lvl = (p) => p.pairs.map(x => x.level_avg);
  const p1 = lvl(pots[0]).sort((a, b) => b - a), p4 = lvl(pots[3]).sort((a, b) => b - a);
  ok(Math.min(...p1) >= Math.max(...lvl(pots[1])) &&
     Math.min(...lvl(pots[1])) >= Math.max(...lvl(pots[2])) &&
     Math.min(...lvl(pots[2])) >= Math.max(...p4), 'bombos ordenados por nivel descendente');
  eq(p1, [7, 6.5], 'bombo 1 = las dos de más nivel');
  eq(p4, [4, 3.5], 'bombo 4 = las dos de menos nivel');
}

// ---------- 4. Emparejamientos para N = 4,5,6,7,8,10,12 ----------
function opponentsPerPair(drawId, roundsLimit) {
  const map = new Map();
  for (const m of mdb.prepare(`SELECT round_no, pair1_id, pair2_id FROM midday_matches WHERE draw_id = ? AND round_no <= ?`).all(drawId, roundsLimit)) {
    for (const [a, b] of [[m.pair1_id, m.pair2_id], [m.pair2_id, m.pair1_id]]) {
      if (!map.has(a)) map.set(a, []);
      map.get(a).push(b);
    }
  }
  return map;
}
const expectedK = { 4: 6, 5: 8, 6: 8, 7: 7, 8: 7, 10: 8, 12: 8 };
const legRounds = (N) => (N % 2 === 0 ? N - 1 : N);
mdb.prepare(`DELETE FROM midday_pairs WHERE tournament_id = 1`).run(); // empezar de cero en la edición 1
let added = 0;
for (const N of [4, 5, 6, 7, 8, 10, 12]) {
  while (added < N) { mkPair(added < 8 ? avgs[added] : 4); added++; }
  const dr = D.buildDraw(mdb, 1);
  eq(dr.rounds, expectedK[N], `N=${N}: K=${expectedK[N]} rondas`);
  const R = legRounds(N);
  eq(dr.legs, R >= 6 ? 1 : 2, `N=${N}: legs correcto`);
  const counts = {};
  for (const m of mdb.prepare(`SELECT pair1_id, pair2_id FROM midday_matches WHERE draw_id = ?`).all(dr.id)) {
    counts[m.pair1_id] = (counts[m.pair1_id] || 0) + 1;
    counts[m.pair2_id] = (counts[m.pair2_id] || 0) + 1;
  }
  const vals = Object.values(counts);
  ok(vals.length === N, `N=${N}: las ${N} parejas juegan`);
  ok(vals.every(c => c >= 6), `N=${N}: cada pareja juega ≥6 (máx ${Math.max(...vals)})`);
  const opps = opponentsPerPair(dr.id, R);
  ok([...opps.values()].every(list => new Set(list).size === list.length),
    `N=${N}: sin rivales repetidos dentro de la misma vuelta`);
}

// ---------- 5. N=3 → error; N=4 en edición nueva ----------
{
  const r2 = M.createTournament(mdb, 'Ed pequeña', null, DB.MIDDAY_DEFAULTS);
  M.setTournamentStatus(mdb, r2.id, 'active');
  const ins = mdb.prepare(`INSERT INTO midday_pairs(code, tournament_id, player1_name, player1_phone, player2_name, player2_phone, level1, level2, level_avg, status)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`);
  ins.run('E2001', r2.id, 'A1', '6001', 'A2', '6002', 4, 4, 4);
  ins.run('E2002', r2.id, 'B1', '6003', 'B2', '6004', 4, 4, 4);
  ins.run('E2003', r2.id, 'C1', '6005', 'C2', '6006', 4, 4, 4);
  let err = '';
  try { D.buildDraw(mdb, r2.id); } catch (e) { err = e.message; }
  ok(/al menos 4/.test(err), `N=3 → error ("${err}")`);
  ins.run('E2004', r2.id, 'D1', '6007', 'D2', '6008', 4, 4, 4);
  const dr4 = D.buildDraw(mdb, r2.id);
  eq(dr4.rounds, 6, 'N=4: K=6 (doble vuelta)');
  eq(dr4.legs, 2, 'N=4: legs=2');
  const counts = {};
  for (const m of mdb.prepare(`SELECT pair1_id, pair2_id FROM midday_matches WHERE draw_id = ?`).all(dr4.id)) {
    counts[m.pair1_id] = (counts[m.pair1_id] || 0) + 1;
    counts[m.pair2_id] = (counts[m.pair2_id] || 0) + 1;
  }
  ok(Object.values(counts).every(c => c === 6), 'N=4: cada pareja juega 6');
}

// ---------- 6. Guardas: edición no activa / sorteo ya publicado / publicado bloquea regenerar ----------
{
  const r3 = M.createTournament(mdb, 'Ed cerrada', null, DB.MIDDAY_DEFAULTS); // queda en 'inscription'
  let err = '';
  try { D.buildDraw(mdb, r3.id); } catch (e) { err = e.message; }
  ok(/En marcha/.test(err), `edición no activa → error ("${err}")`);
  // La edición 1 quedó finalizada al crear r2; reactivamos una edición limpia para la guarda de publicado.
  const r4 = M.createTournament(mdb, 'Ed pub', null, DB.MIDDAY_DEFAULTS);
  M.setTournamentStatus(mdb, r4.id, 'active');
  const ins = mdb.prepare(`INSERT INTO midday_pairs(code, tournament_id, player1_name, player1_phone, player2_name, player2_phone, level1, level2, level_avg, status)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`);
  for (let i = 1; i <= 4; i++) ins.run('P' + i, r4.id, 'J' + i + 'a', '6' + i, 'J' + i + 'b', '7' + i, 4, 4, 4);
  const dr = D.buildDraw(mdb, r4.id);
  const pub1 = D.publishDraw(mdb, dr.id);
  ok(pub1.ok, 'publicar borrador → ok');
  err = '';
  try { D.buildDraw(mdb, r4.id); } catch (e) { err = e.message; }
  ok(/publicado/.test(err), `regenerar con publicado → error ("${err}")`);
  const pub2 = D.publishDraw(mdb, dr.id);
  ok(!pub2.ok && /publicado/.test(pub2.error || ''), `publicar dos veces → error ("${pub2.error}")`);
}

// ---------- 7. Scheduler: restricciones con 8 parejas y 4 pistas ----------
const r5 = M.createTournament(mdb, 'Ed restricciones', null, DB.MIDDAY_DEFAULTS);
M.setTournamentStatus(mdb, r5.id, 'active');
const sd5 = DB.nextMondayISO();
DB.middaySet('start_date', sd5, r5.id);
DB.middaySet('slots', JSON.stringify([{ id: 's1', label: '13:00' }, { id: 's2', label: '14:30' }]), r5.id);
DB.middaySet('courts_midday', '4', r5.id);
DB.middaySet('min_days_between', '4', r5.id);
const blackout = D.addDaysISO(sd5, 7);
let pseq = 0;
const insPair = (avg, n1, n2, prefs, off, blk) => {
  pseq++;
  const r = mdb.prepare(`INSERT INTO midday_pairs(code, tournament_id, player1_name, player1_phone, player2_name, player2_phone,
    level1, level2, level_avg, slot_prefs, weekdays_off, blackout_dates, status)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`).run(
    'R5' + pseq, r5.id, n1, '6001', n2, '6002', avg, avg, avg,
    JSON.stringify(prefs || {}), JSON.stringify(off || []), JSON.stringify(blk || []));
  return Number(r.lastInsertRowid);
};
const pA = insPair(6, 'Pa', 'Paa', {}, ['mon'], []);            // vetado los lunes
const pB = insPair(5.5, 'Pb', 'Pbb', { s1: 'no', s2: 'pref' }, [], []); // franja s1 = no
const pC = insPair(5, 'Pc', 'Pcc', {}, [], [blackout]);          // blackout en una fecha
const pD = insPair(4.5, 'Pd', 'Pdd');
const pE = insPair(4, 'Pe', 'Pee');
const pF = insPair(3.5, 'Pf', 'Pff');
const pG = insPair(3, 'Pg', 'Pgg');
const pH = insPair(2.5, 'Ph', 'Phh');
const dr5 = D.buildDraw(mdb, r5.id);
eq(dr5.rounds, 7, 'N=8: 7 rondas');
const all5 = mdb.prepare(`SELECT * FROM midday_matches WHERE draw_id = ?`).all(dr5.id);
eq(all5.length, 28, 'N=8: 28 partidos');
ok(all5.every(m => m.match_date && m.slot_id && m.court_no), 'todo programado (fecha, franja, pista)');
{
  const wd = (d) => { const [y, mo, da] = String(d || '').split('-').map(Number); return new Date(y, mo - 1, da).getDay(); };
  ok(all5.every(m => m.match_date && wd(m.match_date) >= 1 && wd(m.match_date) <= 5), 'nunca sábado ni domingo');
  const byPair = new Map();
  for (const m of all5) for (const pid of [m.pair1_id, m.pair2_id]) {
    if (!byPair.has(pid)) byPair.set(pid, []);
    byPair.get(pid).push(m);
  }
  ok(byPair.get(pA).every(m => wd(m.match_date) !== 1), 'pareja con lunes vetado nunca juega en lunes');
  ok(byPair.get(pB).every(m => m.slot_id !== 's1'), "pareja con franja 'no' nunca juega en esa franja");
  ok(byPair.get(pC).every(m => m.match_date !== blackout), 'blackout_dates se respeta');
  for (const [pid, ms] of byPair) {
    const ds = ms.map(m => m.match_date).sort();
    ok(ds.every((d, i) => i === 0 || D.diffDaysISO(ds[i - 1], d) >= 4), `min_days_between en la pareja ${pid}`);
  }
  const used = new Set();
  let clash = false;
  for (const m of all5) {
    const k = m.match_date + '|' + m.slot_id + '|' + m.court_no;
    if (used.has(k)) clash = true;
    used.add(k);
  }
  ok(!clash, 'nunca dos partidos en la misma pista, fecha y franja');
  const perSlot = new Map();
  for (const m of all5) {
    const k = m.match_date + '|' + m.slot_id;
    perSlot.set(k, Math.max(perSlot.get(k) || 0, m.court_no));
  }
  ok([...perSlot.values()].every(c => c <= 4), 'capacidad de 4 pistas por franja');
}

// ---------- 8. Reprogramar partido (validación; devuelve {ok, error}) ----------
{
  const st5 = M.getSettings(mdb, r5.id);
  const m0 = mdb.prepare(`SELECT * FROM midday_matches WHERE draw_id = ? ORDER BY match_date, slot_id LIMIT 1`).get(dr5.id);
  const freeCourt = (dateISO, slotId, excludeId) => {
    for (let c = 1; c <= 4; c++) {
      const taken = mdb.prepare(`SELECT 1 FROM midday_matches WHERE draw_id = ? AND id != ? AND match_date = ? AND slot_id = ? AND court_no = ?`)
        .get(dr5.id, excludeId, dateISO, slotId, c);
      if (!taken) return c;
    }
    return null;
  };
  // mover válido: mismo día de semana, 5 semanas después del último partido de sus parejas, pista libre
  const lastD = mdb.prepare(`SELECT MAX(match_date) md FROM midday_matches WHERE draw_id = ? AND (pair1_id IN (?, ?) OR pair2_id IN (?, ?))`)
    .get(dr5.id, m0.pair1_id, m0.pair2_id, m0.pair1_id, m0.pair2_id).md;
  const tgt = D.addDaysISO(lastD, 35);
  const fc = freeCourt(tgt, m0.slot_id, m0.id);
  const rOk = fc ? D.rescheduleMatch(mdb, m0.id, tgt, m0.slot_id, fc, st5) : { ok: false, error: 'sin pista libre' };
  ok(rOk.ok, 'retoque válido se aplica' + (rOk.error ? ` (${rOk.error})` : ''));
  ok(mdb.prepare('SELECT match_date FROM midday_matches WHERE id = ?').get(m0.id).match_date === tgt, 'la fecha queda actualizada');
  // sábado → error
  const sat = D.addDaysISO(sd5, 5); // primer sábado desde el lunes de inicio
  const rSat = D.rescheduleMatch(mdb, m0.id, sat, m0.slot_id, m0.court_no, st5);
  ok(!rSat.ok && /lunes a viernes/.test(rSat.error || ''), `mover a sábado → error ("${rSat.error}")`);
  // choque de pista → error (mover otro partido al hueco exacto de uno existente)
  const allm = mdb.prepare(`SELECT * FROM midday_matches WHERE draw_id = ? AND match_date IS NOT NULL`).all(dr5.id);
  const pb5 = Object.fromEntries(M.listPairs(mdb, r5.id).map(p => [p.id, p]));
  let O = null, C = null;
  outer:
  for (const c of allm) {
    for (const o of allm) {
      if (o.id === c.id || o.id === m0.id) continue;
      const op1 = pb5[o.pair1_id], op2 = pb5[o.pair2_id];
      if (!D.canPlayOn(op1, c.match_date, c.slot_id) || !D.canPlayOn(op2, c.match_date, c.slot_id)) continue;
      let okd = true;
      for (const m2 of allm) {
        if (m2.id === o.id) continue;
        const inv = [m2.pair1_id, m2.pair2_id];
        if (inv.includes(o.pair1_id) || inv.includes(o.pair2_id)) {
          if (Math.abs(D.diffDaysISO(m2.match_date, c.match_date)) < 4) { okd = false; break; }
        }
      }
      if (!okd) continue;
      O = o; C = c; break outer;
    }
  }
  ok(O && C, 'se encuentra un caso de choque de pista aislado');
  const other = O || allm[0];
  const rClash = (O && C) ? D.rescheduleMatch(mdb, O.id, C.match_date, C.slot_id, C.court_no, st5) : { ok: true, error: '' };
  ok(!rClash.ok && /ocupada/.test(rClash.error || ''), `mover a pista ocupada → error ("${rClash.error}")`);
  // min_days_between → error (mover al día laborable adyacente de otro partido de la misma pareja)
  const mine = mdb.prepare(`SELECT * FROM midday_matches WHERE draw_id = ? AND id != ? AND (pair1_id = ? OR pair2_id = ?) LIMIT 1`)
    .get(dr5.id, other.id, other.pair1_id, other.pair1_id);
  let rMin = { ok: true, error: '' };
  if (mine) {
    const wdm = ((d) => { const [y, mo, da] = d.split('-').map(Number); return new Date(y, mo - 1, da).getDay(); })(mine.match_date);
    const nextDay = D.addDaysISO(mine.match_date, wdm <= 3 ? 1 : -1);
    const fc2 = freeCourt(nextDay, other.slot_id, other.id);
    if (fc2) rMin = D.rescheduleMatch(mdb, other.id, nextDay, other.slot_id, fc2, st5);
  }
  ok(!rMin.ok && /descanso/.test(rMin.error || ''), `mover violando min_days_between → error ("${rMin.error}")`);
  // franja 'no' → error (mover un partido de pB a s1, con pista libre para aislar la causa)
  const mb = mdb.prepare(`SELECT * FROM midday_matches WHERE draw_id = ? AND (pair1_id = ? OR pair2_id = ?) LIMIT 1`).get(dr5.id, pB, pB);
  const fc3 = freeCourt(mb.match_date, 's1', mb.id);
  const rSlot = fc3 ? D.rescheduleMatch(mdb, mb.id, mb.match_date, 's1', fc3, st5) : { ok: true, error: '' };
  ok(!rSlot.ok && /no puede jugar/.test(rSlot.error || ''), `mover a franja vetada → error ("${rSlot.error}")`);
  // forzar: el mismo movimiento vetado con force → se aplica y queda marcado
  const rForce = fc3 ? D.rescheduleMatch(mdb, mb.id, mb.match_date, 's1', fc3, st5, { force: true }) : { ok: false };
  ok(rForce.ok, `forzar movimiento a franja vetada → se aplica${rForce.error ? ` (${rForce.error})` : ''}`);
  const mForced = mdb.prepare('SELECT * FROM midday_matches WHERE id = ?').get(mb.id);
  ok(mForced.manual === 1 && mForced.slot_id === 's1', 'partido forzado queda marcado como manual');
  ok(D.matchSlotLabel(mForced, st5.slots).includes('13'), `etiqueta de franja con slot → "${D.matchSlotLabel(mForced, st5.slots)}"`);
  // hora libre: 12:30 fuera de las franjas configuradas (pista 4 libre ese día)
  let mc = null;
  for (const c of mdb.prepare(`SELECT * FROM midday_matches WHERE draw_id = ? AND match_date IS NOT NULL`).all(dr5.id)) {
    const taken = mdb.prepare(`SELECT 1 FROM midday_matches WHERE draw_id = ? AND id != ? AND match_date = ? AND court_no = 4`).get(dr5.id, c.id, c.match_date);
    if (!taken) { mc = c; break; }
  }
  const rCustom = mc ? D.rescheduleMatch(mdb, mc.id, mc.match_date, null, 4, st5, { customTime: '12:30' }) : { ok: false };
  ok(rCustom.ok, `hora libre 12:30 → se aplica${rCustom.error ? ` (${rCustom.error})` : ''}`);
  const mCustom = mc ? mdb.prepare('SELECT * FROM midday_matches WHERE id = ?').get(mc.id) : null;
  ok(mCustom && mCustom.custom_time === '12:30' && mCustom.slot_id === null && mCustom.manual === 1, 'hora libre guardada con manual=1');
  ok(mCustom && D.matchSlotLabel(mCustom, st5.slots) === '12:30', 'etiqueta muestra la hora libre');
  // choque con la misma hora libre → error; otra hora libre en la misma pista → ok
  const mc2 = mc ? mdb.prepare(`SELECT * FROM midday_matches WHERE draw_id = ? AND id != ? AND match_date IS NOT NULL LIMIT 1`).get(dr5.id, mc.id) : null;
  let rClashC = { ok: true }, rFreeC = { ok: false };
  if (mc && mc2) {
    rClashC = D.rescheduleMatch(mdb, mc2.id, mc.match_date, null, 4, st5, { force: true, customTime: '12:30' });
    rFreeC = D.rescheduleMatch(mdb, mc2.id, mc.match_date, null, 4, st5, { force: true, customTime: '13:45' });
  }
  ok(!rClashC.ok && /ocupada/.test(rClashC.error || ''), `misma hora libre y pista → error ("${rClashC.error}")`);
  ok(rFreeC.ok, 'otra hora libre en la misma pista → se aplica');
  // hora libre inválida → error
  const rBadTime = mc ? D.rescheduleMatch(mdb, mc.id, mc.match_date, null, 4, st5, { customTime: '25:99' }) : { ok: true };
  ok(!rBadTime.ok, 'hora libre inválida → error');
  // 8b. Guardado en bloque: omite sin-cambios y sin-fecha; veto blando sin force → error en resultados
  const b1 = mdb.prepare(`SELECT * FROM midday_matches WHERE draw_id = ? AND id NOT IN (?, ?, ?) AND match_date IS NOT NULL LIMIT 1`).get(dr5.id, mb.id, mc.id, mc2.id);
  const b2 = mdb.prepare(`SELECT * FROM midday_matches WHERE draw_id = ? AND id NOT IN (?, ?, ?, ?) AND match_date IS NOT NULL LIMIT 1`).get(dr5.id, mb.id, mc.id, mc2.id, b1.id);
  let fd = D.addDaysISO(mb.match_date, 210);
  while (!D.isWeekdayISO(fd)) fd = D.addDaysISO(fd, 1); // día laborable fuera del calendario
  const rb1 = D.bulkReschedule(mdb, dr5.id, [
    { id: b1.id, iso: b1.match_date, slotId: b1.slot_id, customTime: b1.custom_time, courtNo: b1.court_no }, // sin cambios
    { id: b2.id, iso: '', slotId: 's1', courtNo: 1 }, // sin fecha
    { id: mb.id, iso: fd, slotId: 's1', customTime: null, courtNo: 1 }, // vetado para pB
  ], st5, {});
  ok(rb1.changed === 1 && !(b1.id in rb1.results) && !(b2.id in rb1.results),
    'bulk omite filas sin cambios y sin fecha');
  ok(rb1.ok === 0 && rb1.errors === 1 && rb1.results[mb.id] && !rb1.results[mb.id].ok && rb1.results[mb.id].soft,
    `bulk: cambio vetado sin force → error blando en resultados ("${rb1.results[mb.id] && rb1.results[mb.id].error}")`);
  const rb2 = D.bulkReschedule(mdb, dr5.id, [
    { id: mb.id, iso: fd, slotId: 's1', customTime: null, courtNo: 1 },
  ], st5, { force: true });
  ok(rb2.ok === 1 && rb2.errors === 0, 'bulk con force → se aplica');
  const mbBulk = mdb.prepare('SELECT * FROM midday_matches WHERE id = ?').get(mb.id);
  ok(mbBulk.match_date === fd && mbBulk.manual === 1, 'bulk actualiza fecha y marca manual');
}

// ---------- 9. Avisos: partidos sin programar + restricciones duras ----------
{
  const r6 = M.createTournament(mdb, 'Ed avisos', null, DB.MIDDAY_DEFAULTS);
  M.setTournamentStatus(mdb, r6.id, 'active');
  DB.middaySet('start_date', DB.nextMondayISO(), r6.id);
  DB.middaySet('courts_midday', '1', r6.id); // 1 sola pista → congestión
  const ins = mdb.prepare(`INSERT INTO midday_pairs(code, tournament_id, player1_name, player1_phone, player2_name, player2_phone,
    level1, level2, level_avg, slot_prefs, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`);
  for (let i = 1; i <= 8; i++) {
    const prefs = i === 8 ? { s1: 'no', s2: 'no', s3: 'no' } : {};
    ins.run('W' + i, r6.id, 'X' + i + 'a', '60' + i, 'X' + i + 'b', '61' + i, 4, 4, 4, JSON.stringify(prefs));
  }
  const dr = D.buildDraw(mdb, r6.id);
  const w = D.drawWarnings(mdb, dr.id, M.getSettings(mdb, r6.id));
  const hardPid = mdb.prepare(`SELECT id FROM midday_pairs WHERE code = 'W8' AND tournament_id = ?`).get(r6.id).id;
  ok(w.hard.some(h => h.pair.id === hardPid), 'aviso de restricción dura para la pareja sin franjas');
  ok(w.unscheduled.length > 0, `partidos sin programar con 1 pista (${w.unscheduled.length})`);
  ok(w.unscheduled.every(m => typeof m.reason === 'string' && m.reason.length > 10),
    'cada partido sin programar trae su motivo explicado');
  // capacidad: como mucho 1 partido por (fecha, franja)
  const seen = new Set(); let clash = false;
  for (const m of mdb.prepare(`SELECT * FROM midday_matches WHERE draw_id = ? AND match_date IS NOT NULL`).all(dr.id)) {
    const k = m.match_date + '|' + m.slot_id + '|' + m.court_no;
    if (seen.has(k)) clash = true;
    seen.add(k);
  }
  ok(!clash, 'con 1 pista no hay choques');
}
{ // Diagnóstico dirigido: dos parejas con franjas disjuntas no pueden enfrentarse
  const r7 = M.createTournament(mdb, 'Ed diag', null, DB.MIDDAY_DEFAULTS);
  M.setTournamentStatus(mdb, r7.id, 'active');
  DB.middaySet('start_date', DB.nextMondayISO(), r7.id);
  const ins = mdb.prepare(`INSERT INTO midday_pairs(code, tournament_id, player1_name, player1_phone, player2_name, player2_phone,
    level1, level2, level_avg, slot_prefs, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`);
  ins.run('D1', r7.id, 'A1', '600', 'A2', '601', 4, 4, 4, JSON.stringify({ s1: 'no' }));
  ins.run('D2', r7.id, 'B1', '602', 'B2', '603', 4, 4, 4, JSON.stringify({ s2: 'no' }));
  ins.run('D3', r7.id, 'C1', '604', 'C2', '605', 4, 4, 4, '{}');
  ins.run('D4', r7.id, 'E1', '606', 'E2', '607', 4, 4, 4, '{}');
  const dr = D.buildDraw(mdb, r7.id);
  const w = D.drawWarnings(mdb, dr.id, M.getSettings(mdb, r7.id));
  const gid = (code) => mdb.prepare('SELECT id FROM midday_pairs WHERE code = ? AND tournament_id = ?').get(code, r7.id).id;
  const d1 = gid('D1'), d2 = gid('D2');
  const ab = w.unscheduled.find(m =>
    (m.pair1_id === d1 && m.pair2_id === d2) || (m.pair1_id === d2 && m.pair2_id === d1));
  ok(!!ab, 'el partido A1/A2 vs B1/B2 queda sin programar por franjas disjuntas');
  ok(!!ab && /no comparten franja/.test(ab.reason),
    'el motivo explica que no hay franja común' + (ab ? ` («${ab.reason.slice(0, 50)}…»)` : ''));
}
console.log(`lib: ${pass} OK, ${fail} fallos`);

// ---------- 10. HTTP: generar → publicar (modo pruebas) → mis-partidos ----------
function httpreq({ port, host, path = '/', method = 'GET', body = null, cookie = null }) {
  const httpMod = require('http');
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    let payload = null;
    if (body) {
      payload = body;
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) headers.Cookie = cookie;
    const req = httpMod.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const jar = (r) => (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

function setupHttpDb() {
  const script = `
const bcrypt = require('bcryptjs');
const DB = require('${path.join(__dirname, '..', 'src', 'db')}');
const M = require('${path.join(__dirname, '..', 'src', 'lib', 'midday')}');
DB.setAdminHash(bcrypt.hashSync('test1234', 8));
const r = M.createTournament(DB.middayDb, 'Edición HTTP', null, DB.MIDDAY_DEFAULTS);
M.setTournamentStatus(DB.middayDb, r.id, 'active');
DB.middaySet('inscription_deadline', '2026-09-30', r.id); // inscripción cerrada: la landing puede avisar del calendario
const names = [['Ana','Luis'],['Mar','Pau'],['Iris','Pol'],['Laia','Nil'],['Júlia','Quim'],['Aina','Oriol'],['Clara','Roc'],['Nora','Iu']];
const ins = DB.middayDb.prepare("INSERT INTO midday_pairs(code, tournament_id, player1_name, player1_email, player1_phone, player2_name, player2_email, player2_phone, level1, level2, level_avg, status) VALUES(?,?,?,?,?,?,?,?,?, ?,?,'approved')");
names.forEach((n, i) => ins.run('H' + (i + 1), r.id, n[0], n[0].toLowerCase() + '@example.com', '6000000' + i, n[1], n[1].toLowerCase() + '@example.com', '6111111' + i, 3 + (i % 4), 3 + (i % 4), 3 + (i % 4)));
console.log('setup ok, edicion', r.id);
`;
  const r = spawnSync('node', ['-e', script], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, DATA_DIR: HTTP_DIR }, timeout: 60000,
  });
  ok(r.status === 0 && /setup ok/.test(r.stdout || ''), 'setup HTTP de la BD' + (r.status !== 0 ? ` (${(r.stderr || '').slice(-300)})` : ''));
  const m = /edicion (\d+)/.exec(r.stdout || '');
  return m ? Number(m[1]) : null;
}

async function httpDraw() {
  const PORT = 32116;
  const srv = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: HTTP_DIR, PORT: String(PORT), MIDDAY_HOST: 'midday.test', MIDDAY_EMAIL_LOG: EMAIL_LOG },
    stdio: 'ignore',
  });
  let hpass = 0, hfail = 0;
  const hok = (c, n) => { c ? hpass++ : (hfail++, console.log('FALLO HTTP:', n)); };
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try { const r = await httpreq({ port: PORT, host: 'midday.test' }); ready = r.status === 200; }
      catch (e) { await new Promise(r => setTimeout(r, 200)); }
    }
    hok(ready, 'el servidor arranca');

    // login admin
    let r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/login', method: 'POST',
      body: new URLSearchParams({ password: 'test1234' }).toString() });
    const adminCookie = jar(r);
    hok(r.status === 302 && adminCookie, 'login admin → sesión');

    // sorteo: botón generar
    r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/mediodia/sorteo', cookie: adminCookie });
    hok(r.status === 200 && r.body.includes('Generar sorteo'), 'página de sorteo con botón de generar');

    // generar
    r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/mediodia/sorteo/generar', method: 'POST',
      body: new URLSearchParams({ t: String(ED_ID) }).toString(), cookie: adminCookie });
    hok(r.status === 302, 'generar sorteo → 302');
    r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/mediodia/sorteo', cookie: adminCookie });
    hok(r.status === 200 && r.body.includes('Ronda 1') && r.body.includes('Bombo 1'), 'sorteo muestra rondas y bombos');

    // guardado en bloque: mover un partido de fecha de golpe (forzar global)
    const { DatabaseSync: DS2 } = require('node:sqlite');
    const hdb2 = new DS2(path.join(HTTP_DIR, 'midday.db'));
    const hm = hdb2.prepare(`SELECT m.id, d.id AS did FROM midday_matches m JOIN midday_draws d ON d.id = m.draw_id WHERE d.tournament_id = ? LIMIT 1`).get(ED_ID);
    hdb2.close();
    const bd = new Date(); bd.setDate(bd.getDate() + 200);
    while (bd.getDay() === 0 || bd.getDay() === 6) bd.setDate(bd.getDate() + 1);
    const bdate = bd.toISOString().slice(0, 10);
    const bulkBody = new URLSearchParams({ t: String(ED_ID), force_all: '1',
      ['date_' + hm.id]: bdate, ['slot_' + hm.id]: 's1', ['ctime_' + hm.id]: '', ['court_' + hm.id]: '1' }).toString();
    r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/mediodia/sorteo/guardar-todo', method: 'POST',
      body: bulkBody, cookie: adminCookie });
    hok(r.status === 200 && r.body.includes('programado'), 'guardar-todo en bloque → 200 con resumen');
    const hdb3 = new DS2(path.join(HTTP_DIR, 'midday.db'));
    const hm2 = hdb3.prepare(`SELECT match_date, manual FROM midday_matches WHERE id = ?`).get(hm.id);
    hdb3.close();
    hok(hm2.match_date === bdate && hm2.manual === 1, 'guardar-todo aplica el cambio en la BD');

    // pareja: sin publicar no ve partidos
    const { DatabaseSync } = require('node:sqlite');
    const hdb = new DatabaseSync(path.join(HTTP_DIR, 'midday.db'));
    const code = hdb.prepare(`SELECT code FROM midday_pairs WHERE tournament_id = ? AND status = 'approved' LIMIT 1`).get(ED_ID).code;
    hdb.close();
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/acceso', method: 'POST',
      body: new URLSearchParams({ code }).toString() });
    const pairCookie = jar(r);
    hok(r.status === 302 && pairCookie, 'login de pareja con código');
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/mis-partidos', cookie: pairCookie });
    hok(r.status === 200 && r.body.includes('se publicará al cerrar la inscripción') && !r.body.includes('<th>Ronda</th>'),
      'sin publicar: mis-partidos no muestra partidos');
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/' });
    hok(r.status === 200 && !r.body.includes('ya está publicado'), 'landing sin publicar: sin aviso de calendario');

    // ajustes: validación del email de pruebas
    const nm = (() => { const d = new Date(); d.setDate(d.getDate() + 1); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();
    const ajustes = (test_email) => new URLSearchParams({
      t: String(ED_ID), comp_name: 'MEDIODÍA PADEL', slots_text: '13:00\n14:30',
      inscription_open: '2026-10-01', inscription_deadline: '2026-09-30',
      courts_midday: '4', min_days_between: '4', start_date: nm, test_email,
    }).toString();
    r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/mediodia/ajustes', method: 'POST',
      body: ajustes('no-es-email'), cookie: adminCookie });
    hok(r.status === 200 && r.body.includes('email de pruebas'), 'ajustes rechaza email de pruebas inválido');

    // guardar email de pruebas y publicar
    r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/mediodia/ajustes', method: 'POST',
      body: ajustes('test@example.com'), cookie: adminCookie });
    hok(r.status === 302, 'ajustes guarda email de pruebas → 302');
    r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/mediodia/sorteo/publicar', method: 'POST',
      body: new URLSearchParams({ t: String(ED_ID) }).toString(), cookie: adminCookie });
    hok(r.status === 302, 'publicar → 302');

    // los 8 avisos van a la dirección de pruebas con [PRUEBA] y la línea de destinatario
    let lines = [];
    for (let i = 0; i < 20 && lines.length < 8; i++) {
      await new Promise(r2 => setTimeout(r2, 250));
      if (fs.existsSync(EMAIL_LOG)) lines = fs.readFileSync(EMAIL_LOG, 'utf8').trim().split('\n').filter(Boolean);
    }
    hok(lines.length === 8, `8 avisos volcados al log de email (${lines.length})`);
    if (lines.length === 8) {
      const mails = lines.map(l => JSON.parse(l));
      hok(mails.every(m => m.to === 'test@example.com'), 'todos los avisos van a la dirección de pruebas');
      hok(mails.every(m => m.subject.startsWith('[PRUEBA]')), 'asunto con prefijo [PRUEBA]');
      hok(mails.every(m => /Aviso dirigido a: .+ \/ .+/.test(m.html)), 'cuerpo con línea de destinatario real');
    }
    r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/mediodia/sorteo', cookie: adminCookie });
    hok(r.status === 200 && r.body.includes('modo pruebas'), 'panel muestra "modo pruebas" en el resumen de emails');

    // regenerar tras publicar → bloqueado
    r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/mediodia/sorteo/generar', method: 'POST',
      body: new URLSearchParams({ t: String(ED_ID) }).toString(), cookie: adminCookie });
    hok(r.status === 302 && /error/.test(r.headers.location || ''), 'regenerar tras publicar → error controlado');

    // pareja: ahora sí ve sus partidos; la landing avisa
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/mis-partidos', cookie: pairCookie });
    hok(r.status === 200 && r.body.includes('<th>Ronda</th>'), 'mis-partidos muestra partidos publicados');
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/' });
    hok(r.status === 200 && r.body.includes('ya está publicado'), 'landing avisa "calendario publicado"');
  } finally {
    srv.kill('SIGTERM');
  }
  console.log(`http (sorteo): ${hpass} OK, ${hfail} fallos`);
  return hfail;
}

let ED_ID = 1;
(async () => {
  ED_ID = setupHttpDb() || 1;
  const extra = await httpDraw();
  const total = fail + extra;
  console.log(`\nTOTAL run16: ${pass} OK, ${total} fallos`);
  process.exit(total ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
