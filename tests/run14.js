// MEDIODÍA PADEL — Fase A: validación, códigos únicos, admin (vía lib) y HTTP.
// Uso: DATA_DIR se fija aquí mismo a un directorio temporal; no toca data/ real.
//   node tests/run14.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const UNIT_DIR = '/tmp/midday-fasea-unit';
const HTTP_DIR = '/tmp/midday-fasea-http';
for (const d of [UNIT_DIR, HTTP_DIR]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
process.env.DATA_DIR = UNIT_DIR;

const M = require('../src/lib/midday');
const { middayDb, middayGet, middaySet, metaDb, getActiveSeasonId, seasonDb } = require('../src/db');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + ` (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`);

// ---------- validaciones puras ----------
ok(M.validEmail('a@b.com'), 'email válido');
ok(!M.validEmail('a@b'), 'email sin TLD no válido');
ok(!M.validEmail('no-es-email'), 'texto no es email');
ok(M.validLevel(1) && M.validLevel(7) && M.validLevel(4.25), 'niveles 1–7 en cuartos válidos');
ok(!M.validLevel(0.99) && !M.validLevel(7.01) && !M.validLevel(4.3), 'niveles fuera de rango o no cuartos inválidos');
eq(M.playtomicToMidday(2.5), 3.5, 'playtomic 2.5 → 3.5');
eq(M.playtomicToMidday(0), 1, 'playtomic 0 → 1 (mínimo)');
eq(M.playtomicToMidday(6), 7, 'playtomic 6 → 7 (máximo)');
eq(M.parseSlots('[{"id":"s1","label":"13:00"},{"id":"s2","label":"14:30"}]').length, 2, 'parseSlots 2 franjas');
eq(M.parseSlots('no-json'), [], 'parseSlots con JSON roto → []');
eq(M.parseBlackout('2026-11-05, 2026-12-24').dates, ['2026-11-05', '2026-12-24'], 'parseBlackout dos fechas');
ok(M.parseBlackout('').dates.length === 0, 'parseBlackout vacío');
ok(M.parseBlackout('05/11/2026').error, 'parseBlackout formato erróneo → error');
ok(M.parseBlackout('2026-02-30').error, 'parseBlackout fecha inexistente → error');

const SLOTS = [{ id: 's1', label: '13:00' }, { id: 's2', label: '14:30' }];
function baseBody() {
  return {
    p1_name: 'Ana López', p1_email: 'ana@example.com', p1_phone: '600111222', p1_level: '4',
    p2_name: 'Luis Gil', p2_email: 'luis@example.com', p2_phone: '600333444', p2_level: '5',
    slot_s1: 'pref', slot_s2: 'ok', normativa: '1',
  };
}
ok(M.validateInscription(baseBody(), SLOTS).ok, 'formulario válido pasa');
ok(!M.validateInscription({ ...baseBody(), p1_email: 'mal' }, SLOTS).ok, 'email mal → error');
ok(!M.validateInscription({ ...baseBody(), p1_level: '9' }, SLOTS).ok, 'nivel 9 → error');
ok(!M.validateInscription({ ...baseBody(), p1_level: '4.3' }, SLOTS).ok, 'nivel 4.3 (no cuarto) → error');
ok(!M.validateInscription({ ...baseBody(), slot_s1: 'no', slot_s2: 'no' }, SLOTS).ok, 'todo "no" en franjas → error');
ok(!M.validateInscription({ ...baseBody(), normativa: '' }, SLOTS).ok, 'sin normativa → error');
ok(!M.validateInscription({ ...baseBody(), p2_phone: '600111222' }, SLOTS).ok, 'mismo móvil → error');
ok(!M.validateInscription({ ...baseBody(), p2_name: 'ANA LÓPEZ' }, SLOTS).ok, 'mismo nombre → error');
ok(!M.validateInscription({ ...baseBody(), p1_phone: '910111222' }, SLOTS).ok, 'fijo (91…) → error');
{
  const v = M.validateInscription({ ...baseBody(), blackout: '2026-11-05, 2026-13-40' }, SLOTS);
  ok(!v.ok, 'blackout con fecha imposible → error');
  const v2 = M.validateInscription({ ...baseBody(), blackout: '2026-11-05', off_fri: '1' }, SLOTS);
  ok(v2.ok && v2.data.level_avg === 4.5, 'level_avg 4.5 y datos limpios');
  eq(JSON.parse(v2.data.weekdays_off), ['fri'], 'weekdays_off ["fri"]');
  eq(JSON.parse(v2.data.slot_prefs), { s1: 'pref', s2: 'ok' }, 'slot_prefs guardadas');
}

// ---------- códigos únicos (50 parejas) ----------
{
  const codes = new Set();
  for (let i = 0; i < 50; i++) {
    const v = M.validateInscription({ ...baseBody(), p1_phone: `600100${String(i).padStart(3, '0')}`.slice(0, 9),
      p2_phone: `611200${String(i).padStart(3, '0')}`.slice(0, 9), p1_name: `J1-${i}`, p2_name: `J2-${i}`,
      p1_email: `j1-${i}@x.com`, p2_email: `j2-${i}@x.com` }, SLOTS);
    if (!v.ok) { ok(false, `pareja ${i} válida: ${v.errors.join(';')}`); continue; }
    const c = M.createPair(middayDb, v.data);
    codes.add(c.code);
    ok(/^[A-Z2-9]{6}$/.test(c.code), `código ${c.code} con formato válido`);
  }
  eq(codes.size, 50, '50 parejas → 50 códigos únicos');
  middayDb.exec("DELETE FROM midday_pairs");
}

// ---------- duplicados ----------
{
  const v = M.validateInscription(baseBody(), SLOTS);
  M.createPair(middayDb, v.data);
  ok(M.pairExists(middayDb, '600111222', '600333444'), 'detecta pareja duplicada');
  ok(M.pairExists(middayDb, '600333444', '600111222'), 'detecta duplicada en orden inverso');
  ok(!M.pairExists(middayDb, '600111222', '600999888'), 'no es duplicada con otro móvil');
  middayDb.exec("DELETE FROM midday_pairs");
}

// ---------- admin vía lib ----------
{
  const v = M.validateInscription(baseBody(), SLOTS);
  const { id } = M.createPair(middayDb, v.data);
  ok(M.getPair(middayDb, id).status === 'pending', 'nace pending');
  ok(M.setStatus(middayDb, id, 'approved') && M.getPair(middayDb, id).status === 'approved', 'aprobar');
  ok(M.setStatus(middayDb, id, 'rejected') && M.getPair(middayDb, id).status === 'rejected', 'rechazar');
  ok(!M.setStatus(middayDb, id, 'bogus'), 'estado inválido → false');
  ok(M.updateLevels(middayDb, id, 3, 6), 'actualizar niveles');
  eq(M.getPair(middayDb, id).level_avg, 4.5, 'media recalculada 4.5');
  ok(!M.updateLevels(middayDb, id, 0, 5), 'nivel 0 → false');
  ok(M.deletePair(middayDb, id) && !M.getPair(middayDb, id), 'eliminar');
  eq(M.listPairs(middayDb).length, 0, 'lista vacía tras eliminar');
}

// ---------- sugerencia de nivel: solo lectura, prioridad socios ----------
// (en producción la tabla la crea el módulo de reservas; aquí se replica su esquema)
{
  metaDb.exec(`CREATE TABLE IF NOT EXISTS club_members(
    member_no TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    pin_hash TEXT NOT NULL DEFAULT '', level REAL)`);
  metaDb.prepare("INSERT INTO club_members(member_no, name, phone, email, active, level) VALUES('S1','Socia Uno','600777888','socia@club.com',1,5.5)").run();
  const sid = getActiveSeasonId();
  seasonDb(sid).prepare("INSERT INTO players(name, email, phone, level) VALUES('Jugador Social','social@x.com','600555666',2.5)").run();
  const s1 = M.suggestLevel(metaDb, seasonDb(sid), 'socia@club.com', '');
  eq(s1, { level: 5.5, source: 'socios del club' }, 'sugerencia desde socios (escala 1–7 directa)');
  const s2 = M.suggestLevel(metaDb, seasonDb(sid), '', '600555666');
  eq(s2, { level: 3.5, source: 'liga social' }, 'sugerencia desde liga social (2.5 → 3.5)');
  eq(M.suggestLevel(metaDb, seasonDb(sid), 'nadie@x.com', '600000000'), null, 'sin coincidencias → null');
  // la liga social no se ha modificado: sigue habiendo 1 jugador en la temporada
  eq(seasonDb(sid).prepare('SELECT COUNT(*) c FROM players').get().c, 1, 'temporada intacta (1 jugador)');
}

// ---------- seeds ----------
eq(middayGet('comp_name'), 'MEDIODÍA PADEL', 'seed comp_name');
eq(middayGet('inscription_deadline'), '2026-10-20', 'seed deadline');
ok(M.parseSlots(middayGet('slots')).length === 2, 'seed 2 franjas');

console.log(`\nunit: ${pass} OK, ${fail} fallos`);

// ---------- integración HTTP ----------
// (fetch no permite fijar la cabecera Host; se usa node:http directamente)
const httpMod = require('http');
function httpreq({ port, host, path = '/', method = 'GET', body = null, cookie = null }) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    let payload = null;
    if (body !== null) {
      payload = typeof body === 'string' ? body : body.toString();
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

async function http() {
  const PORT = 32107;
  const srv = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: HTTP_DIR, PORT: String(PORT), MIDDAY_HOST: 'midday.test' },
    stdio: 'ignore',
  });
  let hpass = 0, hfail = 0;
  const hok = (c, n) => { c ? hpass++ : (hfail++, console.log('FALLO HTTP:', n)); };
  try {
    // esperar a que arranque
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try { const r = await httpreq({ port: PORT, host: 'midday.test' }); ready = r.status === 200; }
      catch (e) { await new Promise(r => setTimeout(r, 200)); }
    }
    hok(ready, 'el servidor arranca');

    let r = await httpreq({ port: PORT, host: 'midday.test' });
    hok(r.status === 200 && r.body.includes('MEDIODÍA PADEL') && r.body.includes('☀️'),
      'landing 200 en el host de mediodía');

    r = await httpreq({ port: PORT, host: 'otro.test' });
    hok(r.status === 200 && !r.body.includes('MEDIODÍA PADEL'),
      'el host normal sigue mostrando la liga social');

    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/inscripcion' });
    hok(r.status === 200 && r.body.includes('¿En qué franja podéis jugar?'),
      'formulario de inscripción 200');

    // alta válida
    const form = new URLSearchParams({ ...baseBody(), blackout: '2026-11-05' }).toString();
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/inscripcion', method: 'POST', body: form });
    const codeM = r.body.match(/<p class="code big">([A-Z2-9]{6})<\/p>/);
    hok(r.status === 200 && codeM, 'alta válida → página de confirmación con código');
    const code = codeM && codeM[1];

    // alta duplicada (misma pareja) → error
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/inscripcion', method: 'POST', body: form });
    hok(r.body.includes('ya está inscrita'), 'alta duplicada → error');

    // alta inválida
    const bad = new URLSearchParams({ ...baseBody(), p1_email: 'mal', p2_phone: '600333444' }).toString();
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/inscripcion', method: 'POST', body: bad });
    hok(r.body.includes('no es válido'), 'alta con email mal → muestra error');

    // login con código + mis partidos
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/acceso', method: 'POST',
      body: new URLSearchParams({ code }).toString() });
    const cookie = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    hok(r.status === 302 && r.headers.location === '/mediodia/mis-partidos' && cookie,
      'login con código → 302 a mis-partidos con sesión');
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/mis-partidos', cookie });
    hok(r.status === 200 && r.body.includes('Mis partidos') && r.body.includes('2026-11-05'),
      'mis-partidos muestra preferencias');

    // login con código erróneo
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/acceso', method: 'POST',
      body: new URLSearchParams({ code: 'ZZZZZZ' }).toString() });
    hok(r.body.includes('no válido'), 'código erróneo → error');

    // admin sin sesión → redirige al login/setup de admin
    r = await httpreq({ port: PORT, host: 'otro.test', path: '/admin/mediodia' });
    hok(r.status === 302 && /\/admin\/(login|setup)/.test(r.headers.location || ''),
      'admin sin sesión → /admin/login o /admin/setup');

    // sugerencia de nivel vía API (solo lectura)
    r = await httpreq({ port: PORT, host: 'midday.test', path: '/mediodia/api/nivel-sugerido?email=&phone=' });
    let js = null;
    try { js = JSON.parse(r.body); } catch (e) { /* noop */ }
    hok(r.status === 200 && js && typeof js === 'object', 'api nivel-sugerido responde JSON');
  } finally {
    srv.kill('SIGTERM');
  }
  console.log(`http: ${hpass} OK, ${hfail} fallos`);
  return hfail;
}

http().then((hfail) => {
  const total = fail + hfail;
  console.log(`\nTOTAL: ${pass} OK, ${total} fallos`);
  process.exit(total ? 1 : 0);
}).catch(e => { console.error('ERROR HTTP:', e); process.exit(1); });
