// Pruebas: añadir jugador desde el panel de la parrilla staff; pago "pagado"
// que se mantiene; invitados identificados en bookingsJson y en el panel.
const DATA = '/tmp/test-v9k/data21';
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
B.upsertMember('601', 'Titu Lar', '600000601');
B.upsertMember('602', 'Compa Nero', '600000602');
B.upsertMember('603', 'Tercer Socio', '600000603');
B.upsertMember('604', 'Cuarto Socio', '600000604');
B.setPin('601', '1111');
const courts = [{ id: 1, name: 'Pista 1', active: 1 }, { id: 2, name: 'Pista 2', active: 1 }];

// ---- 1. B.addPlayer ----
let r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 600, duration_min: 75, titular_member_no: '601', players: [], open: true, byStaff: true });
const bid = r.id;
r = B.addPlayer(bid, 'Compa Nero', '602');
ok(r.ok, 'addPlayer: socio válido añadido');
let pls = B.getBooking(bid).players;
ok(pls.length === 2 && pls[1].member_no === '602' && pls[1].is_guest === 0, 'addPlayer: el socio queda como no invitado');
r = B.addPlayer(bid, 'Invitado Externo', '');
ok(r.ok && B.getBooking(bid).players[2].is_guest === 1, 'addPlayer: sin nº de socio → invitado');
ok(B.getBooking(bid).payment_status === 'pending', 'addPlayer: con invitado el pago pasa a pendiente');
r = B.addPlayer(bid, 'Compa Nero', '602');
ok(r.error && r.error.includes('ya está'), 'addPlayer: duplicado → error');
r = B.addPlayer(bid, 'Falso', '999');
ok(r.error && r.error.includes('no válido'), 'addPlayer: nº de socio inexistente → error');
r = B.addPlayer(bid, '', '');
ok(r.error && r.error.includes('nombre'), 'addPlayer: sin nombre → error');
r = B.addPlayer(bid, 'Cuarto Socio', '604');
ok(r.ok, 'addPlayer: cuarto jugador OK');
r = B.addPlayer(bid, 'Quinto', '');
ok(r.error && r.error.includes('completo'), 'addPlayer: con 4 jugadores → error');
ok(B.getBooking(bid).open_spots === 0, 'addPlayer: al completar se cierran las plazas');
B.cancelBooking(bid, true);
r = B.addPlayer(bid, 'Otro', '');
ok(r.error && r.error.includes('disponible'), 'addPlayer: reserva anulada → error');

// ---- 2. pago: 'paid' se mantiene ----
r = B.quickBook({ court_id: 2, court_name: 'Pista 2', date: TOM, start_min: 840, duration_min: 75, titular_member_no: '601', players: [{ name: 'Invitado Externo', member_no: '' }], open: false, byStaff: true });
const bid2 = r.id;
ok(B.getBooking(bid2).payment_status === 'pending', 'pago: con invitado → pendiente');
ok(B.setBookingPaid(bid2, true) === 'paid' && B.getBooking(bid2).payment_status === 'paid', 'pago: marcar pagado → paid');
B.addPlayer(bid2, 'Tercer Socio', '603');
ok(B.getBooking(bid2).payment_status === 'paid', 'pago: editar jugadores NO revierte el pagado manual');
ok(B.setBookingPaid(bid2, false) === 'pending', 'pago: volver a pendiente → recalcula (hay invitado)');
ok(B.setBookingPaid(bid2, true) === 'paid', 'pago: pagado de nuevo');
r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 1080, duration_min: 60, titular_member_no: '603', players: [], open: false, byStaff: true });
const bid3 = r.id;
ok(B.setBookingPaid(bid3, false) === 'ok', 'pago: sin invitados, volver a pendiente → ok automático');

// ---- 3. staffGrid: bookingsJson con is_guest ----
const g = B.staffGrid(TOM, { staffBase: '/admin/reservas', staffDay: '/admin/reservas/dia', anularPrefix: '/admin/reservas/reservas/' }, courts);
const data = JSON.parse(g.bookingsJson);
const jb = data.find(b => b.id === bid2);
ok(jb && jb.players.some(p => p.is_guest === 1) && jb.players.some(p => p.is_guest === 0), 'bookingsJson: los jugadores llevan is_guest');

// ---- 4. render: panel con añadir jugador, pago con nombres, chips de nivel ----
const staffHtml = ejs.render(fs.readFileSync('src/views/reservas/grid.ejs', 'utf8'), {
  ...g, rows: B.slotDay(TOM, null, courts), config: B.getConfig(), waitStarts: {},
  noCourts: false, closed: false, member: null, joinedIds: new Set(), staffMode: true, info: null, error: null,
  filename: 'src/views/reservas/grid.ejs',
});
ok(staffHtml.includes('Añadir jugador'), 'panel: sección «Añadir jugador»');
ok(staffHtml.includes('/admin/reservas/socios/buscar'), 'panel: buscador apunta al endpoint staff');
ok(staffHtml.includes('/anadir-jugador'), 'panel: acción anadir-jugador');
ok(staffHtml.includes('Pago pendiente') && staffHtml.includes('Marcar pagado'), 'panel: pago pendiente con botón de marcar pagado');
ok(staffHtml.includes('LVL[p.member_no]'), 'panel: chips de nivel usan member_no');
ok(!staffHtml.includes('LVL[p.member_number]'), 'panel: sin la clave errónea member_number');
const diaHtml = ejs.render(fs.readFileSync('src/views/reservas-admin/dia.ejs', 'utf8'), {
  date: TOM, bookings: B.dayDetail(TOM).bookings, blocks: [], eur: (c) => (c / 100).toFixed(2) + ' €',
  minToStr: B.minToStr, info: null, prev: TOM, next: TOM, filename: 'src/views/reservas-admin/dia.ejs',
});
ok(diaHtml.includes('>Pagado<'), 'admin día: estado pagado en la tabla compacta');
const fichaHtml = ejs.render(fs.readFileSync('src/views/reservas-admin/ficha.ejs', 'utf8'), {
  b: B.getBooking(bid2), eur: (c) => (c / 100).toFixed(2) + ' €',
  minToStr: B.minToStr, info: null, error: null, chargePresets: [],
  filename: 'src/views/reservas-admin/ficha.ejs',
});
ok(fichaHtml.includes('>Pagado<') && fichaHtml.includes('Marcar pendiente'), 'ficha: estado pagado con botón de revertir');

// ---- 5. HTTP: endpoints JSON del panel ----
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3462;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
function makeClient() {
  let cookie = '';
  const req = (method, pth, data, json) => new Promise((resolve, reject) => {
    const body = data ? (json ? JSON.stringify(data) : new URLSearchParams(data).toString()) : null;
    const r = http.request({ port: PORT, path: pth, method,
      headers: { ...(body ? { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let t = ''; res.on('data', c => t += c); res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc && sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        resolve({ statusCode: res.statusCode, location: res.headers.location || '', text: t, json: j });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  return { req };
}
const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
srv.on('error', e => { console.log('FALLO: no arranca', e.message); process.exit(1); });
(async () => {
  await new Promise(rst => setTimeout(rst, 1800));
  const c = makeClient();
  // alta de admin → sesión
  let h = await c.req('POST', '/admin/setup', { password: 'test1234' });
  ok(h.statusCode === 302, 'setup admin → sesión');
  // añadir jugador vía panel (admin)
  h = await c.req('POST', '/admin/reservas/reservas/' + bid3 + '/anadir-jugador', { name: 'Compa Nero', member_no: '602' }, true);
  ok(h.statusCode === 200 && h.json && h.json.ok && h.json.booking.players.some(p => p.member_no === '602'), 'HTTP admin: anadir-jugador añade al socio (' + h.text.slice(0, 60) + ')');
  // añadir invitado vía recepción (la sesión admin vale)
  h = await c.req('POST', '/recepcion/reservas/' + bid3 + '/anadir-jugador', { name: 'Invitado Web', member_no: '' }, true);
  ok(h.statusCode === 200 && h.json && h.json.ok && h.json.booking.players.some(p => p.is_guest === 1), 'HTTP recepción: anadir-jugador añade invitado');
  ok(h.json.booking.payment_status === 'pending', 'HTTP: con invitado el pago queda pendiente');
  // marcar pagado vía panel
  h = await c.req('POST', '/recepcion/reservas/' + bid3 + '/pago', { paid: '1', json: '1' }, true);
  ok(h.statusCode === 200 && h.json && h.json.payment_status === 'paid', 'HTTP: pago json → paid');
  // añadir otro jugador NO revierte el pagado
  h = await c.req('POST', '/recepcion/reservas/' + bid3 + '/anadir-jugador', { name: 'Cuarto Socio', member_no: '604' }, true);
  ok(h.json.ok && h.json.booking.payment_status === 'paid', 'HTTP: añadir jugador mantiene el pagado');
  // duplicado vía HTTP
  h = await c.req('POST', '/recepcion/reservas/' + bid3 + '/anadir-jugador', { name: 'Cuarto Socio', member_no: '604' }, true);
  ok(h.json && !h.json.ok && h.json.error.includes('ya está'), 'HTTP: duplicado → error JSON');
  srv.kill();
  console.log(fail === 0 ? `OK run21: ${pass} pruebas` : `FALLOS run21: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO:', e.message); srv.kill(); process.exit(1); });
