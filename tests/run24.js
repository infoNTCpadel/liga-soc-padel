// Pruebas: presets de cargos, reparto entre jugadores, punto de pendiente en admin.
const DATA = '/tmp/test-v9k/data24';
process.env.DATA_DIR = DATA;
require('fs').rmSync(DATA, { recursive: true, force: true });
const B = require('../src/lib/bookings');
const ejs = require('ejs'), fs = require('fs');
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

// ---- 1. parseChargePresets ----
let pr = B.parseChargePresets('Pelotas: 3\nRaqueta: 5,50\nLuz:3 €\nmalformed\n: 4\nVacio: 0\n');
ok(pr.length === 3 && pr[0].label === 'Pelotas' && pr[0].amount_cents === 300, 'parse presets: líneas válidas');
ok(pr[1].amount_cents === 550 && pr[2].amount_cents === 300, 'parse presets: decimales con coma y €');
ok(B.parseChargePresets('').length === 0, 'parse presets: vacío → []');

// ---- 2. defaults ----
const defs = B.getChargePresets();
ok(defs.length === 3 && defs[0].label === 'Pelotas', 'presets por defecto (Pelotas, Raqueta, Luz)');
B.setCfg('charge_presets', JSON.stringify(B.parseChargePresets('Bote: 2,75')));
ok(B.getChargePresets().length === 1 && B.getChargePresets()[0].amount_cents === 275, 'guardar presets vía config');

const dayStr = (off) => { const d = new Date(Date.now() + off * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TOM = dayStr(1);
B.setCfg('open_min', 540); B.setCfg('close_min', 1320);
B.setCfg('slot_durations', '75,60');
B.upsertMember('901', 'Titu Lar', '600000901');
B.upsertMember('902', 'Compa Nero', '600000902');
B.upsertMember('903', 'Tercer Socio', '600000903');
B.setPin('901', '1111');

// ---- 3. addChargeSplit ----
let r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 600, duration_min: 75, titular_member_no: '901', players: [{ name: 'Compa Nero', member_no: '902' }, { name: 'Tercer Socio', member_no: '903' }, { name: 'Invitado', member_no: '' }], open: false, byStaff: true });
const bid = r.id;
r = B.addChargeSplit(bid, 'Pelotas', 1000);
ok(r.ok && r.count === 4, 'split: 10 € entre 4');
let chs = B.chargeList(bid);
ok(chs.length === 4 && chs.every(c => c.amount_cents === 250), 'split: 2,50 € cada uno');
ok(new Set(chs.map(c => c.booking_player_id)).size === 4, 'split: un cargo por jugador');
const tot = chs.reduce((s, c) => s + c.amount_cents, 0);
ok(tot === 1000, 'split: la suma cuadra (' + tot + ')');
r = B.addChargeSplit(bid, 'Raro', 1001);
chs = B.chargeList(bid).filter(c => c.label === 'Raro').map(c => c.amount_cents).sort((a, b) => b - a);
ok(JSON.stringify(chs) === '[251,250,250,250]', 'split: el resto va a los primeros (' + chs.join(',') + ')');
r = B.addChargeSplit(bid, '', 100);
ok(r.error && r.error.includes('concepto'), 'split: sin concepto → error');
r = B.addChargeSplit(bid, 'X', 0);
ok(r.error && r.error.includes('no válido'), 'split: importe 0 → error');
r = B.addChargeSplit(99999, 'X', 100);
ok(r.error && r.error.includes('jugadores'), 'split: reserva sin jugadores → error');

// ---- 4. render admin día: punto, presets, repartir ----
const diaHtml = ejs.render(fs.readFileSync('src/views/reservas-admin/dia.ejs', 'utf8'), {
  date: TOM, bookings: B.dayDetail(TOM).bookings, blocks: [], eur: (c) => (c / 100).toFixed(2) + ' €',
  minToStr: B.minToStr, info: null, prev: TOM, next: TOM, chargePresets: B.getChargePresets(),
  filename: 'src/views/reservas-admin/dia.ejs',
});
ok(diaHtml.includes('dot warn') && diaHtml.includes('pdte.'), 'admin día: punto ámbar con pendientes');
ok(diaHtml.includes('Ficha →'), 'admin día: enlace a la ficha por reserva');
// split, presets y Cobrar viven ahora en la ficha TPV
const fichaHtml = ejs.render(fs.readFileSync('src/views/reservas-admin/ficha.ejs', 'utf8'), {
  b: B.getBooking(bid), eur: (c) => (c / 100).toFixed(2) + ' €', minToStr: B.minToStr,
  info: null, error: null, chargePresets: B.getChargePresets(),
  filename: 'src/views/reservas-admin/ficha.ejs',
});
ok(fichaHtml.includes('value="split"') && fichaHtml.includes('Repartir entre jugadores'), 'ficha: opción de repartir');
ok(fichaHtml.includes('class="btn small ghost preset"'), 'ficha: botones de presets');
ok(fichaHtml.includes('Cobrar'), 'ficha: botón Cobrar por cargo');
const rcpHtml = ejs.render(fs.readFileSync('src/views/recepcion/reservas.ejs', 'utf8'), {
  date: TOM, bookings: B.dayDetail(TOM).bookings, blocks: [],
  pending: B.dayDetail(TOM).bookings.filter(b => b.status === 'active' && (b.payment_status === 'pending' || b.charges.some(c => !c.paid))),
  unpaidCharges: [], eur: (c) => (c / 100).toFixed(2) + ' €', minToStr: B.minToStr,
  info: null, error: null, prev: TOM, next: TOM, chargePresets: B.getChargePresets(),
  filename: 'src/views/recepcion/reservas.ejs',
});
ok(rcpHtml.includes('value="split"'), 'recepción: opción de repartir');
ok(rcpHtml.includes('preset'), 'recepción: presets');
// punto verde cuando todo cobrado
B.chargeList(bid).forEach(c => B.setChargePaid(c.id, true));
const diaHtml2 = ejs.render(fs.readFileSync('src/views/reservas-admin/dia.ejs', 'utf8'), {
  date: TOM, bookings: B.dayDetail(TOM).bookings, blocks: [], eur: (c) => (c / 100).toFixed(2) + ' €',
  minToStr: B.minToStr, info: null, prev: TOM, next: TOM, chargePresets: B.getChargePresets(),
  filename: 'src/views/reservas-admin/dia.ejs',
});
ok(diaHtml2.includes('dot ok') && diaHtml2.includes('cobrado'), 'admin día: punto verde cuando todo cobrado');

// ---- 5. HTTP: split vía recepción ----
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3465;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
srv.on('error', e => { console.log('FALLO: no arranca', e.message); process.exit(1); });
(async () => {
  await new Promise(rst => setTimeout(rst, 1800));
  const loginBody = new URLSearchParams({ password: 'test1234' }).toString();
  const cookie = await new Promise((resolve, reject) => {
    const rq = http.request({ port: PORT, path: '/admin/setup', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(loginBody) } }, (res) => {
      res.resume(); res.on('end', () => {
        const sc = res.headers['set-cookie'];
        resolve(sc ? sc.map(x => x.split(';')[0]).join('; ') : '');
      });
    });
    rq.on('error', reject); rq.write(loginBody); rq.end();
  });
  ok(cookie.includes('connect.sid'), 'setup admin → sesión');
  const post = (pth, data) => new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const rq = http.request({ port: PORT, path: pth, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Cookie: cookie } }, (res) => {
      let t = ''; res.on('data', x => t += x); res.on('end', () => resolve({ statusCode: res.statusCode, location: res.headers.location || '', text: t }));
    });
    rq.on('error', reject); rq.write(body); rq.end();
  });
  let h = await post('/recepcion/reservas/' + bid + '/cargo', { label: 'Bote', amount: '12', player_id: 'split' });
  ok(h.statusCode === 302 && h.location.includes('ok='), 'HTTP: split vía recepción → ok');
  const sp = B.chargeList(bid).filter(c => c.label === 'Bote');
  ok(sp.length === 4 && sp.reduce((s, c) => s + c.amount_cents, 0) === 1200, 'HTTP: 12 € repartidos en 4 cargos');
  srv.kill();
  console.log(fail === 0 ? `OK run24: ${pass} pruebas` : `FALLOS run24: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO:', e.message); srv.kill(); process.exit(1); });
