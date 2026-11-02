// Borrar resultado (admin), filtros de búsqueda en Partidos y acordeón público.
// HTTP + sqlite directo contra una temporada temporal.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const PORT = 3489;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-data38';
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
fs.rmSync(DATA, { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

function makeClient() {
  let cookie = '';
  const req = (m, p, d) => new Promise((res, rej) => {
    let b = null; const h = {};
    if (d) {
      const u = new URLSearchParams();
      for (const k in d) [].concat(d[k]).forEach(v => u.append(k, v));
      b = u.toString(); h['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ port: PORT, path: p, method: m, headers: h }, (rs) => {
      let t = ''; rs.on('data', c => t += c); rs.on('end', () => {
        const sc = rs.headers['set-cookie']; if (sc && sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
        res({ statusCode: rs.statusCode, location: rs.headers.location || '', text: t });
      });
    });
    r.on('error', rej); if (b) r.write(b); r.end();
  });
  return { req };
}
const { DatabaseSync } = require('node:sqlite');
const sdb = (sql, ...p) => { const d = new DatabaseSync(SEASON); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const srun = (sql, ...p) => { const d = new DatabaseSync(SEASON); try { return d.prepare(sql).run(...p); } finally { d.close(); } };
let SEASON = '';

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), pub = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });
  await admin.req('GET', '/admin');
  SEASON = path.join(DATA, fs.readdirSync(DATA).find(f => /^season-\d+\.db$/.test(f)));
  ok(SEASON && fs.existsSync(SEASON), 'existe la BD de temporada');

  // --- datos mínimos: 2 parejas, 1 grupo, 1 partido ---
  const mkPlayer = (name, phone) =>
    srun("INSERT INTO players(name, phone, level, gender, member_no, member_verified) VALUES(?, ?, 3.0, 'M', '1', 1)",
      name, phone).lastInsertRowid;
  const a1 = mkPlayer('Ana Tester', '600000001'), a2 = mkPlayer('Bea Tester', '600000002');
  const b1 = mkPlayer('Carla Tester', '600000003'), b2 = mkPlayer('Dana Tester', '600000004');
  const pairA = srun("INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, level_avg, status) VALUES('AAAA11','M',?,?,?,3.0,'active')", a1, a2, a1).lastInsertRowid;
  const pairB = srun("INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, level_avg, status) VALUES('BBBB22','M',?,?,?,3.0,'active')", b1, b2, b1).lastInsertRowid;
  const gid = srun("INSERT INTO groups(category, round_no, group_no) VALUES('M', 1, 1)").lastInsertRowid;
  srun('INSERT INTO group_members(group_id, pair_id) VALUES(?, ?)', gid, pairA);
  srun('INSERT INTO group_members(group_id, pair_id) VALUES(?, ?)', gid, pairB);
  const mid = srun("INSERT INTO matches(category, stage, round_no, group_id, pair_a_id, pair_b_id) VALUES('M','groups',1,?,?,?)", gid, pairA, pairB).lastInsertRowid;

  const getM = () => sdb('SELECT * FROM matches WHERE id = ?', mid)[0];

  // --- 1. subir resultado y borrarlo ---
  await admin.req('POST', `/admin/partidos/${mid}/resultado`, {
    winner_id: String(pairA), s1a: '6', s1b: '4', s2a: '6', s2b: '3', notes: '', back: '/admin/partidos?stage=groups&category=M&round=1',
  });
  let m = getM();
  ok(m.winner_id === pairA && m.s1a === 6 && m.s2b === 3 && m.validation === 'validated', 'resultado guardado y validado');
  let page = (await admin.req('GET', '/admin/partidos?stage=groups&category=M&round=1')).text;
  ok(page.includes(`/admin/partidos/${mid}/borrar`), 'botón Borrar resultado visible con resultado');
  ok(page.includes('validado'), 'badge de validado visible');

  await admin.req('POST', `/admin/partidos/${mid}/borrar`, { back: '/admin/partidos?stage=groups&category=M&round=1' });
  m = getM();
  ok(m.winner_id === null && m.s1a === null && m.s2b === null, 'sets y ganador borrados');
  ok(m.validation === 'none' && m.submitted_at === null && m.submitted_by === null, 'validación y envío reseteados');
  ok(m.unplayed === 0 && m.court_id === null, 'no jugado a 0; programación intacta (null como antes)');
  page = (await admin.req('GET', '/admin/partidos?stage=groups&category=M&round=1')).text;
  ok(!page.includes(`/admin/partidos/${mid}/borrar`), 'botón oculto sin resultado');
  // la clasificación se recalcula sola (en vivo)
  const pub1 = (await pub.req('GET', '/liga/M/1')).text;
  ok(pub1.includes('>0<') || pub1.includes('Pts'), 'página pública de liga carga tras borrar');

  // --- 2. filtros ---
  await admin.req('POST', `/admin/partidos/${mid}/resultado`, {
    winner_id: String(pairA), s1a: '6', s1b: '4', s2a: '6', s2b: '3', back: '/x',
  });
  let f = (await admin.req('GET', '/admin/partidos?stage=groups&category=M&round=1&q=Ana')).text;
  ok(f.includes('Ana Tester'), 'filtro q=Ana encuentra el partido');
  f = (await admin.req('GET', '/admin/partidos?stage=groups&category=M&round=1&q=zzzsincoincidencia')).text;
  ok(f.includes('No hay partidos.'), 'filtro q sin coincidencias → vacío');
  f = (await admin.req('GET', '/admin/partidos?stage=groups&category=M&round=1&estado=validado')).text;
  ok(f.includes('Ana Tester'), 'filtro estado=validado muestra el partido');
  f = (await admin.req('GET', '/admin/partidos?stage=groups&category=M&round=1&estado=sin_resultado')).text;
  ok(!f.includes('Ana Tester'), 'filtro estado=sin_resultado lo oculta (tiene resultado)');
  f = (await admin.req('GET', '/admin/partidos?stage=groups&category=M&round=1&grupo=1')).text;
  ok(f.includes('Ana Tester'), 'filtro grupo=1 muestra el partido');
  f = (await admin.req('GET', '/admin/partidos?stage=groups&category=M&round=1&grupo=2')).text;
  ok(f.includes('No hay partidos.'), 'filtro grupo=2 → vacío');

  // --- 3. acordeón público ---
  const pub2 = (await pub.req('GET', '/liga/M/1')).text;
  ok(pub2.includes('<details') && pub2.includes('Calendario y resultados'), 'calendario público en acordeón plegado');
  ok(pub2.includes('Grupo 1') && pub2.includes('Ana Tester'), 'clasificación visible sin desplegar');

  // --- 4. fase cerrada bloquea el borrado ---
  srun("INSERT INTO settings(key, value) VALUES('round1_closed','1') ON CONFLICT(key) DO UPDATE SET value='1'");
  const before = getM();
  const rClosed = await admin.req('POST', `/admin/partidos/${mid}/borrar`, { back: '/admin/partidos?stage=groups&category=M&round=1' });
  m = getM();
  ok(m.winner_id === before.winner_id && rClosed.location.includes('error='), 'con ronda cerrada no borra y avisa');
  srun("INSERT INTO settings(key, value) VALUES('round1_closed','0') ON CONFLICT(key) DO UPDATE SET value='0'");
  await admin.req('POST', `/admin/partidos/${mid}/borrar`, { back: '/x' });
  ok(getM().winner_id === null, 'reabierta: borra sin problema');

  // --- 5. playoff: retrae el avance solo si la siguiente ronda no tiene resultado ---
  const qf = srun("INSERT INTO matches(category, stage, bracket_round, bracket_slot, pair_a_id, pair_b_id) VALUES('M','po1','QF',0,?,?)", pairA, pairB).lastInsertRowid;
  const sf = srun("INSERT INTO matches(category, stage, bracket_round, bracket_slot) VALUES('M','po1','SF',0)").lastInsertRowid;
  await admin.req('POST', `/admin/partidos/${qf}/resultado`, { winner_id: String(pairA), s1a: '6', s1b: '2', s2a: '6', s2b: '2', back: '/x' });
  ok(sdb('SELECT pair_a_id FROM matches WHERE id = ?', sf)[0].pair_a_id === pairA, 'el ganador avanza a SF');
  await admin.req('POST', `/admin/partidos/${qf}/borrar`, { back: '/x' });
  ok(sdb('SELECT pair_a_id FROM matches WHERE id = ?', sf)[0].pair_a_id === null, 'al borrar QF se retrae el avance en SF');
  // caso negativo: SF ya con resultado → no se toca
  await admin.req('POST', `/admin/partidos/${qf}/resultado`, { winner_id: String(pairA), s1a: '6', s1b: '2', s2a: '6', s2b: '2', back: '/x' });
  await admin.req('POST', `/admin/partidos/${sf}/resultado`, { winner_id: String(pairA), s1a: '6', s1b: '1', s2a: '6', s2b: '1', back: '/x' });
  await admin.req('POST', `/admin/partidos/${qf}/borrar`, { back: '/x' });
  ok(sdb('SELECT pair_a_id FROM matches WHERE id = ?', sf)[0].pair_a_id === pairA, 'si SF ya tiene resultado, el avance no se retrae');

  console.log(`\nrun38: ${pass} OK, ${fail} fallos`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); srv.kill(); process.exit(1); });
