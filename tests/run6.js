// Pruebas v9i: bug del <span> escapado, códigos de pareja en cobros de
// recepción y corrección de nombres de jugador desde el admin.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3467;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-v9e/data9i';
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
require('fs').rmSync(DATA, { recursive: true, force: true });
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
const dbq = (sql, ...p) => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(DATA + '/season-1.db'); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), pub = makeClient(), recep = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });
  const P = (n, name, phone, gender, member) => ({ [`a_p${n}_name`]: name, [`a_p${n}_phone`]: phone, [`a_p${n}_gender`]: gender, [`a_p${n}_level`]: '3', [`a_p${n}_member`]: member });

  // 1. El badge de ronda se renderiza como HTML, no como texto escapado
  let r = await admin.req('GET', '/admin');
  ok(r.statusCode === 200 && r.text.includes('<span class="badge warn">abierta</span>'), 'badge "abierta" se renderiza como HTML');
  ok(!r.text.includes('&lt;span class=&quot;badge'), 'no sale el span escapado en el panel');

  // 2. Inscripción de prueba y códigos en cobros de recepción
  await admin.req('POST', '/admin/ajustes/recepcion-password', { password: 'recep123' });
  await pub.req('POST', '/inscripcion', { modality: 'M', ...P(1, 'Ana Ruiz', '614000001', 'F', '3001'), ...P(2, 'Beto', '614000002', 'M', '3002') });
  await pub.req('POST', '/inscripcion', { modality: 'X', ...P(1, 'Ana Ruiz', '614000001', 'F', '3001'), ...P(2, 'Jorge', '614000009', 'M', '3009') });
  const codeM = dbq("SELECT code FROM pairs WHERE category='M' AND player1_id IN (SELECT id FROM players WHERE phone='614000001')")[0].code;
  const codeX = dbq("SELECT code FROM pairs WHERE category='X' AND player1_id IN (SELECT id FROM players WHERE phone='614000001')")[0].code;
  ok(codeM && codeX && codeM !== codeX, 'Ana tiene dos parejas con códigos distintos');
  await recep.req('POST', '/recepcion/login', { password: 'recep123' });
  r = await recep.req('GET', '/recepcion/cobros?f=todos');
  ok(r.statusCode === 200 && r.text.includes(codeM) && r.text.includes(codeX), 'cobros muestra los códigos de ambas parejas de Ana');
  ok(r.text.includes('Códigos de pareja'), 'la columna de códigos existe');

  // 3. El detalle muestra el formulario para corregir el nombre
  const id1 = dbq("SELECT id FROM pairs WHERE code=?", codeM)[0].id;
  r = await admin.req('GET', '/admin/inscripciones/' + id1);
  ok(r.statusCode === 200 && r.text.includes('Guardar nombre'), 'el detalle tiene el editor de nombre');

  // 4. Corregir el nombre funciona y se propaga a sus otras parejas (mismo teléfono)
  const anaId = dbq("SELECT id FROM players WHERE phone='614000001' AND id IN (SELECT player1_id FROM pairs WHERE id=?)", id1)[0].id;
  r = await admin.req('POST', `/admin/inscripciones/${id1}/jugador`, { player_id: String(anaId), name: 'Ana María Ruiz' });
  ok(r.statusCode === 302 && !r.location.includes('err='), 'corrección de nombre sin error');
  const names = dbq("SELECT name FROM players WHERE phone='614000001'");
  ok(names.length === 2 && names.every(x => x.name === 'Ana María Ruiz'), 'el nombre se corrige en sus dos parejas (propagación por teléfono)');

  // 5. Validaciones: vacío, demasiado largo, jugador ajeno a la pareja
  r = await admin.req('POST', `/admin/inscripciones/${id1}/jugador`, { player_id: String(anaId), name: '   ' });
  ok(r.location.includes('err='), 'nombre vacío rechazado');
  r = await admin.req('POST', `/admin/inscripciones/${id1}/jugador`, { player_id: String(anaId), name: 'A'.repeat(81) });
  ok(r.location.includes('err='), 'nombre de más de 80 caracteres rechazado');
  const jorgeId = dbq("SELECT id FROM players WHERE phone='614000009'")[0].id;
  r = await admin.req('POST', `/admin/inscripciones/${id1}/jugador`, { player_id: String(jorgeId), name: 'Hack' });
  ok(r.statusCode === 302 && r.location === '/admin/inscripciones', 'jugador de otra pareja rechazado');
  ok(dbq("SELECT name FROM players WHERE id=?", jorgeId)[0].name === 'Jorge', 'el nombre de Jorge no se tocó');

  // 6. La pareja inexistente redirige al listado
  r = await admin.req('POST', '/admin/inscripciones/9999/jugador', { player_id: '1', name: 'X' });
  ok(r.statusCode === 302 && r.location === '/admin/inscripciones', 'pareja inexistente redirige al listado');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
