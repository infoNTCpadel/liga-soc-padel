// Pruebas: cargos extra asignables a un jugador (pelotas, raqueta, luz…).
const DATA = '/tmp/test-v9k/data22';
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
B.upsertMember('701', 'Titu Lar', '600000701');
B.upsertMember('702', 'Compa Nero', '600000702');
B.setPin('701', '1111');
const courts = [{ id: 1, name: 'Pista 1', active: 1 }];

let r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 600, duration_min: 75, titular_member_no: '701', players: [{ name: 'Compa Nero', member_no: '702' }, { name: 'Invitado Externo', member_no: '' }], open: false, byStaff: true });
const bid = r.id;
const pls = B.getBooking(bid).players;
const pGuest = pls.find(p => p.is_guest === 1);
const pSocio = pls.find(p => p.member_no === '702');
ok(pGuest && pSocio, 'fixture: 3 jugadores (titular, socio e invitado)');

// ---- 1. addCharge con jugador ----
r = B.addCharge(bid, 'Pelotas', 3.00, pGuest.id);
ok(r.ok, 'addCharge: cargo a un invitado OK');
r = B.addCharge(bid, 'Raqueta', 5, pSocio.id);
ok(r.ok, 'addCharge: cargo a un socio OK');
r = B.addCharge(bid, 'Luz', '4,50', null);
ok(r.ok, 'addCharge: cargo a toda la reserva OK');
r = B.addCharge(bid, 'Falso', 1, 99999);
ok(r.error && r.error.includes('Jugador no válido'), 'addCharge: jugador de otra reserva → error');
r = B.addCharge(bid, '', 1, null);
ok(r.error && r.error.includes('concepto'), 'addCharge: sin concepto → error');
r = B.addCharge(bid, 'Negativo', -2, null);
ok(r.error && r.error.includes('no válido'), 'addCharge: importe negativo → error');

// ---- 2. listado con nombre del jugador ----
const chs = B.chargeList(bid);
ok(chs.length === 3, 'chargeList: 3 cargos');
ok(chs[0].player_name === 'Invitado Externo' && chs[0].player_guest === 1, 'chargeList: nombre e invitado del asignado');
ok(chs[1].player_name === 'Compa Nero' && !chs[1].player_guest, 'chargeList: socio asignado');
ok(chs[2].player_name === null, 'chargeList: sin asignar → toda la reserva');
const dd = B.dayDetail(TOM).bookings.find(b => b.id === bid);
ok(dd.charges.length === 3 && dd.charges[0].player_name === 'Invitado Externo', 'dayDetail: cargos con nombre de jugador');

// ---- 3. cobro por cargo ----
B.setChargePaid(chs[0].id, true);
ok(B.chargeList(bid)[0].paid === 1, 'setChargePaid: marca cobrado');
ok(B.chargeList(bid)[1].paid === 0, 'setChargePaid: el resto sigue pendiente');

// ---- 4. migración: la columna existe en instalaciones nuevas y viejas ----
const cols = B.bdb.prepare("PRAGMA table_info(booking_charges)").all().map(c => c.name);
ok(cols.includes('booking_player_id'), 'migración: columna booking_player_id existe');

// ---- 5. render recepción ----
const rcpHtml = ejs.render(fs.readFileSync('src/views/recepcion/reservas.ejs', 'utf8'), {
  date: TOM, bookings: B.dayDetail(TOM).bookings, blocks: [],
  pending: B.dayDetail(TOM).bookings.filter(b => b.status === 'active' && (b.payment_status === 'pending' || b.charges.some(c => !c.paid))),
  unpaidCharges: [], eur: (c) => (c / 100).toFixed(2) + ' €', minToStr: B.minToStr,
  info: null, error: null, prev: TOM, next: TOM,
  filename: 'src/views/recepcion/reservas.ejs',
});
ok(rcpHtml.includes('name="player_id"'), 'recepción: selector de jugador en añadir cargo');
ok(rcpHtml.includes('Invitado Externo (invitado)') || rcpHtml.includes('Invitado Externo (inv.)'), 'recepción: el selector lista al invitado');
ok(rcpHtml.includes('Raqueta') && rcpHtml.includes('→ Compa Nero'), 'recepción: cargos con asignado');
const fichaHtml = ejs.render(fs.readFileSync('src/views/reservas-admin/ficha.ejs', 'utf8'), {
  b: B.getBooking(B.dayDetail(TOM).bookings[0].id), eur: (c) => (c / 100).toFixed(2) + ' €',
  minToStr: B.minToStr, info: null, error: null, chargePresets: B.getChargePresets(),
  filename: 'src/views/reservas-admin/ficha.ejs',
});
ok(fichaHtml.includes('Pelotas') && fichaHtml.includes('→ Invitado Externo'), 'ficha: cargo con asignado');

// ---- 6. HTTP: cargo con jugador vía recepción ----
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3463;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
function makeClient() {
  let cookie = '';
  const req = (method, pth, data) => new Promise((resolve, reject) => {
    const body = data ? new URLSearchParams(data).toString() : null;
    const j = http.request({ port: PORT, path: pth, method,
      headers: { ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let t = ''; res.on('data', c => t += c); res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc && sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
        resolve({ statusCode: res.statusCode, location: res.headers.location || '', text: t });
      });
    });
    j.on('error', reject);
    if (body) j.write(body);
    j.end();
  });
  return { req };
}
const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
srv.on('error', e => { console.log('FALLO: no arranca', e.message); process.exit(1); });
(async () => {
  await new Promise(rst => setTimeout(rst, 1800));
  const c = makeClient();
  let h = await c.req('POST', '/admin/setup', { password: 'test1234' });
  ok(h.statusCode === 302, 'setup admin → sesión');
  h = await c.req('POST', '/recepcion/reservas/' + bid + '/cargo', { label: 'Bote de pelotas', amount: '2,50', player_id: String(pSocio.id) });
  ok(h.statusCode === 302 && h.location.includes('ok='), 'HTTP: cargo con jugador → ok (' + h.location.slice(-40) + ')');
  const ch = B.chargeList(bid).find(x => x.label === 'Bote de pelotas');
  ok(ch && ch.player_name === 'Compa Nero' && ch.amount_cents === 250, 'HTTP: cargo guardado con jugador e importe');
  h = await c.req('POST', '/recepcion/reservas/' + bid + '/cargo', { label: 'X', amount: '1', player_id: '99999' });
  ok(h.statusCode === 302 && h.location.includes('error='), 'HTTP: jugador inválido → error');
  // pendiente incluye la reserva por sus cargos impagados (aunque la cuota esté ok)
  h = await c.req('GET', '/recepcion/reservas?date=' + TOM);
  ok(h.statusCode === 200 && h.text.includes('Pendientes de pago'), 'HTTP: la reserva con cargos pdtes. sale en pendientes');
  srv.kill();
  console.log(fail === 0 ? `OK run22: ${pass} pruebas` : `FALLOS run22: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO:', e.message); srv.kill(); process.exit(1); });
