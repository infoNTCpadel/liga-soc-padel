// Pruebas v9f: nº de socio + verificación por recepción (acceso limitado).
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 3459;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: '/tmp/test-v9e/data9f' };
require('fs').rmSync('/tmp/test-v9e/data9f', { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : (fail++, console.log('FALLO:', name)); };

function makeClient() {
  let cookie = '';
  const req = (method, pth, data) => new Promise((resolve, reject) => {
    const body = data ? new URLSearchParams(data).toString() : null;
    const r = http.request({ port: PORT, path: pth, method,
      headers: { ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let t = ''; res.on('data', c => t += c); res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc && sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
        resolve({ statusCode: res.statusCode, location: res.headers.location || '', text: t });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  return { req };
}
const dbq = (sql, ...p) => {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync('/tmp/test-v9e/data9f/season-1.db');
  try { return d.prepare(sql).all(...p); } finally { d.close(); }
};

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
srv.on('error', e => { console.log('FALLO: no arranca', e.message); process.exit(1); });

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), recep = makeClient(), pub = makeClient();

  await admin.req('POST', '/admin/setup', { password: 'admin12345' });

  // 1. Login de recepción sin contraseña configurada
  let r = await recep.req('GET', '/recepcion/login');
  ok(r.statusCode === 200 && r.text.includes('Aún no hay contraseña'), 'login recepción avisa sin contraseña');

  // 2. Admin crea contraseña de recepción
  r = await admin.req('POST', '/admin/ajustes/recepcion-password', { password: 'recep123' });
  ok(r.statusCode === 302, 'crear contraseña recepción redirige');
  r = await admin.req('GET', '/admin/ajustes');
  ok(r.text.includes('configurado'), 'ajustes muestra recepción configurado');

  // 3. Inscripción pública con nº de socio
  const P = (pfx, n, name, phone, gender, member) => ({
    [`${pfx}_p${n}_name`]: name, [`${pfx}_p${n}_phone`]: phone, [`${pfx}_p${n}_gender`]: gender,
    [`${pfx}_p${n}_level`]: '3', [`${pfx}_p${n}_member`]: member });
  r = await pub.req('POST', '/inscripcion', { modality: 'M',
    ...P('a', 1, 'Juan', '612000001', 'M', '1001'), ...P('a', 2, 'Pedro', '612000002', 'M', '1002') });
  ok(r.statusCode === 200 && r.text.includes('Inscripción recibida'), 'inscripción con socio OK');
  let pls = dbq('SELECT name, member_no, member_verified FROM players ORDER BY id');
  ok(pls[0].member_no === '1001' && pls[0].member_verified === 0, 'Juan guarda nº 1001 sin verificar');
  ok(pls[1].member_no === '1002' && pls[1].member_verified === 0, 'Pedro guarda nº 1002 sin verificar');
  ok(dbq('SELECT status FROM pairs')[0].status === 'pending', 'pareja queda pendiente');

  // 4. Sin nº de socio -> error
  r = await pub.req('POST', '/inscripcion', { modality: 'M',
    ...P('a', 1, 'Luis', '612000010', 'M', ''), ...P('a', 2, 'Marco', '612000011', 'M', '1009') });
  ok(r.statusCode === 200 && r.text.includes('nº de socio'), 'falta nº de socio da error');

  // 5. Recepción entra y ve pendientes
  r = await recep.req('GET', '/recepcion');
  ok(r.statusCode === 302 && r.location.includes('/recepcion/login'), 'recepción sin login redirige');
  r = await recep.req('POST', '/recepcion/login', { password: 'mal' });
  ok(r.text.includes('incorrecta'), 'contraseña mala da error');
  r = await recep.req('POST', '/recepcion/login', { password: 'recep123' });
  ok(r.statusCode === 302 && r.location === '/recepcion', 'login recepción OK');
  r = await recep.req('GET', '/recepcion');
  ok(r.text.includes('Juan') && r.text.includes('Verificar'), 'recepción ve pendientes');

  // 6. Recepción verifica a Juan
  const juanId = dbq("SELECT id FROM players WHERE name='Juan'")[0].id;
  r = await recep.req('POST', '/recepcion/verificar', { player_id: String(juanId), verified: '1', f: 'pendientes', q: '' });
  ok(r.statusCode === 302, 'verificar redirige');
  ok(dbq('SELECT member_verified FROM players WHERE id=?', juanId)[0].member_verified === 1, 'Juan verificado');

  // 7. Recepción NO puede entrar al admin
  r = await recep.req('GET', '/admin');
  ok(r.statusCode === 302 && r.location.includes('/admin/login'), 'recepción no entra al admin');
  r = await recep.req('POST', '/admin/inscripciones/1/estado', { status: 'active' });
  ok(r.statusCode === 302 && r.location.includes('/admin/login'), 'recepción no puede activar parejas');

  // 8. Admin no puede activar con Pedro sin verificar
  r = await admin.req('POST', '/admin/inscripciones/1/estado', { status: 'active' });
  ok(r.statusCode === 302 && r.location.includes('err='), 'activación bloqueada redirige con err');
  r = await admin.req('GET', r.location);
  ok(r.text.includes('sin verificar'), 'aviso de socio sin verificar visible');
  ok(dbq('SELECT status FROM pairs WHERE id=1')[0].status === 'pending', 'pareja sigue pendiente');

  // 9. Verifican a Pedro -> activación OK
  const pedroId = dbq("SELECT id FROM players WHERE name='Pedro'")[0].id;
  await recep.req('POST', '/recepcion/verificar', { player_id: String(pedroId), verified: '1', f: 'pendientes', q: '' });
  r = await admin.req('POST', '/admin/inscripciones/1/estado', { status: 'active' });
  ok(dbq('SELECT status FROM pairs WHERE id=1')[0].status === 'active', 'activación OK tras verificar');

  // 10. Segunda modalidad: el nº verificado se hereda
  r = await pub.req('POST', '/inscripcion', { modality: 'X',
    ...P('a', 1, 'Juan', '612000001', 'M', '1001'), ...P('a', 2, 'María', '612000003', 'F', '1003') });
  ok(r.statusCode === 200 && r.text.includes('Inscripción recibida'), 'inscripción mixta OK');
  const jx = dbq("SELECT member_verified FROM players WHERE name='Juan' ORDER BY id DESC")[0].member_verified;
  const mx = dbq("SELECT member_verified FROM players WHERE name='María'")[0].member_verified;
  ok(jx === 1 && mx === 0, 'Juan autoverificado en 2ª modalidad, María no');

  // 11. Distintivo en el listado y detalle del admin
  r = await admin.req('GET', '/admin/inscripciones');
  ok(r.text.includes('socio sin verificar'), 'listado muestra distintivo');
  r = await admin.req('GET', '/admin/inscripciones/2');
  ok(r.text.includes('Nº socio') && r.text.includes('Marcar verificado'), 'detalle muestra socio y botón');

  // 12. Admin corrige un nº mal escrito -> se desverifica
  const mariaId = dbq("SELECT id FROM players WHERE name='María'")[0].id;
  r = await admin.req('POST', '/admin/inscripciones/2/socio', { player_id: String(mariaId), action: 'save', member_no: '1004' });
  const mrow = dbq('SELECT member_no, member_verified FROM players WHERE id=?', mariaId)[0];
  ok(mrow.member_no === '1004' && mrow.member_verified === 0, 'corregir nº lo desverifica');

  // 13. CSV con columnas de socio
  r = await admin.req('GET', '/admin/inscripciones.csv');
  const lines = r.text.split('\n');
  ok(lines[0].includes('"socio1";"socio_verificado1"') && lines[0].includes('"socio2";"socio_verificado2"'), 'CSV tiene columnas de socio');
  ok(lines[1].includes('"1001";"sí"') && lines[2].includes('"1004";"no"'), 'CSV con valores correctos');

  // 14. Alta manual sin nº -> error; con nº nuevos -> pendiente; con nº verificados -> activa
  const M = (n, name, phone, gender, member) => ({ [`p${n}_name`]: name, [`p${n}_phone`]: phone, [`p${n}_gender`]: gender, [`p${n}_level`]: '3', [`p${n}_member`]: member });
  r = await admin.req('POST', '/admin/parejas/nueva', { category: 'F', ...M(1, 'Elena', '612000004', 'F', ''), ...M(2, 'Sara', '612000005', 'F', '1005') });
  ok(r.text.includes('nº de socio'), 'alta manual exige nº de socio');
  r = await admin.req('POST', '/admin/parejas/nueva', { category: 'X', ...M(1, 'Iván', '612000050', 'M', '2001'), ...M(2, 'Nora', '612000051', 'F', '2002') });
  let plast = dbq('SELECT id, status FROM pairs ORDER BY id DESC LIMIT 1')[0];
  ok(plast.status === 'pending', 'alta manual sin verificar queda pendiente');
  const ivanId = dbq("SELECT id FROM players WHERE name='Iván'")[0].id;
  const noraId = dbq("SELECT id FROM players WHERE name='Nora'")[0].id;
  await recep.req('POST', '/recepcion/verificar', { player_id: String(ivanId), verified: '1', f: 'pendientes', q: '' });
  await recep.req('POST', '/recepcion/verificar', { player_id: String(noraId), verified: '1', f: 'pendientes', q: '' });
  // Hugo juega la mixta por vía pública y se verifica su nº
  r = await pub.req('POST', '/inscripcion', { modality: 'X',
    ...P('a', 1, 'Hugo', '612000052', 'M', '2003'), ...P('a', 2, 'Vega', '612000053', 'F', '2004') });
  ok(r.statusCode === 200, 'inscripción pública de Hugo OK');
  const hugoId = dbq("SELECT id FROM players WHERE name='Hugo'")[0].id;
  await recep.req('POST', '/recepcion/verificar', { player_id: String(hugoId), verified: '1', f: 'pendientes', q: '' });
  // Manual con nº ya verificados (Iván M+X, Hugo M+X) -> activa directamente
  r = await admin.req('POST', '/admin/parejas/nueva', { category: 'M', ...M(1, 'Iván', '612000050', 'M', '2001'), ...M(2, 'Hugo', '612000052', 'M', '2003') });
  plast = dbq('SELECT category, status FROM pairs ORDER BY id DESC LIMIT 1')[0];
  ok(plast.category === 'M' && plast.status === 'active', 'alta manual con socios verificados crea activa');

  // 15. Cambio de pareja exige nº de socio
  const code = dbq('SELECT code FROM pairs WHERE id=1')[0].code;
  const pairCli = makeClient();
  r = await pairCli.req('POST', '/acceso', { code });
  ok(r.statusCode === 302, 'acceso de pareja activa OK');
  r = await pairCli.req('POST', '/pareja/cambio', { old_player_id: String(pedroId), new_name: 'Tomás', new_phone: '612000020', new_level: '3', new_gender: 'M' });
  ok(r.text.includes('nº de socio'), 'cambio sin socio da error');
  r = await pairCli.req('POST', '/pareja/cambio', { old_player_id: String(pedroId), new_name: 'Tomás', new_phone: '612000020', new_level: '3', new_gender: 'M', new_member: '2009' });
  ok(r.statusCode === 302, 'cambio con socio OK');
  const ch = dbq('SELECT new_member_no, status FROM pair_changes ORDER BY id DESC LIMIT 1')[0];
  ok(ch.new_member_no === '2009' && ch.status === 'pending', 'solicitud guarda nº de socio');
  const chId = dbq('SELECT id FROM pair_changes ORDER BY id DESC LIMIT 1')[0].id;
  r = await admin.req('POST', `/admin/cambios/${chId}/aprobar`);
  const np = dbq("SELECT member_no, member_verified FROM players WHERE name='Tomás'")[0];
  ok(np.member_no === '2009' && np.member_verified === 0, 'aprobación inserta socio sin verificar');

  // 16. Pestaña de verificados y quitar verificación
  r = await recep.req('GET', '/recepcion?f=verificados');
  ok(r.text.includes('Juan') && r.text.includes('Quitar verificación'), 'pestaña verificados OK');
  r = await recep.req('POST', '/recepcion/verificar', { player_id: String(juanId), verified: '0', f: 'verificados', q: '' });
  ok(dbq('SELECT member_verified FROM players WHERE id=?', juanId)[0].member_verified === 0, 'quitar verificación OK');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
