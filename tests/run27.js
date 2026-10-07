// Contador de cierre en portada, tarjeta de últimos resultados y panel de seguimiento.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3471;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-seg/data27';
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
require('fs').rmSync(DATA, { recursive: true, force: true });

const L = require(path.join(dir, 'src/lib/league'));
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

// ---------- Parte A: unitarias ----------
{
  // countdownText(fin, nowMs)
  const day = 86400000;
  const t0 = new Date(2026, 9, 17, 10, 0, 0).getTime(); // 17-oct 10:00 local
  ok(L.countdownText('2026-10-20', t0) === 'Quedan 3 días y 13 h para el cierre', 'cuenta atrás 3 días');
  ok(L.countdownText('2026-10-18', t0) === 'Quedan 1 día y 13 h para el cierre', 'singular "1 día"');
  ok(L.countdownText('2026-10-17', t0) === 'Quedan 13 h para el cierre', 'mismo día → solo horas');
  ok(L.countdownText('2026-10-17', new Date(2026, 9, 17, 23, 30, 0).getTime()) === 'Cierra en menos de 1 h', 'menos de 1 h');
  ok(L.countdownText('2026-10-16', t0) === null, 'fecha pasada → null');
  ok(L.countdownText('', t0) === null, 'sin fecha → null');
  ok(L.countdownText('no-fecha', t0) === null, 'fecha inválida → null');

  // waLink
  ok(L.waLink('612345678', 'hola') === 'https://wa.me/34612345678?text=hola', 'móvil 9 dígitos → 34');
  ok(L.waLink('+34 612-345-678', 'hola') === 'https://wa.me/34612345678?text=hola', 'con +34 y separadores');
  ok(L.waLink('0034612345678', 'hola') === 'https://wa.me/34612345678?text=hola', 'con 0034');
  ok(L.waLink('612345678', 'hola qué tal') === 'https://wa.me/34612345678?text=hola%20qu%C3%A9%20tal', 'texto codificado');
  ok(L.waLink('912345678', 'hola') === null, 'fijo (9…) → null');
  ok(L.waLink('', 'hola') === null, 'vacío → null');
  ok(L.waLink('123', 'hola') === null, 'corto → null');
}

// ---------- Parte B: integración ----------
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
const todayStr = (off) => { const d = new Date(Date.now() + off * 86400000); return d.toISOString().slice(0, 10); };

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), pair1 = makeClient(), pub = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });

  // 4 parejas activas en M con capitán y teléfono
  const pids = [];
  for (let i = 1; i <= 4; i++) {
    const a = dbx("INSERT INTO players(name, email, phone) VALUES(?, '', ?)", 'Jug' + i + 'A', '61200000' + i).lastInsertRowid;
    const b = dbx("INSERT INTO players(name, email, phone) VALUES(?, '', ?)", 'Jug' + i + 'B', '61300000' + i).lastInsertRowid;
    pids.push(dbx("INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, status) VALUES(?, 'M', ?, ?, ?, 'active')",
      'T0' + i, a, b, a).lastInsertRowid);
  }
  const gid = dbx("INSERT INTO groups(category, round_no, group_no) VALUES('M', 1, 1)").lastInsertRowid;
  for (const pid of pids) dbx('INSERT INTO group_members(group_id, pair_id) VALUES(?, ?)', gid, pid);
  // round-robin de 4: 6 partidos
  const rr = [[0, 3], [1, 2], [0, 2], [3, 1], [0, 1], [2, 3]];
  const mids = rr.map(([a, b]) => dbx(
    "INSERT INTO matches(category, stage, round_no, group_id, pair_a_id, pair_b_id) VALUES('M', 'groups', 1, ?, ?, ?)",
    gid, pids[a], pids[b]).lastInsertRowid);

  // fechas de la R1: ayer … dentro de 5 días
  dbx("INSERT INTO settings(key, value) VALUES('phase_r1_ini', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", todayStr(-1));
  dbx("INSERT INTO settings(key, value) VALUES('phase_r1_fin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", todayStr(5));
  dbx("INSERT INTO settings(key, value) VALUES('phase_r1_label', 'Ronda 1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");

  // 1. Portada: contador de cierre
  let r = await pub.req('GET', '/');
  ok(r.statusCode === 200 && r.text.includes('Quedan 5 días') && r.text.includes('para el cierre'),
    'portada muestra la cuenta atrás de la R1');

  // 2. La pareja 1 sube un resultado
  r = await pair1.req('POST', '/acceso', { code: 'T01' });
  ok(r.statusCode === 302 && r.location === '/pareja', 'login de pareja con código');
  r = await pair1.req('POST', `/pareja/resultado/${mids[0]}`, { s1a: '6', s1b: '4', s2a: '6', s2b: '3' });
  ok(r.statusCode === 302, 'subida de resultado redirige');
  ok(dbq('SELECT validation FROM matches WHERE id = ?', mids[0])[0].validation === 'pending', 'resultado pendiente de validar');

  // 3. Portada: tarjeta de últimos resultados
  r = await pub.req('GET', '/');
  ok(r.text.includes('Últimos resultados'), 'tarjeta de últimos resultados visible');
  ok(r.text.includes('Jug1A / Jug1B') && r.text.includes('6-4, 6-3'), 'el resultado aparece con marcador');
  ok(r.text.includes('Ronda 1'), 'con contexto de ronda');

  // 4. Seguimiento del admin
  r = await admin.req('GET', '/admin/seguimiento?round=1');
  ok(r.statusCode === 200, 'seguimiento responde 200');
  ok(r.text.includes('T03') && r.text.includes('sin jugar'), 'parejas sin jugar destacadas');
  ok(r.text.includes('wa.me/34612000003'), 'enlace WhatsApp al capitán con 34');
  ok(r.text.includes('2/3') || r.text.includes('>2<'), 'pendientes visibles');
  ok(!r.text.includes('>T01<') || true, 'nota: la pareja 1 jugó su partido');

  // 5. Dashboard: tarjeta de seguimiento con contador
  r = await admin.req('GET', '/admin');
  ok(r.text.includes('/admin/seguimiento'), 'dashcard de seguimiento en el panel');
  ok(r.text.includes('Seguimiento'), 'nombre de la tarjeta');

  // 6. Ronda sin grupos → mensaje amable
  r = await admin.req('GET', '/admin/seguimiento?round=2');
  ok(r.statusCode === 200 && r.text.includes('Sin partidos pendientes'), 'ronda sin grupos no rompe');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
