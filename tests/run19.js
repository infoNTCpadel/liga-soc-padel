// Pruebas: parrilla socio (reservas propias en lima), tarjeta staff 2 líneas con n/4,
// auto-apuntarse tras login (join=1) con mensaje de nivel, y abrir partido cerrado.
const DATA = '/tmp/test-v9k/data19';
process.env.DATA_DIR = DATA;
require('fs').rmSync(DATA, { recursive: true, force: true });
const B = require('../src/lib/bookings');
const ejs = require('ejs'), fs = require('fs');
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

const dayStr = (off) => { const d = new Date(Date.now() + off * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TOM = dayStr(1);
B.setCfg('open_min', 540); B.setCfg('close_min', 1320);
B.setCfg('slot_durations', '75,60');
B.upsertMember('401', 'Titu Lar', '600000401');
B.upsertMember('402', 'Compa Nero', '600000402');
B.upsertMember('403', 'Alto Nivel', '600000403');
B.setLevel('401', 3); B.setLevel('402', 3.5); B.setLevel('403', 7);
B.setPin('401', '1111'); B.setPin('402', '2222'); B.setPin('403', '3333');
const courts = [{ id: 1, name: 'Pista 1', active: 1 }, { id: 2, name: 'Pista 2', active: 1 }];

// ---- 1. openMatchForPlayers ----
let r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 600, duration_min: 75, titular_member_no: '401', players: [], open: false, byStaff: true });
const closedId = r.id;
let r2 = B.openMatchForPlayers(closedId);
ok(r2.ok && r2.spots === 3, 'abrir cerrada incompleta → 3 plazas (obtenido ' + JSON.stringify(r2) + ')');
ok(B.getBooking(closedId).open_spots === 3, 'queda abierta en la BD');
ok(B.openMatchForPlayers(closedId).error, 'abrir una ya abierta → error');
ok(B.openMatchForPlayers(99999).error, 'abrir inexistente → error');

// ---- 2. fixtures para parrilla / login ----
r = B.quickBook({ court_id: 2, court_name: 'Pista 2', date: TOM, start_min: 840, duration_min: 75, titular_member_no: '401', players: [], open: true, byStaff: true });
const openId = r.id;
r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 960, duration_min: 75, titular_member_no: '401', players: [], open: false, byStaff: true });
const closedId2 = r.id;
ok(B.getBooking(closedId2).open_spots === 0, 'fixture cerrada incompleta lista');

// ---- 3. parrilla pública: reservas propias en lima ----
const pubHtml = ejs.render(fs.readFileSync('src/views/reservas/grid.ejs', 'utf8'), {
  date: TOM, rows: B.slotDay(TOM, { member_no: '401', level: 3 }, courts), courts, config: B.getConfig(), waitStarts: {},
  noCourts: false, closed: false, member: { name: 'Titu Lar', member_no: '401' }, joinedIds: new Set(), staffMode: false,
  info: null, error: null, prev: null, next: null, tabs: [TOM], tabLabel: (d) => d, minToStr: B.minToStr,
  chatEnabled: false, filename: 'src/views/reservas/grid.ejs',
});
ok(pubHtml.includes('chip mine'), 'socio: sus reservas llevan la clase mine');
ok(pubHtml.includes('Mi reserva'), 'socio: cerrada propia etiquetada "Mi reserva"');
ok(pubHtml.includes('Mi partido abierto'), 'socio: abierto propio etiquetado "Mi partido abierto"');
ok(pubHtml.includes('Mi reserva</span>') || pubHtml.includes('>Mi reserva<'), 'socio: leyenda "Mi reserva"');
const pubAnon = ejs.render(fs.readFileSync('src/views/reservas/grid.ejs', 'utf8'), {
  date: TOM, rows: B.slotDay(TOM, null, courts), courts, config: B.getConfig(), waitStarts: {},
  noCourts: false, closed: false, member: null, joinedIds: new Set(), staffMode: false,
  info: null, error: null, prev: null, next: null, tabs: [TOM], tabLabel: (d) => d, minToStr: B.minToStr,
  chatEnabled: false, filename: 'src/views/reservas/grid.ejs',
});
ok(!pubAnon.includes('chip mine'), 'visitante: sin marcas de "mías"');

// ---- 4. parrilla staff: tarjeta 2 líneas, n/4, sin niveles ni "abierto" ----
const g = B.staffGrid(TOM, { staffBase: '/admin/reservas', staffDay: '/admin/reservas/dia', anularPrefix: '/admin/reservas/reservas/' }, courts);
const staffHtml = ejs.render(fs.readFileSync('src/views/reservas/grid.ejs', 'utf8'), {
  ...g, rows: B.slotDay(TOM, null, courts), config: B.getConfig(), waitStarts: {},
  noCourts: false, closed: false, member: null, joinedIds: new Set(), staffMode: true, info: null, error: null,
  filename: 'src/views/reservas/grid.ejs',
});
ok(staffHtml.includes('1/4'), 'staff: la tarjeta muestra el contador 1/4');
ok(!staffHtml.includes('<span class="rchips">'), 'staff: sin chips de nivel en la tarjeta');
ok(!staffHtml.includes('· abierto'), 'staff: sin el texto "· abierto" en la tarjeta');
ok(staffHtml.includes('class="rname"') && staffHtml.includes('class="rtime"'), 'staff: la tarjeta conserva sus dos líneas');

// ---- 5. entrar.ejs conserva join ----
const entrarHtml = ejs.render(fs.readFileSync('src/views/reservas/entrar.ejs', 'utf8'), {
  error: null, next: '/reservar/abierto/' + openId, member_no: '', join: true,
  filename: 'src/views/reservas/entrar.ejs',
});
ok(entrarHtml.includes('name="join"'), 'entrar.ejs: campo oculto join');

// ---- 6. mis.ejs: botón "Abrir partido" en cerrada incompleta ----
const misHtml = ejs.render(fs.readFileSync('src/views/reservas/mis.ejs', 'utf8'), {
  error: null, info: null, area: B.memberArea('401'), minToStr: B.minToStr,
  config: B.getConfig(), member: { name: 'Titu Lar', member_no: '401' }, tab: 'pendientes',
  filename: 'src/views/reservas/mis.ejs',
});
ok(misHtml.includes('>Abrir<'), 'mis: botón Abrir en la cerrada incompleta');
ok(misHtml.includes('/reservar/abierto/' + closedId2 + '/abrir'), 'mis: el botón apunta a la ruta de abrir');

// ---- 7. dia.ejs (admin): aviso de cerradas incompletas ----
const { bookings: dayB, blocks: dayBl } = B.dayDetail(TOM);
const diaHtml = ejs.render(fs.readFileSync('src/views/reservas-admin/dia.ejs', 'utf8'), {
  date: TOM, bookings: dayB, blocks: dayBl, eur: (c) => (c / 100).toFixed(2) + ' €',
  minToStr: B.minToStr, info: null, prev: TOM, next: TOM,
  filename: 'src/views/reservas-admin/dia.ejs',
});
ok(diaHtml.includes('Cerradas con jugadores incompletos'), 'admin: aviso de cerradas incompletas');
ok(diaHtml.includes('/admin/reservas/reservas/' + closedId2 + '/abrir'), 'admin: botón Abrir en el aviso');

// ---- 8. HTTP: auto-apuntarse tras login ----
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3461;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
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
const joined = (bid, mno) => B.bdb.prepare('SELECT 1 FROM booking_players WHERE booking_id = ? AND member_no = ?').get(bid, mno);
const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
srv.on('error', e => { console.log('FALLO: no arranca', e.message); process.exit(1); });
(async () => {
  await new Promise(rst => setTimeout(rst, 1800));
  // 8a. el detalle enlaza al login con join=1
  const anon = makeClient();
  let h = await anon.req('GET', '/reservar/abierto/' + openId);
  ok(h.statusCode === 200 && h.text.includes('Entrar para apuntarme') && h.text.includes('join=1'), 'detalle: "Entrar para apuntarme" con join=1');
  // 8b. nivel compatible → auto-apuntado
  const c2 = makeClient();
  h = await c2.req('POST', '/reservar/entrar', { member_no: '402', pin: '2222', next: '/reservar/abierto/' + openId, join: '1' });
  ok(h.statusCode === 302 && h.location.startsWith('/reservar/mis?ok='), 'login compatible → redirige a Mis reservas con ok (' + h.location.slice(0, 40) + ')');
  ok(!!joined(openId, '402'), 'login compatible → queda apuntado en la BD');
  // 8c. nivel incompatible → aviso claro + vista restringida con el titular
  const c3 = makeClient();
  h = await c3.req('POST', '/reservar/entrar', { member_no: '403', pin: '3333', next: '/reservar/abierto/' + openId, join: '1' });
  const loc = decodeURIComponent(h.location);
  ok(h.statusCode === 302 && h.location === '/reservar/abierto/' + openId + '?err=' + encodeURIComponent('No te has apuntado a este partido (tu nivel es 7) (este partido es de nivel 2–4).'),
    'login incompatible → detalle con err de nivel, URL bien formada (' + loc.slice(0, 90) + ')');
  ok(!joined(openId, '403'), 'login incompatible → NO queda apuntado');
  h = await c3.req('GET', '/reservar/abierto/' + openId + '?err=prueba');
  ok(h.statusCode === 200 && h.text.includes('Titular:') && h.text.includes('Titu Lar'), 'vista restringida: muestra el titular');
  ok(!h.text.includes('<h4>Jugadores</h4>') && !h.text.includes('Apuntarme'), 'vista restringida: sin lista de jugadores ni botón de unirse');
  const c3b = makeClient();
  await c3b.req('POST', '/reservar/entrar', { member_no: '403', pin: '3333' });
  h = await c3b.req('GET', '/reservar/abierto/' + openId);
  ok(h.statusCode === 302 && h.location === '/reservar', 'sin err: el nivel incompatible sigue sin ver el detalle');
  // 8d. el socio abre su cerrada incompleta
  const c1 = makeClient();
  await c1.req('POST', '/reservar/entrar', { member_no: '401', pin: '1111' });
  h = await c1.req('POST', '/reservar/abierto/' + closedId2 + '/abrir');
  ok(h.statusCode === 302 && h.location.startsWith('/reservar/mis?ok='), 'socio abre su cerrada → ok');
  ok(B.getBooking(closedId2).open_spots === 3, 'la cerrada queda abierta con 3 plazas');
  // 8e. otro socio no puede abrirla
  h = await c2.req('POST', '/reservar/abierto/' + closedId2 + '/abrir');
  ok(h.statusCode === 302 && h.location === '/reservar/mis', 'abrir partido ajeno → redirige sin cambios');
  srv.kill();
  console.log(fail === 0 ? 'OK run19: ' + pass + ' pruebas' : 'FALLOS run19: ' + fail + ' de ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO: excepción', e.message); srv.kill(); process.exit(1); });
