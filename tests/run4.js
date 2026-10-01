// Pruebas v9f-2: cobros en recepción + propagación de la verificación por nº de socio.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3465;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-v9e/data9fc';
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
const dbx = (sql, ...p) => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(DATA + '/season-1.db'); try { return d.prepare(sql).run(...p); } finally { d.close(); } };
const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), recep = makeClient(), pub = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });
  await admin.req('POST', '/admin/ajustes/recepcion-password', { password: 'recep123' });
  const P = (n, name, phone, gender, member) => ({ [`a_p${n}_name`]: name, [`a_p${n}_phone`]: phone, [`a_p${n}_gender`]: gender, [`a_p${n}_level`]: '3', [`a_p${n}_member`]: member });
  await pub.req('POST', '/inscripcion', { modality: 'M', ...P(1, 'Juan', '612000001', 'M', '1001'), ...P(2, 'Pedro', '612000002', 'M', '1002') });
  await pub.req('POST', '/inscripcion', { modality: 'X', ...P(1, 'Juan', '612000001', 'M', '1001'), ...P(2, 'María', '612000003', 'F', '1003') });
  await recep.req('POST', '/recepcion/login', { password: 'recep123' });

  // 1. Verificar a Juan propaga a sus dos filas (mismo nº de socio)
  const juanIds = dbq("SELECT id FROM players WHERE name='Juan' ORDER BY id").map(r => r.id);
  ok(juanIds.length === 2, 'Juan tiene dos filas');
  await recep.req('POST', '/recepcion/verificar', { player_id: String(juanIds[0]), verified: '1', f: 'pendientes', q: '' });
  const jv = dbq("SELECT member_verified FROM players WHERE name='Juan' ORDER BY id").map(r => r.member_verified);
  ok(jv[0] === 1 && jv[1] === 1, 'verificación propagada por nº de socio');

  // 2. Cobros: importes según modalidades
  let r = await recep.req('GET', '/recepcion/cobros');
  ok(r.statusCode === 200 && r.text.includes('25,00 €') && r.text.includes('15,00 €'), 'cobros muestra importes');
  ok(r.text.includes('Juan') && r.text.includes('Masculina + Mixta'), 'Juan con sus dos modalidades');
  ok(r.text.includes('Marcar pagado'), 'botón marcar pagado');

  // 3. Recepción marca pagado a Juan -> se aplica a sus dos parejas
  r = await recep.req('POST', '/recepcion/pago', { phone: '612000001', paid: '1', f: 'pendientes', q: '' });
  ok(r.statusCode === 302 && r.location.includes('/recepcion/cobros'), 'pago redirige a cobros');
  const jp = dbq("SELECT paid FROM players WHERE name='Juan'").map(x => x.paid);
  ok(jp.every(v => v === 1), 'pagado propagado a las parejas de Juan');

  // 4. Filtro de pendientes: Juan ya no sale, Pedro sí
  r = await recep.req('GET', '/recepcion/cobros?f=pendientes');
  ok(!r.text.includes('>Juan<') && r.text.includes('Pedro'), 'pendientes filtra a Juan');
  r = await recep.req('GET', '/recepcion/cobros?f=todos');
  ok(r.text.includes('>Juan<') && r.text.includes('Sí ✓'), 'todos muestra a Juan como pagado');

  // 5. Marcar no pagado
  await recep.req('POST', '/recepcion/pago', { phone: '612000001', paid: '0', f: 'todos', q: '' });
  ok(dbq("SELECT paid FROM players WHERE name='Juan'").every(x => x.paid === 0), 'no pagado propagado');

  // 6. El pago del admin se refleja en cobros
  const mariaId = dbq("SELECT id FROM players WHERE name='María'")[0].id;
  await admin.req('POST', '/admin/inscripciones/2/pago', { player_id: String(mariaId), paid: '1' });
  r = await recep.req('GET', '/recepcion/cobros?f=todos');
  ok(r.text.includes('>María<') && r.text.includes('Sí ✓'), 'pago del admin visible en cobros');

  // 7. Jugador antiguo sin nº de socio: botón desactivado
  const a = dbx("INSERT INTO players(name, phone, level, gender) VALUES('Veterano', '612000099', 3, 'M')");
  const b = dbx("INSERT INTO players(name, phone, level, gender) VALUES('Veterano2', '612000098', 3, 'M')");
  dbx("INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, level_avg, status) VALUES('VET001', 'M', ?, ?, ?, 3, 'pending')",
    Number(a.lastInsertRowid), Number(b.lastInsertRowid), Number(a.lastInsertRowid));
  r = await recep.req('GET', '/recepcion?f=pendientes');
  ok(r.text.includes('Veterano') && r.text.includes('disabled'), 'sin nº de socio el botón sale desactivado');

  // 8. Quitar verificación propaga también
  await recep.req('POST', '/recepcion/verificar', { player_id: String(juanIds[0]), verified: '0', f: 'verificados', q: '' });
  const jv2 = dbq("SELECT member_verified FROM players WHERE name='Juan'").map(x => x.member_verified);
  ok(jv2.every(v => v === 0), 'quitar verificación propaga por nº de socio');

  // 9. Recepción no puede tocar ajustes ni otras rutas del admin
  r = await recep.req('GET', '/admin/ajustes');
  ok(r.statusCode === 302 && r.location.includes('/admin/login'), 'recepción no entra a ajustes');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
