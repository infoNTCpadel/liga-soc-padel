// Modelo de sustituto: registro, aprobación, marcado en partidos y elegibilidad en playoffs.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3472;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-sub/data28';
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
require('fs').rmSync(DATA, { recursive: true, force: true });

const L = require(path.join(dir, 'src/lib/league'));
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

function makeClient() {
  let cookie = '';
  const req = (m, p, d) => new Promise((res, rej) => {
    const b = d ? new URLSearchParams(d).toString() : null;
    const r = http.request({ port: PORT, path: p, method: m,
      headers: { ...(b ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (rs) => {
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
const dbq = (sql, ...p) => { const d = new DatabaseSync(DATA + '/season-1.db'); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const dbx = (sql, ...p) => { const d = new DatabaseSync(DATA + '/season-1.db'); try { return d.prepare(sql).run(...p); } finally { d.close(); } };

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), p1 = makeClient(), p2 = makeClient();

  // ---- Unitarias: substituteGroupMatches ----
  {
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE matches(id INTEGER PRIMARY KEY, stage TEXT, winner_id INTEGER, wo_winner_id INTEGER, unplayed INTEGER, sub_a_id INTEGER, sub_b_id INTEGER)`);
    const ins = (stage, w, wo, unp, sa, sb) => d.prepare('INSERT INTO matches(stage, winner_id, wo_winner_id, unplayed, sub_a_id, sub_b_id) VALUES(?,?,?,?,?,?)').run(stage, w, wo, unp, sa, sb);
    ins('groups', 1, null, 0, 10, null);   // cuenta
    ins('groups', 1, null, 0, null, 10);   // cuenta (lado B)
    ins('groups', 1, 1, 0, 10, null);      // W.O.: no cuenta
    ins('groups', null, null, 1, 10, null);// no jugado: no cuenta
    ins('groups', null, null, 0, 10, null);// sin resultado: no cuenta
    ins('po1', 1, null, 0, 10, null);      // playoff: no cuenta
    ins('groups', 1, null, 0, 11, null);   // otro sustituto
    ok(L.substituteGroupMatches(d, 10) === 2, 'solo cuenta partidos de grupos disputados con marcador');
    ok(L.substituteGroupMatches(d, 11) === 1, 'sustituto distinto');
    ok(L.substituteGroupMatches(d, 99) === 0, 'sustituto sin partidos');
    ok(L.substituteGroupMatches(d, null) === 0, 'null → 0');
    d.close();
  }

  await admin.req('POST', '/admin/setup', { password: 'admin12345' });

  // 2 parejas M activas, media 3.0 (Intermedio)
  const mkPair = (code, n) => {
    const a = dbx("INSERT INTO players(name, phone, level, gender) VALUES(?, ?, 3.0, 'M')", 'T' + n + 'A', '6120000' + n + '1').lastInsertRowid;
    const b = dbx("INSERT INTO players(name, phone, level, gender) VALUES(?, ?, 3.0, 'M')", 'T' + n + 'B', '6120000' + n + '2').lastInsertRowid;
    return dbx("INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, level_avg, status) VALUES(?, 'M', ?, ?, ?, 3.0, 'active')",
      code, a, b, a).lastInsertRowid;
  };
  const pid1 = mkPair('S01', '1'), pid2 = mkPair('S02', '2');
  const gid = dbx("INSERT INTO groups(category, round_no, group_no) VALUES('M', 1, 1)").lastInsertRowid;
  for (const pid of [pid1, pid2]) dbx('INSERT INTO group_members(group_id, pair_id) VALUES(?, ?)', gid, pid);
  const gmid = dbx("INSERT INTO matches(category, stage, round_no, group_id, pair_a_id, pair_b_id) VALUES('M', 'groups', 1, ?, ?, ?)",
    gid, pid1, pid2).lastInsertRowid;
  // playoff suelto (final) entre las dos parejas
  const pomid = dbx("INSERT INTO matches(category, stage, pair_a_id, pair_b_id, bracket_round, bracket_slot) VALUES('M', 'po1', ?, ?, 'F', 0)",
    pid1, pid2).lastInsertRowid;

  await p1.req('POST', '/acceso', { code: 'S01' });
  await p2.req('POST', '/acceso', { code: 'S02' });

  // 1. Registro de sustituto: validaciones
  let r = await p1.req('POST', '/pareja/sustituto', { new_name: 'Sub Uno', new_phone: '612999001', new_level: '4.5', new_gender: 'M', new_member: '9001' });
  ok(r.statusCode === 200 && r.text.includes('mismo nivel'), 'sustituto de otro tramo → error');
  r = await p1.req('POST', '/pareja/sustituto', { new_name: 'Sub Uno', new_phone: '612999001', new_level: '3.2', new_gender: 'F', new_member: '9001' });
  ok(r.statusCode === 200 && r.text.includes('masculina'), 'mujer en masculina → error');
  r = await p1.req('POST', '/pareja/sustituto', { new_name: 'Sub Uno', new_phone: '123', new_level: '3.2', new_gender: 'M', new_member: '9001' });
  ok(r.statusCode === 200 && r.text.includes('móvil válido'), 'teléfono inválido → error');

  // 2. Solicitud correcta → pendiente
  r = await p1.req('POST', '/pareja/sustituto', { new_name: 'Sub Uno', new_phone: '612999001', new_level: '3.2', new_gender: 'M', new_member: '9001' });
  ok(r.statusCode === 302 && r.location === '/pareja', 'solicitud aceptada');
  ok(dbq("SELECT status FROM substitute_requests WHERE pair_id = ?", pid1)[0].status === 'pending', 'queda pendiente');

  // 3. Segunda solicitud con una pendiente → bloqueada
  r = await p1.req('POST', '/pareja/sustituto', { new_name: 'Sub Dos', new_phone: '612999002', new_level: '3.1', new_gender: 'M', new_member: '9002' });
  ok(r.statusCode === 200 && r.text.includes('pendiente de revisión'), 'no se puede duplicar la solicitud');

  // 4. Aprobación del admin
  const reqId = dbq("SELECT id FROM substitute_requests WHERE pair_id = ?", pid1)[0].id;
  r = await admin.req('GET', '/admin/sustitutos');
  ok(r.statusCode === 200 && r.text.includes('Sub Uno'), 'el admin ve la solicitud');
  r = await admin.req('POST', `/admin/sustitutos/${reqId}/aprobar`, {});
  ok(r.statusCode === 302, 'aprobación redirige');
  const subId = dbq('SELECT substitute_id FROM pairs WHERE id = ?', pid1)[0].substitute_id;
  ok(subId > 0 && dbq('SELECT name FROM players WHERE id = ?', subId)[0].name === 'Sub Uno', 'sustituto registrado en la pareja');
  ok(dbq('SELECT level_avg FROM pairs WHERE id = ?', pid1)[0].level_avg === 3.0, 'la media de la pareja no cambia (sigue siendo la de los titulares)');
  r = await p1.req('GET', '/pareja');
  ok(r.text.includes('Sustituto:') && r.text.includes('Sub Uno'), 'la pareja ve su sustituto');
  ok(r.text.includes('aún no puede jugar playoffs'), 'aviso de no elegible antes de jugar');

  // 5. Marcar sustituto en un partido de grupos
  r = await p1.req('POST', `/pareja/resultado/${gmid}`, { s1a: '6', s1b: '4', s2a: '6', s2b: '3', sub_me: '1' });
  ok(r.statusCode === 302 && !r.location.includes('?error='), 'resultado con sustituto aceptado en grupos');
  const mm = dbq('SELECT sub_a_id, sub_b_id FROM matches WHERE id = ?', gmid)[0];
  ok(mm.sub_a_id === subId && mm.sub_b_id === null, 'sustituto guardado en el lado propio');
  ok(L.substituteGroupMatches(new DatabaseSync(DATA + '/season-1.db'), subId) === 1, 'cuenta 1 partido disputado');

  // 6. Playoff: ahora sí puede jugar (tiene 1 partido)
  r = await p1.req('POST', `/pareja/resultado/${pomid}`, { s1a: '6', s1b: '2', s2a: '6', s2b: '2', sub_me: '1' });
  ok(r.statusCode === 302 && !r.location.includes('?error='), 'sustituto con partidos puede jugar playoffs');

  // 7. Otro sustituto sin partidos NO puede jugar playoffs
  r = await p2.req('POST', '/pareja/sustituto', { new_name: 'Sub Dos', new_phone: '612999002', new_level: '3.0', new_gender: 'M', new_member: '9002' });
  const reqId2 = dbq("SELECT id FROM substitute_requests WHERE pair_id = ? ORDER BY id DESC LIMIT 1", pid2)[0].id;
  await admin.req('POST', `/admin/sustitutos/${reqId2}/aprobar`, {});
  const subId2 = dbq('SELECT substitute_id FROM pairs WHERE id = ?', pid2)[0].substitute_id;
  const pomid2 = dbx("INSERT INTO matches(category, stage, pair_a_id, pair_b_id, bracket_round, bracket_slot) VALUES('M', 'po1', ?, ?, 'F', 1)", pid2, pid1).lastInsertRowid;
  r = await p2.req('POST', `/pareja/resultado/${pomid2}`, { s1a: '6', s1b: '2', s2a: '6', s2b: '2', sub_me: '1' });
  ok(r.statusCode === 302 && r.location.includes('error='), 'sustituto sin partidos NO puede jugar playoffs');
  ok(dbq('SELECT winner_id FROM matches WHERE id = ?', pomid2)[0].winner_id === null, 'el resultado no se guarda');

  // 8. El admin también puede marcar el sustituto
  const gmid2 = dbx("INSERT INTO matches(category, stage, round_no, group_id, pair_a_id, pair_b_id) VALUES('M', 'groups', 1, ?, ?, ?)", gid, pid2, pid1).lastInsertRowid;
  r = await admin.req('POST', `/admin/partidos/${gmid2}/resultado`, { winner_id: String(pid2), s1a: '6', s1b: '3', s2a: '6', s2b: '3', sub_a: '1', back: '/admin/partidos' });
  ok(r.statusCode === 302, 'el admin guarda');
  ok(dbq('SELECT sub_a_id FROM matches WHERE id = ?', gmid2)[0].sub_a_id === subId2, 'el admin marca el sustituto del lado A');

  // 9. Con playoffs generados no se puede registrar sustituto
  dbx("INSERT INTO settings(key, value) VALUES('playoffs_generated', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
  r = await p1.req('GET', '/pareja/sustituto');
  ok(r.statusCode === 302 && r.location === '/pareja', 'con playoffs generados no hay registro');

  // 10. Rutas antiguas
  r = await p1.req('GET', '/pareja/cambio');
  ok(r.statusCode === 404, 'la ruta antigua de cambio ya no existe');
  r = await admin.req('GET', '/admin/cambios');
  ok(r.statusCode === 200, 'la página heredada de cambios sigue accesible');

  // 11. Revalidación al aprobar: si la media cambió de tramo tras la solicitud, se rechaza
  dbx('UPDATE pairs SET substitute_id = NULL WHERE id = ?', pid2);
  dbx("UPDATE settings SET value = '0' WHERE key = 'playoffs_generated'");
  await p2.req('POST', '/pareja/sustituto', { new_name: 'Sub Tres', new_phone: '612999003', new_level: '3.0', new_gender: 'M', new_member: '9003' });
  const reqId3 = dbq("SELECT id FROM substitute_requests WHERE pair_id = ? ORDER BY id DESC LIMIT 1", pid2)[0].id;
  ok(dbq('SELECT status FROM substitute_requests WHERE id = ?', reqId3)[0].status === 'pending', 'solicitud creada con nivel válido');
  dbx('UPDATE pairs SET level_avg = 5.0 WHERE id = ?', pid2); // la media cambia después
  await admin.req('POST', `/admin/sustitutos/${reqId3}/aprobar`, {});
  ok(dbq('SELECT status FROM substitute_requests WHERE id = ?', reqId3)[0].status === 'rejected', 'al aprobar se revalida el nivel y se rechaza si no cuadra');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
