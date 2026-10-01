// Pruebas v9h: el admin puede cambiar la modalidad de una pareja.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3466;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-v9e/data9h';
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
  const admin = makeClient(), pub = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });
  const P = (n, name, phone, gender, member) => ({ [`a_p${n}_name`]: name, [`a_p${n}_phone`]: phone, [`a_p${n}_gender`]: gender, [`a_p${n}_level`]: '3', [`a_p${n}_member`]: member });
  const cat = (code) => dbq('SELECT category FROM pairs WHERE code = ?', code)[0].category;

  // 1. Dos mujeres inscritas por error en masculina (el caso real)
  let r = await pub.req('POST', '/inscripcion', { modality: 'M', ...P(1, 'Ana', '613000001', 'F', '2001'), ...P(2, 'Bea', '613000002', 'F', '2002') });
  ok(r.text.includes('Inscripción recibida'), 'inscripción de Ana+Bea en M aceptada (como en la realidad)');
  const id1 = dbq("SELECT id FROM pairs WHERE player1_id IN (SELECT id FROM players WHERE name='Ana')")[0].id;
  ok(cat(dbq('SELECT code FROM pairs WHERE id=?', id1)[0].code) === 'M', 'la pareja está en M');

  // 2. El detalle muestra el editor de modalidad
  r = await admin.req('GET', '/admin/inscripciones/' + id1);
  ok(r.statusCode === 200 && r.text.includes('Cambiar modalidad'), 'el detalle tiene el editor de modalidad');

  // 3. Cambiar a femenina: funciona
  r = await admin.req('POST', `/admin/inscripciones/${id1}/categoria`, { category: 'F' });
  ok(r.statusCode === 302 && !r.location.includes('err='), 'cambio M→F sin error');
  ok(dbq('SELECT category FROM pairs WHERE id=?', id1)[0].category === 'F', 'la pareja ahora es F');

  // 4. Sexo incompatible: pareja mixta no puede pasar a masculina
  await pub.req('POST', '/inscripcion', { modality: 'X', ...P(1, 'Carlos', '613000003', 'M', '2003'), ...P(2, 'Diana', '613000004', 'F', '2004') });
  const id2 = dbq("SELECT id FROM pairs WHERE player1_id IN (SELECT id FROM players WHERE name='Carlos')")[0].id;
  r = await admin.req('POST', `/admin/inscripciones/${id2}/categoria`, { category: 'M' });
  ok(r.location.includes('err=') && dbq('SELECT category FROM pairs WHERE id=?', id2)[0].category === 'X', 'mixta no puede pasar a M');

  // 5. No se puede repetir modalidad: Ana ya está en F y en X
  await pub.req('POST', '/inscripcion', { modality: 'X', ...P(1, 'Ana', '613000001', 'F', '2001'), ...P(2, 'Jorge', '613000009', 'M', '2009') });
  r = await admin.req('POST', `/admin/inscripciones/${id1}/categoria`, { category: 'X' });
  ok(r.location.includes('err=') && dbq('SELECT category FROM pairs WHERE id=?', id1)[0].category === 'F', 'no se puede repetir modalidad');

  // 6. No se puede combinar M+F: Luis está en M y en X
  await pub.req('POST', '/inscripcion', { modality: 'M', ...P(1, 'Luis', '613000006', 'M', '2006'), ...P(2, 'Pedro', '613000007', 'M', '2007') });
  await pub.req('POST', '/inscripcion', { modality: 'X', ...P(1, 'Luis', '613000006', 'M', '2006'), ...P(2, 'Marta', '613000008', 'F', '2008') });
  const id5 = dbq("SELECT id FROM pairs WHERE player1_id IN (SELECT id FROM players WHERE name='Marta') OR player2_id IN (SELECT id FROM players WHERE name='Marta')")[0].id;
  r = await admin.req('POST', `/admin/inscripciones/${id5}/categoria`, { category: 'F' });
  ok(r.location.includes('err=') && dbq('SELECT category FROM pairs WHERE id=?', id5)[0].category === 'X', 'no se puede combinar M+F');

  // 7. Con grupos generados se bloquea (aunque el cambio fuese válido en lo demás)
  const id4 = dbq("SELECT id FROM pairs WHERE player1_id IN (SELECT id FROM players WHERE name='Luis' AND phone='613000006') AND category='M'")[0].id;
  const gg = dbx("INSERT INTO groups(category, round_no, group_no) VALUES('M', 1, 1)");
  dbx('INSERT INTO group_members(group_id, pair_id) VALUES(?, ?)', Number(gg.lastInsertRowid), id4);
  r = await admin.req('POST', `/admin/inscripciones/${id4}/categoria`, { category: 'F' });
  ok(r.location.includes('err=') && decodeURIComponent(r.location).includes('grupos o partidos'), 'bloqueado con grupos generados');
  r = await admin.req('GET', '/admin/inscripciones/' + id4);
  ok(r.text.includes('ya tiene grupos o partidos generados'), 'el detalle avisa del bloqueo');
  dbx('DELETE FROM group_members'); dbx('DELETE FROM groups');
  // Sin el bloqueo, el cambio llega a la validación de sexo (Luis+Pedro no pueden ser F)
  r = await admin.req('POST', `/admin/inscripciones/${id4}/categoria`, { category: 'F' });
  ok(r.location.includes('err=') && decodeURIComponent(r.location).includes('sexo'), 'sin grupos, falla por sexo (llega a validar)');

  // 8. Categoría inválida y misma categoría
  r = await admin.req('POST', `/admin/inscripciones/${id1}/categoria`, { category: 'Z' });
  ok(r.location.includes('err='), 'categoría inválida rechazada');
  r = await admin.req('POST', `/admin/inscripciones/${id1}/categoria`, { category: 'F' });
  ok(r.statusCode === 302 && !r.location.includes('err='), 'misma categoría: sin error');

  // 9. Modalidad no válida en URL de pareja inexistente
  r = await admin.req('POST', '/admin/inscripciones/9999/categoria', { category: 'F' });
  ok(r.statusCode === 302 && r.location === '/admin/inscripciones', 'pareja inexistente redirige al listado');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
