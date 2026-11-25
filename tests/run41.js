// Pruebas Fase 1 Equipos Federados KNB: inscripción pública (solo socios),
// reconocimiento, duplicados, reparto en admin, capitanes, ajustes, CSV y
// control de cobros en recepción. Servidor contra una copia en /tmp:
// NUNCA toca data/*.db reales.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = 3461;
const DATA = '/tmp/test-teams41/data';
const META = path.join(DATA, 'meta.db');
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
fs.rmSync(DATA, { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : (fail++, console.log('FALLO:', name)); };

function makeClient() {
  let cookie = '';
  const req = (method, pth, data, extraHeaders = {}) => new Promise((resolve, reject) => {
    const body = data ? new URLSearchParams(data).toString() : null;
    const r = http.request({ port: PORT, path: pth, method,
      headers: { ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders } }, (res) => {
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
const mdb = (sql, ...p) => {
  const d = new DatabaseSync(META);
  try { return d.prepare(sql).all(...p); } finally { d.close(); }
};
const mrun = (sql, ...p) => {
  const d = new DatabaseSync(META);
  try { return d.prepare(sql).run(...p); } finally { d.close(); }
};

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
srv.on('error', e => { console.log('FALLO: no arranca', e.message); process.exit(1); });

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), recep = makeClient(), pub = makeClient();

  // Socios de prueba en el directorio único (copia).
  mrun(`INSERT INTO club_members(member_no, name, phone, phone_norm, email, active)
        VALUES('100', 'Ana García', '600111222', '600111222', 'ana@example.com', 1)`);
  mrun(`INSERT INTO club_members(member_no, name, phone, phone_norm, email, active)
        VALUES('200', 'Bruno Díaz', '600333444', '600333444', 'bruno@example.com', 1)`);
  mrun(`INSERT INTO club_members(member_no, name, phone, phone_norm, email, active)
        VALUES('300', 'Carla Ruiz', '600555666', '600555666', 'carla@example.com', 1)`);
  const femA = mdb("SELECT id FROM teams WHERE slug = 'femenino-a'")[0].id;
  const vetA = mdb("SELECT id FROM teams WHERE slug = 'veteranos-a'")[0].id;
  ok(mdb('SELECT COUNT(*) c FROM teams WHERE active = 1')[0].c === 10, 'seed: 10 equipos activos');
  ok(mdb("SELECT category FROM teams WHERE slug = 'masculino-a'")[0].category === '2ª', 'seed: Masculino A en 2ª');

  // 1. Portal: la tarjeta ya enlaza a /equipos y no dice «Próximamente».
  let r = await pub.req('GET', '/', null, { Host: 'padel.kanbesport.com' });
  ok(r.statusCode === 200 && r.text.includes('href="/equipos"'), 'portal: tarjeta enlaza a /equipos');
  ok(!r.text.includes('Próximamente'), 'portal: sin «Próximamente»');

  // 2. Índice y formulario públicos.
  r = await pub.req('GET', '/equipos');
  ok(r.statusCode === 200 && r.text.includes('Masculino A') && r.text.includes('Femenino A'), 'GET /equipos lista los 10 equipos');
  ok(r.text.includes('/equipos/inscripcion'), 'GET /equipos enlaza a la inscripción');
  r = await pub.req('GET', '/equipos/inscripcion');
  ok(r.statusCode === 200 && r.text.includes('Nº de socio') && r.text.includes('Reconocerme'), 'GET /equipos/inscripcion muestra el formulario');

  // 3. Reconocimiento móvil + nº de socio.
  r = await pub.req('GET', '/equipos/api/reconocer?phone=600111222&member_no=100');
  const rec = JSON.parse(r.text);
  ok(rec.found === true && rec.name === 'Ana García', 'reconocer: móvil + nº coinciden');
  r = await pub.req('GET', '/equipos/api/reconocer?phone=600111222&member_no=999');
  ok(JSON.parse(r.text).found === false, 'reconocer: nº que no coincide no reconoce');

  // 4. Inscripción con nº de socio que no coincide → error, sin registro.
  const base = { name: 'Ana García', phone: '600111222', email: 'ana@example.com', modality: 'absoluto',
    team_id: String(femA), level: '4', licence_mode: 'recepcion', fee_mode: 'efectivo', consent: '1' };
  r = await pub.req('POST', '/equipos/inscripcion', { ...base, member_no: '999' });
  ok(r.statusCode === 302 && r.location.includes('error='), 'nº de socio erróneo redirige con error');
  r = await pub.req('GET', r.location);
  ok(r.text.includes('no coincide'), 'nº de socio erróneo muestra error claro');
  ok(mdb('SELECT COUNT(*) c FROM team_registrations')[0].c === 0, 'nº erróneo no crea inscripción');

  // 5. Inscripción de no socio → error.
  r = await pub.req('POST', '/equipos/inscripcion', { ...base, member_no: '100', phone: '600999888' });
  ok(r.statusCode === 302 && r.location.includes('error='), 'móvil no socio redirige con error');
  ok(mdb('SELECT COUNT(*) c FROM team_registrations')[0].c === 0, 'no socio no crea inscripción ni ficha');

  // 6. Inscripción correcta de Ana.
  r = await pub.req('POST', '/equipos/inscripcion', { ...base, member_no: '100' });
  ok(r.statusCode === 302 && r.location.includes('ok=1'), 'inscripción correcta redirige con ok');
  let reg = mdb('SELECT * FROM team_registrations WHERE member_no = ? ', '100')[0];
  ok(reg && reg.status === 'pendiente' && reg.team_id === femA, 'Ana queda pendiente con equipo deseado');
  ok(reg.fee_paid === 0 && reg.licence_done === 0, 'Ana sin pagar y sin licencia');

  // 7. Duplicado en la temporada → error.
  r = await pub.req('POST', '/equipos/inscripcion', { ...base, member_no: '100' });
  r = await pub.req('GET', r.location);
  ok(r.text.includes('Ya estás inscrito'), 'duplicado muestra error claro');
  ok(mdb("SELECT COUNT(*) c FROM team_registrations WHERE member_no = '100'")[0].c === 1, 'duplicado no crea segunda fila');

  // 8. Bruno se inscribe en Veteranos A.
  r = await pub.req('POST', '/equipos/inscripcion', { name: 'Bruno Díaz', member_no: '200', phone: '600333444',
    email: 'bruno@example.com', modality: 'veteranos', team_id: String(vetA), level: '5',
    licence_mode: 'domiciliada', fee_mode: 'cuota', consent: '1' });
  ok(r.statusCode === 302 && r.location.includes('ok=1'), 'inscripción Bruno OK');

  // 9. Ficha pública del equipo (sin asignar aún: plantilla vacía).
  r = await pub.req('GET', '/equipos/femenino-a');
  ok(r.statusCode === 200 && r.text.includes('Femenino A') && r.text.includes('no hay jugadores asignados'), 'ficha equipo sin plantilla');
  r = await pub.req('GET', '/equipos/no-existe');
  ok(r.statusCode === 404, 'equipo inexistente da 404');

  // 10. Admin: setup + login + lista.
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });
  r = await admin.req('POST', '/admin/ajustes/recepcion-password', { password: 'recep123' });
  ok(r.statusCode === 302, 'admin crea contraseña de recepción');
  r = await admin.req('GET', '/admin/equipos');
  ok(r.statusCode === 200 && r.text.includes('Ana García') && r.text.includes('Bruno Díaz'), 'admin ve las inscripciones');
  ok(r.text.includes('Inscripciones y reparto') || r.text.includes('Equipos federados'), 'admin lista con título');

  // 11. Reparto: Mathius asigna a Ana a Femenino A.
  const anaId = mdb("SELECT id FROM team_registrations WHERE member_no = '100'")[0].id;
  r = await admin.req('POST', `/admin/equipos/inscripcion/${anaId}/asignar`, { team_id: String(femA), second_team_id: '' });
  ok(r.statusCode === 302, 'asignar redirige');
  reg = mdb('SELECT * FROM team_registrations WHERE id = ?', anaId)[0];
  ok(reg.status === 'asignado' && reg.assigned_team_id === femA, 'Ana asignada a Femenino A');
  r = await pub.req('GET', '/equipos/femenino-a');
  ok(r.text.includes('Ana García'), 'ficha pública muestra a Ana en la plantilla');

  // 12. Capitán: Bruno, capitán de Veteranos A (puede llevar 2 equipos).
  r = await admin.req('POST', `/admin/equipos/equipos/${vetA}/capitanes`, { member_no: '200', role: 'capitan' });
  ok(r.statusCode === 302, 'añadir capitán redirige');
  r = await pub.req('GET', '/equipos/veteranos-a');
  ok(r.text.includes('Bruno Díaz') && r.text.includes('Capitán'), 'ficha muestra al capitán');
  r = await admin.req('POST', `/admin/equipos/equipos/${vetA}/capitanes`, { member_no: '999', role: 'capitan' });
  ok(r.location.includes('error='), 'capitán con nº inexistente da error');

  // 13. Licencia y cuota en admin.
  await admin.req('POST', `/admin/equipos/inscripcion/${anaId}/licencia`, { done: '1' });
  await admin.req('POST', `/admin/equipos/inscripcion/${anaId}/cuota`, { paid: '1' });
  reg = mdb('SELECT * FROM team_registrations WHERE id = ?', anaId)[0];
  ok(reg.licence_done === 1 && reg.fee_paid === 1, 'admin marca licencia y cuota');

  // 14. CSV.
  r = await admin.req('GET', '/admin/equipos/csv');
  ok(r.statusCode === 200 && r.text.includes('Ana García') && r.text.includes('Bruno Díaz'), 'CSV exporta inscripciones');

  // 15. Ajustes: cambiar cuota y crear equipo nuevo.
  r = await admin.req('POST', '/admin/equipos/ajustes', { season: '2027', inscription_open: '1',
    open_date: '', close_date: '', fee_one: '30,00', fee_two: '35,00', licence_price: '56,00', pay_deadline: '2027-02-01' });
  ok(r.statusCode === 302, 'ajustes redirige');
  ok(mdb("SELECT value FROM team_settings WHERE key = 'fee_one_cents'")[0].value === '3000', 'ajustes guardan cuota 30 €');
  r = await admin.req('POST', '/admin/equipos/equipos/nuevo', { name: 'Masculino E', modality: 'absoluto', sex: 'M', category: '7ª', fcp_group: '', slug: '' });
  ok(r.statusCode === 302, 'crear equipo redirige');
  ok(mdb("SELECT COUNT(*) c FROM teams WHERE slug = 'masculino-e'")[0].c === 1, 'equipo nuevo creado con slug');
  r = await admin.req('GET', '/admin/equipos/equipos');
  ok(r.text.includes('Masculino E'), 'admin equipos lista el nuevo equipo');

  // 16. Recepción: login, ve pendientes, marca pago de Bruno; no entra al admin.
  r = await recep.req('GET', '/recepcion/equipos');
  ok(r.statusCode === 302 && r.location.includes('/recepcion/login'), 'recepción sin login redirige');
  r = await recep.req('POST', '/recepcion/login', { password: 'recep123' });
  ok(r.statusCode === 302 && r.location === '/recepcion', 'login recepción OK');
  r = await recep.req('GET', '/recepcion/equipos');
  ok(r.statusCode === 200 && r.text.includes('Bruno Díaz'), 'recepción ve pendientes de pago');
  const brunoId = mdb("SELECT id FROM team_registrations WHERE member_no = '200'")[0].id;
  r = await recep.req('POST', `/recepcion/equipos/${brunoId}/pago`, { paid: '1', f: 'pendientes', q: '' });
  ok(r.statusCode === 302, 'recepción marca pago');
  ok(mdb('SELECT fee_paid FROM team_registrations WHERE id = ?', brunoId)[0].fee_paid === 1, 'Bruno pagado desde recepción');
  r = await recep.req('GET', '/admin/equipos');
  ok(r.statusCode === 302 && r.location.includes('/admin/login'), 'recepción no entra al admin de equipos');

  // 17. Cierre de inscripción → lista de espera; reapertura.
  await admin.req('POST', '/admin/equipos/ajustes', { season: '2027', open_date: '', close_date: '',
    fee_one: '30,00', fee_two: '35,00', licence_price: '56,00', pay_deadline: '2027-02-01' });
  r = await pub.req('POST', '/equipos/inscripcion', { name: 'Carla Ruiz', member_no: '300', phone: '600555666',
    email: 'carla@example.com', modality: 'absoluto', team_id: String(femA), level: '3',
    licence_mode: 'tpv', fee_mode: 'efectivo', consent: '1' });
  ok(r.statusCode === 302 && r.location.includes('ok=1') && r.location.includes('lista=1'), 'inscripción cerrada entra en lista de espera');
  ok(mdb("SELECT status FROM team_registrations WHERE member_no = '300'")[0].status === 'lista_espera', 'Carla en lista de espera');

  console.log(`\nrun41: ${pass} OK, ${fail} FALLOS`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
