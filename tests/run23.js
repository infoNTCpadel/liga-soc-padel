// Pruebas: quitar jugadores desde el panel staff; formulario de cargo del
// día de admin compacto y con selector de jugador.
const DATA = '/tmp/test-v9k/data23';
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
B.upsertMember('801', 'Titu Lar', '600000801');
B.upsertMember('802', 'Compa Nero', '600000802');
B.setPin('801', '1111');
const courts = [{ id: 1, name: 'Pista 1', active: 1 }];

let r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 600, duration_min: 75, titular_member_no: '801', players: [{ name: 'Compa Nero', member_no: '802' }, { name: 'Invitado Externo', member_no: '' }], open: false, byStaff: true });
const bid = r.id;
const pls0 = B.getBooking(bid).players;
const pTit = pls0[0], pSocio = pls0.find(p => p.member_no === '802'), pGuest = pls0.find(p => p.is_guest === 1);
B.addCharge(bid, 'Pelotas', 300, pGuest.id);

// ---- 1. B.removePlayer ----
r = B.removePlayer(bid, pSocio.id);
ok(r.ok, 'removePlayer: quita a un socio no titular');
ok(B.getBooking(bid).players.length === 2, 'removePlayer: quedan 2 jugadores');
r = B.removePlayer(bid, pGuest.id);
ok(r.ok, 'removePlayer: quita al invitado');
ok(B.getBooking(bid).payment_status === 'ok', 'removePlayer: sin invitados el pago vuelve a ok');
const chs = B.chargeList(bid);
ok(chs.length === 1 && chs[0].player_name === null, 'removePlayer: el cargo del invitado pasa a la reserva');
r = B.removePlayer(bid, pTit.id);
ok(r.error && r.error.includes('titular'), 'removePlayer: el titular no se puede quitar');
r = B.removePlayer(bid, 99999);
ok(r.error && r.error.includes('no encontrado'), 'removePlayer: jugador inexistente → error');
r = B.removePlayer(99999, pTit.id);
ok(r.error && r.error.includes('disponible'), 'removePlayer: reserva inexistente → error');
B.cancelBooking(bid, true);
r = B.removePlayer(bid, pTit.id);
ok(r.error && r.error.includes('disponible'), 'removePlayer: reserva anulada → error');

// ---- 2. render: panel con ✕ y formulario de cargo compacto ----
r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 840, duration_min: 75, titular_member_no: '801', players: [{ name: 'Compa Nero', member_no: '802' }], open: true, byStaff: true });
const bid2 = r.id;
const g = B.staffGrid(TOM, { staffBase: '/admin/reservas', staffDay: '/admin/reservas/dia', anularPrefix: '/admin/reservas/reservas/' }, courts);
const data = JSON.parse(g.bookingsJson);
ok(data.find(b => b.id === bid2).players.every(p => p.id > 0), 'bookingsJson: jugadores con id');
const staffHtml = ejs.render(fs.readFileSync('src/views/reservas/grid.ejs', 'utf8'), {
  ...g, rows: B.slotDay(TOM, null, courts), config: B.getConfig(), waitStarts: {},
  noCourts: false, closed: false, member: null, joinedIds: new Set(), staffMode: true, info: null, error: null,
  filename: 'src/views/reservas/grid.ejs',
});
ok(staffHtml.includes('data-act="rm"'), 'panel: botón ✕ para quitar jugador');
ok(staffHtml.includes('/quitar-jugador'), 'panel: acción quitar-jugador');
const diaHtml = ejs.render(fs.readFileSync('src/views/reservas-admin/dia.ejs', 'utf8'), {
  date: TOM, bookings: B.dayDetail(TOM).bookings, blocks: [], eur: (c) => (c / 100).toFixed(2) + ' €',
  minToStr: B.minToStr, info: null, prev: TOM, next: TOM, filename: 'src/views/reservas-admin/dia.ejs',
});
ok(diaHtml.includes('name="player_id"'), 'admin día: el formulario de cargo tiene selector de jugador');
ok(diaHtml.includes('display:flex'), 'admin día: formulario de cargo en layout flexible (no desborda)');

// ---- 3. HTTP: quitar-jugador ----
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3464;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
function makeClient() {
  let cookie = '';
  const req = (method, pth, data) => new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const rq = http.request({ port: PORT, path: pth, method,
      headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let t = ''; res.on('data', c => t += c); res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc && sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        resolve({ statusCode: res.statusCode, text: t, json: j });
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
  const http2 = require('http');
  const loginBody = new URLSearchParams({ password: 'test1234' }).toString();
  let h = await new Promise((resolve, reject) => {
    const rq = http2.request({ port: PORT, path: '/admin/setup', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(loginBody) } }, (res) => {
      let t = ''; res.on('data', x => t += x); res.on('end', () => {
        const sc = res.headers['set-cookie'];
        resolve({ statusCode: res.statusCode, cookie: sc ? sc.map(x => x.split(';')[0]).join('; ') : '' });
      });
    });
    rq.on('error', reject); rq.write(loginBody); rq.end();
  });
  ok(h.statusCode === 302 && h.cookie, 'setup admin → sesión');
  const adminCookie = h.cookie;
  const auth = (method, pth, data) => new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const rq = http2.request({ port: PORT, path: pth, method,
      headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), Cookie: adminCookie } }, (res) => {
      let t = ''; res.on('data', x => t += x); res.on('end', () => {
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        resolve({ statusCode: res.statusCode, json: j, text: t });
      });
    });
    rq.on('error', reject); if (body) rq.write(body); rq.end();
  });
  const pb2 = B.getBooking(bid2).players;
  const socio2 = pb2.find(p => p.member_no === '802');
  h = await auth('POST', '/admin/reservas/reservas/' + bid2 + '/quitar-jugador', { player_id: socio2.id });
  ok(h.json && h.json.ok && h.json.booking.players.length === 1, 'HTTP admin: quitar-jugador quita al socio');
  ok(h.json.booking.open_spots === 3, 'HTTP admin: al quitar se libera la plaza');
  const tit2 = B.getBooking(bid2).players[0];
  h = await auth('POST', '/recepcion/reservas/' + bid2 + '/quitar-jugador', { player_id: tit2.id });
  ok(h.json && !h.json.ok && h.json.error.includes('titular'), 'HTTP recepción: quitar al titular → error');
  srv.kill();
  console.log(fail === 0 ? `OK run23: ${pass} pruebas` : `FALLOS run23: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO:', e.message); srv.kill(); process.exit(1); });
