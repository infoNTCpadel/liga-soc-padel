// MEDIODÍA PADEL — Fase A+: ediciones (torneos) y datos de prueba.
// Uso: node tests/run15.js
// Fija DATA_DIR a directorios temporales; no toca data/ real.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const MIG_DIR = '/tmp/mid15-mig';
const MAIN_DIR = '/tmp/mid15-main';
const HTTP_DIR = '/tmp/mid15-http';
for (const d of [MIG_DIR, MAIN_DIR, HTTP_DIR]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + ` (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`);

// ---------- 1. Migración desde el esquema de la Fase A ----------
function buildOldDb() {
  const db = new DatabaseSync(path.join(MIG_DIR, 'midday.db'));
  db.exec(`CREATE TABLE midday_pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
    player1_name TEXT NOT NULL, player1_email TEXT NOT NULL DEFAULT '',
    player1_phone TEXT NOT NULL DEFAULT '', player2_name TEXT NOT NULL,
    player2_email TEXT NOT NULL DEFAULT '', player2_phone TEXT NOT NULL DEFAULT '',
    level1 REAL NOT NULL DEFAULT 1, level2 REAL NOT NULL DEFAULT 1,
    level_avg REAL NOT NULL DEFAULT 1, slot_prefs TEXT NOT NULL DEFAULT '{}',
    weekdays_off TEXT NOT NULL DEFAULT '[]', blackout_dates TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending', notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE TABLE midday_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare(`INSERT INTO midday_pairs(code, player1_name, player1_email, player1_phone,
      player2_name, player2_email, player2_phone, level1, level2, level_avg, status)
    VALUES('ABC123','Ana López','ana@x.com','600111222','Luis Gil','luis@x.com','600333444',4,5,4.5,'approved')`).run();
  db.prepare(`INSERT INTO midday_pairs(code, player1_name, player1_email, player1_phone,
      player2_name, player2_email, player2_phone, level1, level2, level_avg, status)
    VALUES('DEF456','María Ruiz','maria@x.com','600555666','Jorge Martí','jorge@x.com','600777888',3,3.5,3.25,'pending')`).run();
  db.prepare(`INSERT INTO midday_settings(key, value) VALUES
    ('comp_name','MEDIODÍA PADEL'), ('inscription_deadline','2026-10-20'), ('courts_midday','6')`).run();
  db.close();
}
buildOldDb();

// La migración vive en el init de src/db.js: se verifica en un proceso hijo.
const migCheck = spawnSync('node', ['-e', `
const db = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db.js'))});
const out = {};
out.tournaments = db.middayDb.prepare('SELECT id,name,status FROM midday_tournaments').all();
out.pairCols = db.middayDb.prepare('PRAGMA table_info(midday_pairs)').all().map(c => c.name);
out.setCols = db.middayDb.prepare('PRAGMA table_info(midday_settings)').all().map(c => c.name);
out.pairs = db.middayDb.prepare('SELECT code,tournament_id,is_test,player1_name,level_avg,status FROM midday_pairs ORDER BY id').all();
out.oldSettings = db.middayDb.prepare("SELECT tournament_id,key,value FROM midday_settings WHERE key IN ('comp_name','inscription_deadline','courts_midday') ORDER BY key").all();
out.deadline = db.middayGet('inscription_deadline', 'FALLO');
out.courts = db.middayGet('courts_midday', 'FALLO');
out.slotsDefault = db.middayGet('slots', 'FALLO').slice(0, 20);
console.log(JSON.stringify(out));
`], { env: { ...process.env, DATA_DIR: MIG_DIR }, encoding: 'utf8' });
ok(migCheck.status === 0, 'proceso de migración arranca sin errores' + (migCheck.status ? ' :: ' + migCheck.stderr.slice(0, 200) : ''));
const mig = JSON.parse(migCheck.stdout);
eq(mig.tournaments, [{ id: 1, name: 'Edición 1', status: 'inscription' }], 'migración crea "Edición 1" en inscription');
ok(mig.pairCols.includes('tournament_id') && mig.pairCols.includes('is_test'), 'parejas ganan tournament_id e is_test');
eq(mig.setCols, ['tournament_id', 'key', 'value'], 'settings reconstruidos con ámbito por edición');
eq(mig.pairs, [
  { code: 'ABC123', tournament_id: 1, is_test: 0, player1_name: 'Ana López', level_avg: 4.5, status: 'approved' },
  { code: 'DEF456', tournament_id: 1, is_test: 0, player1_name: 'María Ruiz', level_avg: 3.25, status: 'pending' },
], 'parejas existentes intactas en la edición 1');
eq(mig.oldSettings, [
  { tournament_id: 1, key: 'comp_name', value: 'MEDIODÍA PADEL' },
  { tournament_id: 1, key: 'courts_midday', value: '6' },
  { tournament_id: 1, key: 'inscription_deadline', value: '2026-10-20' },
], 'settings antiguos migrados con tournament_id=1');
eq(mig.courts, '6', 'valor personalizado (6 pistas) no lo pisa el valor por defecto');
ok(mig.slotsDefault.startsWith('[{"id":"s1"'), 'los defaults que faltaban se siembran en la edición 1');

// ---------- 2. Ediciones: CRUD + una sola abierta ----------
process.env.DATA_DIR = MAIN_DIR;
const DB = require('../src/db');
const M = require('../src/lib/midday');
const mdb = DB.middayDb;

let cur = M.currentTournament(mdb);
eq([cur.name, cur.status], ['Edición 1', 'inscription'], 'edición inicial abierta');

DB.middaySet('courts_midday', '8', 1); // valor personalizado para verificar la copia
let r = M.createTournament(mdb, 'Invierno 2027', null, DB.MIDDAY_DEFAULTS);
ok(r.ok && r.id === 2, 'crear edición devuelve id');
eq(M.getTournament(mdb, 1).status, 'finished', 'al crear la nueva, la anterior se finaliza');
cur = M.currentTournament(mdb);
eq([cur.id, cur.name, cur.status], [2, 'Invierno 2027', 'inscription'], 'la nueva es la edición abierta');
eq(DB.middayGet('courts_midday', null, 2), '8', 'los ajustes se copian de la edición anterior');

r = M.createTournament(mdb, '', null, DB.MIDDAY_DEFAULTS);
ok(!r.ok, 'crear sin nombre → error');
r = M.createTournament(mdb, 'X', 999, DB.MIDDAY_DEFAULTS);
ok(!r.ok, 'crear con origen inexistente → error');

ok(M.renameTournament(mdb, 2, 'Invierno 2027-28'), 'renombrar ok');
eq(M.getTournament(mdb, 2).name, 'Invierno 2027-28', 'nombre actualizado');
ok(!M.renameTournament(mdb, 2, '  '), 'renombrar a vacío → false');

r = M.setTournamentStatus(mdb, 2, 'active');
ok(r.ok && M.getTournament(mdb, 2).status === 'active', 'inscription → active');
r = M.setTournamentStatus(mdb, 2, 'finished');
ok(r.ok, 'active → finished');
ok(M.currentTournament(mdb) === null, 'sin ediciones abiertas → current null');
r = M.setTournamentStatus(mdb, 2, 'active');
ok(!r.ok, 'finished → active no permitido');
r = M.setTournamentStatus(mdb, 2, 'nope');
ok(!r.ok, 'estado inválido → error');
r = M.setTournamentStatus(mdb, 2, 'finished');
ok(r.ok, 'mismo estado → ok (no-op)');

r = M.createTournament(mdb, 'Primavera 2028', 1, DB.MIDDAY_DEFAULTS); // copiar explícito de la ed. 1
ok(r.ok && r.id === 3, 'crear tercera edición con copyFrom explícito');
eq(DB.middayGet('courts_midday', null, 3), '8', 'copia explícita desde la edición 1');
eq(M.getTournament(mdb, 2).status, 'finished', 'la edición 2 sigue finalizada');

r = M.deleteTournament(mdb, 999);
ok(!r.ok, 'eliminar edición inexistente → error');

function mkPairData(ph1, ph2, tid) {
  return {
    tournament_id: tid,
    player1_name: 'Test Uno', player1_email: 't1@x.com', player1_phone: ph1,
    player2_name: 'Test Dos', player2_email: 't2@x.com', player2_phone: ph2,
    level1: 4, level2: 5, level_avg: 4.5,
    slot_prefs: '{"s1":"pref"}', weekdays_off: '[]', blackout_dates: '[]', notes: '',
  };
}
const p1 = M.createPair(mdb, mkPairData('611111111', '622222222', 3));
r = M.deleteTournament(mdb, 3);
ok(!r.ok && /parejas/.test(r.error), 'eliminar edición con parejas → error');
ok(M.deletePair(mdb, p1.id), 'borrar la pareja');
r = M.deleteTournament(mdb, 3);
ok(r.ok && M.getTournament(mdb, 3) === null, 'eliminar edición vacía → ok');
eq(M.listTournaments(mdb).map(t => t.id), [1, 2], 'quedan las ediciones 1 y 2');

// ---------- 3. Aislamiento de parejas entre ediciones ----------
r = M.createTournament(mdb, 'Verano 2028', null, DB.MIDDAY_DEFAULTS);
const ed4 = r.id;
const curEd = M.currentTournament(mdb).id;
const pa = M.createPair(mdb, mkPairData('633333333', '644444444', curEd));
ok(M.pairExists(mdb, '633333333', '644444444', curEd), 'pairExists en su edición');
ok(!M.pairExists(mdb, '633333333', '644444444', 1), 'pairExists no cruza ediciones');
const pb = M.createPair(mdb, mkPairData('633333333', '644444444', 1)); // mismos móviles, otra edición
ok(pb.id !== pa.id && pb.code !== pa.code, 'misma pareja en otra edición: alta ok, códigos únicos globales');
eq(M.listPairs(mdb, curEd).length, 1, 'listPairs filtra por edición (abierta)');
eq(M.listPairs(mdb, 1).length, 1, 'listPairs filtra por edición (1)');
ok(M.getPairByCode(mdb, pa.code).tournament_id === curEd, 'login por código encuentra la edición correcta');

// createPair sin tournament_id → va a la edición abierta
const pc = M.createPair(mdb, { ...mkPairData('655555555', '666666666'), tournament_id: undefined });
eq(pc.tournament_id, curEd, 'sin tournament_id usa la edición abierta');

// ---------- 4. Settings independientes por edición ----------
DB.middaySet('slots', '[{"id":"s1","label":"12:30"}]', 1);
ok(DB.middayGet('slots', null, curEd).indexOf('13:00') > 0, 'la edicion abierta conserva sus franjas (default)');
eq(DB.middayGet('slots', 'FB'), DB.middayGet('slots', 'FB', curEd), 'middayGet sin tid usa la edición abierta');

// ---------- 5. Datos de prueba ----------
const gen = M.generateTestPairs(mdb, curEd, 8);
eq(gen.length, 8, 'generateTestPairs crea 8');
eq(M.countTestPairs(mdb, curEd), 8, 'countTestPairs = 8');
const tests = mdb.prepare('SELECT * FROM midday_pairs WHERE tournament_id = ? AND is_test = 1').all(curEd);
ok(tests.every(t => /^[67]\d{8}$/.test(t.player1_phone) && /^[67]\d{8}$/.test(t.player2_phone)),
  'móviles de prueba válidos (9 dígitos, 6/7)');
ok(tests.every(t => M.validLevel(t.level1) && M.validLevel(t.level2)), 'niveles de prueba 1–7 en cuartos');
ok(tests.every(t => t.player1_email.includes('@ejemplo.com')), 'emails de ejemplo');
ok(tests.every(t => ['pending', 'approved'].includes(t.status)), 'estados pending/approved');
ok(tests.every(t => JSON.parse(t.slot_prefs).s1 !== 'no' || JSON.parse(t.slot_prefs).s2 !== 'no'),
  'al menos una franja posible');
const uniqPhones = new Set(tests.flatMap(t => [t.player1_phone, t.player2_phone]));
ok(uniqPhones.size === 16, 'móviles de prueba únicos');
eq(M.countPairs(mdb, curEd), 1 + 1 + 8, '8 prueba + 2 reales en la edición');
const real = M.createPair(mdb, mkPairData('677777777', '688888888', curEd));
const del = M.deleteTestPairs(mdb, curEd);
eq(del, 8, 'deleteTestPairs devuelve 8');
eq(M.countTestPairs(mdb, curEd), 0, 'no quedan parejas de prueba');
const stillReal = M.getPair(mdb, real.id);
ok(stillReal && stillReal.is_test === 0, 'la pareja real sigue intacta');
eq(M.countPairs(mdb, curEd), 3, 'quedan las 3 parejas reales');
eq(M.deleteTestPairs(mdb, curEd), 0, 'eliminar sin pruebas → 0');

// ---------- 6. Sin edición abierta: la parte pública se cierra ----------
for (const t of M.listTournaments(mdb)) M.setTournamentStatus(mdb, t.id, 'finished');
ok(M.currentTournament(mdb) === null, 'todas finalizadas → sin edición abierta');
eq(DB.middayGet('slots', 'FB'), 'FB', 'middayGet sin edición abierta → fallback');
eq(DB.middaySet('slots', 'x'), false, 'middaySet sin edición abierta → false');
let threw = false;
try { M.createPair(mdb, mkPairData('699999999', '611000000')); } catch (e) { threw = true; }
ok(threw, 'createPair sin edición abierta → excepción controlada');

console.log(`\nlib: ${pass} OK, ${fail} fallos`);
process.exitCode = fail ? 1 : 0;

// ---------- 7. HTTP: landing e inscripción con la edición cerrada ----------
// (la BD de MAIN_DIR ya tiene todas las ediciones finalizadas del paso 6)
function httpreq({ port, path, method = 'GET', host = '127.0.0.1', body = null }) {
  const httpMod = require('http');
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    let payload = null;
    if (body) {
      payload = body;
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
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

async function httpClosed() {
  const PORT = 32109;
  const srv = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: MAIN_DIR, PORT: String(PORT), MIDDAY_HOST: 'midday.test' },
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

    let r = await httpreq({ port: PORT, host: 'midday.test' });
    hok(r.status === 200 && r.body.includes('en preparaci'), 'landing sin edición abierta → "próxima edición en preparación"');

    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/inscripcion' });
    hok(r.status === 200 && r.body.includes('ninguna edici'), 'formulario sin edición abierta → aviso de cierre');

    const form = new URLSearchParams({
      p1_name: 'A', p1_email: 'a@x.com', p1_phone: '600111223', p1_level: '4',
      p2_name: 'B', p2_email: 'b@x.com', p2_phone: '600111224', p2_level: '4',
      normativa: '1',
    }).toString();
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/inscripcion', method: 'POST', body: form });
    hok(r.status === 200 && r.body.includes('ninguna edici'), 'POST inscripción sin edición abierta → error controlado');

    // admin del mediodía sigue cargando (selector de ediciones)
    r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/mediodia' });
    hok(r.status === 302 && /\/admin\/(login|setup)/.test(r.headers.location || ''), 'admin sin sesión → login/setup');
  } finally {
    srv.kill('SIGTERM');
  }
  console.log(`http (edición cerrada): ${hpass} OK, ${hfail} fallos`);
  return hfail;
}

// ---------- 8. run14 sigue en verde ----------
function run14() {
  const r = spawnSync('node', ['tests/run14.js'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 180000,
  });
  const m = /TOTAL: (\d+) OK, (\d+) fallos/.exec(r.stdout || '');
  const okRun = r.status === 0 && m && Number(m[2]) === 0;
  if (!okRun) console.log('FALLO: run14 no está en verde\n' + (r.stdout || '').slice(-500) + (r.stderr || '').slice(-500));
  else console.log(`run14: ${m[1]} OK, 0 fallos (regresión verde)`);
  return okRun ? 0 : 1;
}

(async () => {
  let extra = 0;
  extra += await httpClosed();
  extra += run14();
  const total = fail + extra;
  console.log(`\nTOTAL run15: ${pass} OK, ${total} fallos`);
  process.exit(total ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
