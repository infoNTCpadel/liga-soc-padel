// Pruebas: módulo de partidos abiertos (fase 1) en pruebas —
// puerta por flag partidos_public (off = solo admin), lista, crear y salir.
const DATA = '/tmp/test-v9k/data42';
process.env.DATA_DIR = DATA;
require('fs').rmSync(DATA, { recursive: true, force: true });
const B = require('../src/lib/bookings');
// Pistas en la BD principal (las rutas HTTP las leen de ahí).
require('../src/db');
{
  const { DatabaseSync } = require('node:sqlite');
  const sdb = new DatabaseSync(DATA + '/season-1.db');
  try {
    sdb.prepare("INSERT INTO courts(name, active) VALUES('Pista 1', 1), ('Pista 2', 1)").run();
  } catch (e) { /* ya existen */ }
  sdb.close();
}
const ejs = require('ejs'), fs = require('fs');
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

const dayStr = (off) => { const d = new Date(Date.now() + off * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TOM = dayStr(1), DAT = dayStr(2);
B.setCfg('open_min', 540); B.setCfg('close_min', 1320);
B.setCfg('slot_durations', '75,60');
B.upsertMember('M01', 'Ana Lopez', '600000901');
B.upsertMember('M02', 'Beto Mar', '600000902');
B.upsertMember('M03', 'Celia Ruiz', '600000903');
B.setLevel('M01', 4); B.setLevel('M02', 4.5); B.setLevel('M03', 6);
B.setPin('M01', '1111'); B.setPin('M02', '2222');

// ---- 1. flag por defecto apagado ----
ok(B.getConfig().partidos_public === '0', 'flag partidos_public: apagado por defecto');

// ---- 2. open_published ----
let r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 600, duration_min: 75, titular_member_no: 'M01', players: [], open: true, byStaff: true });
const openId = r.id;
ok(B.getBooking(openId).open_published === 1, 'open_published: 1 al crear abierto');
r = B.quickBook({ court_id: 2, court_name: 'Pista 2', date: TOM, start_min: 1080, duration_min: 60, titular_member_no: 'M01', players: [{ name: 'Invitado Uno', member_no: '' }, { name: 'Invitado Dos', member_no: '' }, { name: 'Invitado Tres', member_no: '' }], open: false, byStaff: true });
const closedId = r.id;
ok(B.getBooking(closedId).open_published === 0, 'open_published: 0 al crear cerrado');
B.closeOpenMatch(openId);
ok(B.getBooking(openId).open_published === 0 && B.getBooking(openId).open_spots === 0, 'closeOpenMatch: apaga open_published');
B.openMatchForPlayers(openId);
ok(B.getBooking(openId).open_published === 1 && B.getBooking(openId).open_spots === 3, 'openMatchForPlayers: enciende open_published');

// ---- 3. listOpenMatches ----
let list = B.listOpenMatches(null);
ok(list.some(b => b.id === openId) && !list.some(b => b.id === closedId), 'listOpenMatches: solo abiertos');
ok(list.find(b => b.id === openId).range === '3–5', 'listOpenMatches: rango ±1 del organizador (nivel 4)');
list = B.listOpenMatches({ member_no: 'M03', level: 6 });
ok(!list.some(b => b.id === openId), 'listOpenMatches: nivel 6 no ve el partido de nivel 4');
list = B.listOpenMatches({ member_no: 'M02', level: 4.5 });
ok(list.some(b => b.id === openId), 'listOpenMatches: nivel 4.5 sí lo ve');

// ---- 4. leaveOpenMatch ----
r = B.joinOpenMatch(openId, B.getMember('M02'));
ok(r.ok, 'join: Beto se apunta');
ok(B.getBooking(openId).open_spots === 2, 'join: bajan las plazas');
r = B.leaveOpenMatch(openId, B.getMember('M02'));
ok(r.ok, 'leave: Beto se sale');
ok(B.getBooking(openId).open_spots === 3, 'leave: la plaza vuelve a abrirse');
r = B.leaveOpenMatch(openId, B.getMember('M02'));
ok(r.error && r.error.includes('No estás apuntado'), 'leave: sin estar apuntado → error');
r = B.leaveOpenMatch(openId, B.getMember('M01'));
ok(r.error && r.error.includes('titular'), 'leave: el titular no puede salirse');
r = B.leaveOpenMatch(closedId, B.getMember('M02'));
ok(r.error && r.error.includes('No estás apuntado'), 'leave: no eres jugador → error');
B.cancelBooking(closedId, true);
r = B.leaveOpenMatch(closedId, B.getMember('M02'));
ok(r.error && r.error.includes('disponible'), 'leave: partido anulado → error');
// Partido lleno: al salirse se reabre la plaza (publicado).
r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: DAT, start_min: 600, duration_min: 75, titular_member_no: 'M01', players: [{ name: 'Beto Mar', member_no: 'M02' }, { name: 'Celia Ruiz', member_no: 'M03' }], open: true, byStaff: true });
const fullId = r.id;
ok(B.getBooking(fullId).open_spots === 1, 'lleno: 1 plaza al crear con 3 jugadores');
B.upsertMember('M04', 'Dani Gil', '600000904');
B.setLevel('M04', 4);
B.setPin('M04', '4444');
r = B.joinOpenMatch(fullId, B.getMember('M04'));
ok(r.ok && B.getBooking(fullId).open_spots === 0, 'lleno: al completarse se cierra');
r = B.leaveOpenMatch(fullId, B.getMember('M04'));
ok(r.ok && B.getBooking(fullId).open_spots === 1, 'lleno: al salirse se reabre 1 plaza');
ok(B.getBooking(fullId).open_published === 1, 'lleno: sigue publicado');
// Partido cerrado a mano: al salirse NO se reabre.
B.closeOpenMatch(fullId);
r = B.leaveOpenMatch(fullId, B.getMember('M02'));
ok(r.ok && B.getBooking(fullId).open_spots === 0, 'cerrado a mano: al salirse no se reabre');

// ---- 5. vistas ----
const listaHtml = ejs.render(fs.readFileSync('src/views/partidos/lista.ejs', 'utf8'), {
  list: B.listOpenMatches(null), mine: [], dia: 'semana',
  member: B.getMember('M02'), minToStr: B.minToStr, error: null, info: null,
  filename: 'src/views/partidos/lista.ejs',
});
ok(listaHtml.includes('Partidos abiertos') && listaHtml.includes('Crear partido abierto'), 'lista: cabecera y CTA');
ok(listaHtml.includes('Pista 1') && listaHtml.includes('plaza'), 'lista: muestra el partido con plazas');
const nuevoHtml = ejs.render(fs.readFileSync('src/views/partidos/nuevo.ejs', 'utf8'), {
  member: B.getMember('M01'), courts: [{ id: 1, name: 'Pista 1' }], court: { id: 1, name: 'Pista 1' },
  date: TOM, starts: [{ start_min: 600, durations: [75] }], config: B.getConfig(),
  minToStr: B.minToStr, error: null, filename: 'src/views/partidos/nuevo.ejs',
});
ok(nuevoHtml.includes('Publicar partido abierto') && nuevoHtml.includes('name="start_min"'), 'nuevo: formulario de crear');
const abiertoHtml = ejs.render(fs.readFileSync('src/views/reservas/abierto.ejs', 'utf8'), {
  b: B.getBooking(openId), booker: B.getMember('M01'), mine: false, already: true,
  member: B.getMember('M02'), restricted: false, range: '3–5', minToStr: B.minToStr,
  error: null, from: 'partidos', partidosPublic: true,
  filename: 'src/views/reservas/abierto.ejs',
});
ok(abiertoHtml.includes('Salir del partido') && abiertoHtml.includes('Volver a partidos abiertos'), 'abierto: botón salir y volver a partidos');
const configHtml = ejs.render(fs.readFileSync('src/views/reservas-admin/config.ejs', 'utf8'), {
  error: null, ok: null, config: B.getConfig(), minToStr: B.minToStr, chargePresetsText: '',
  dayRows: [], specialText: '', filename: 'src/views/reservas-admin/config.ejs',
});
ok(configHtml.includes('name="partidos_public"'), 'admin config: interruptor de partidos');

// ---- 6. HTTP: puerta y flujos ----
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3467;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
function makeClient() {
  let cookie = '';
  const req = (method, pth, data, headers) => new Promise((resolve, reject) => {
    const body = data ? new URLSearchParams(data).toString() : null;
    const rq = http.request({ port: PORT, path: pth, method,
      headers: { ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...(headers || {}) } }, (res) => {
      let t = ''; res.on('data', c => t += c); res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc && sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
        resolve({ statusCode: res.statusCode, location: res.headers.location || '', text: t });
      });
    });
    rq.on('error', reject);
    if (body) rq.write(body);
    rq.end();
  });
  return { req };
}
const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
srv.on('error', e => { console.log('FALLO: no arranca', e.message); process.exit(1); });
(async () => {
  await new Promise(rst => setTimeout(rst, 1800));
  // flag off: socio sin admin → fuera
  const socio = makeClient();
  let h = await socio.req('POST', '/reservar/entrar', { member_no: 'M02', pin: '2222', next: '/reservar/mis' });
  ok(h.statusCode === 302, 'login socio');
  h = await socio.req('GET', '/partidos');
  ok(h.statusCode === 302 && h.location === '/reservar', 'puerta off: socio redirigido');
  h = await socio.req('GET', '/partidos/nuevo');
  ok(h.statusCode === 302, 'puerta off: nuevo redirigido');
  // flag off: admin sí entra
  const admin = makeClient();
  h = await admin.req('POST', '/admin/setup', { password: 'test1234' });
  ok(h.statusCode === 302, 'setup admin');
  h = await admin.req('GET', '/partidos');
  ok(h.statusCode === 200 && h.text.includes('Partidos abiertos'), 'puerta off: admin ve la lista');
  // admin enciende el flag
  h = await admin.req('POST', '/admin/reservas/config', { open: '09:00', close: '22:00', slot_durations: '75,60', days_ahead: '7', hold_min: '10', cancel_limit_h: '6', max_active_bookings: '2', guest_price: '', charge_presets: '', reminders_enabled: '0', reminder_hours: '3', partidos_public: '1' });
  ok(h.statusCode === 200 && B.getConfig().partidos_public === '1', 'admin: enciende partidos_public');
  h = await socio.req('GET', '/partidos');
  ok(h.statusCode === 200 && h.text.includes('Partidos abiertos'), 'puerta on: socio ve la lista');
  // crear partido abierto como socio
  h = await socio.req('POST', '/partidos/nuevo', { court_id: '1', date: DAT, start_min: '840', duration_min: '75' });
  ok(h.statusCode === 302 && h.location.startsWith('/reservar/abierto/'), 'crear: redirige al detalle');
  const newId = parseInt(h.location.split('/')[3], 10);
  ok(B.getBooking(newId) && B.getBooking(newId).open_spots === 3, 'crear: reserva abierta con 3 plazas');
  // unirse y salirse desde el detalle
  const socio2 = makeClient();
  await socio2.req('POST', '/reservar/entrar', { member_no: 'M04', pin: '4444', next: '/reservar/mis' });
  h = await socio2.req('POST', '/reservar/abierto/' + newId + '/unirse', {});
  ok(h.statusCode === 302, 'unirse al nuevo partido');
  h = await socio2.req('POST', '/reservar/abierto/' + newId + '/salir', { from: 'partidos' });
  ok(h.statusCode === 302 && h.location.startsWith('/partidos'), 'salir: vuelve a partidos');
  ok(B.getBooking(newId).open_spots === 3, 'salir: la plaza vuelve a abrirse');
  srv.kill();
  console.log(fail === 0 ? `OK run42: ${pass} pruebas` : `FALLOS run42: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO:', e.message); srv.kill(); process.exit(1); });
