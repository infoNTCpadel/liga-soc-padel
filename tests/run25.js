// Pruebas: login en 2 clics (buscador público) y ficha TPV de reserva en admin.
const DATA = '/tmp/test-v9k/data25';
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
B.upsertMember('A01', 'Ana Lopez', '600000901');
B.upsertMember('A02', 'Beto Mar', '600000902');
B.setPin('A01', '1111');

// ---- 1. entrar.ejs: buscador en 2 clics ----
const entrarHtml = ejs.render(fs.readFileSync('src/views/reservas/entrar.ejs', 'utf8'), {
  error: null, next: '/reservar/mis', member_no: '', join: false,
  filename: 'src/views/reservas/entrar.ejs',
});
ok(entrarHtml.includes('buscar-publico'), 'entrar: usa el buscador público');
ok(entrarHtml.includes('name="member_no"') && entrarHtml.includes('name="pin"'), 'entrar: campos member_no y pin');
ok(entrarHtml.includes('2 clics'), 'entrar: indica los 2 clics');

// ---- 2. HTTP ----
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3466;
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
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        resolve({ statusCode: res.statusCode, location: res.headers.location || '', text: t, json: j });
      });
    });
    rq.on('error', reject);
    if (body) rq.write(body);
    rq.end();
  });
  return { req, getCookie: () => cookie };
}
const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
srv.on('error', e => { console.log('FALLO: no arranca', e.message); process.exit(1); });
(async () => {
  await new Promise(rst => setTimeout(rst, 1800));
  // 2a. buscador público sin sesión: solo nombre y nº
  const anon = makeClient();
  let h = await anon.req('GET', '/reservar/socios/buscar-publico?q=ana');
  ok(h.statusCode === 200 && h.json && h.json.length >= 1 && h.json[0].name === 'Ana Lopez', 'buscar-publico: encuentra sin login');
  ok(h.json.every(s => s.member_no && s.name && !('phone' in s) && !('level' in s)), 'buscar-publico: sin teléfono ni nivel');
  h = await anon.req('GET', '/reservar/socios/buscar-publico?q=a');
  ok(h.json && h.json.length === 0, 'buscar-publico: mínimo 2 caracteres');
  // 2b. login con nº directo sigue funcionando
  h = await anon.req('POST', '/reservar/entrar', { member_no: 'A01', pin: '1111', next: '/reservar/mis' });
  ok(h.statusCode === 302 && h.location === '/reservar/mis', 'login con nº directo → entra');
  h = await anon.req('GET', '/reservar/mis');
  ok(h.statusCode === 200 && h.text.includes('Ana Lopez'), 'login: sesión activa');

  // ---- 3. ficha TPV ----
  const r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 600, duration_min: 75, titular_member_no: 'A01', players: [{ name: 'Invitado Ex', member_no: '' }], open: false, byStaff: true });
  const bid = r.id;
  const admin = makeClient();
  const loginBody = new URLSearchParams({ password: 'test1234' }).toString();
  h = await admin.req('POST', '/admin/setup', { password: 'test1234' });
  ok(h.statusCode === 302, 'setup admin → sesión');
  h = await admin.req('GET', '/admin/reservas/reservas/' + bid);
  ok(h.statusCode === 200, 'ficha: 200');
  for (const s of ['Jugadores', 'Pago de invitado', 'Cargos extra', 'Acciones', 'Invitado Ex', 'Añadir jugador', 'Marcar pagado', 'Anular reserva', 'Volver al día']) {
    ok(h.text.includes(s), 'ficha: sección «' + s + '»');
  }
  ok(h.text.includes('value="split"') && h.text.includes('preset'), 'ficha: repartir y presets');
  h = await admin.req('GET', '/admin/reservas/reservas/99999');
  ok(h.statusCode === 302, 'ficha inexistente → redirect');
  // 3b. acciones con back vuelven a la ficha
  const back = '/admin/reservas/reservas/' + bid;
  h = await admin.req('POST', '/admin/reservas/reservas/' + bid + '/cargo', { label: 'Pelotas', amount: '3', player_id: '', back });
  ok(h.statusCode === 302 && h.location.startsWith(back + '?') && h.location.includes('ok='), 'cargo con back → vuelve a la ficha');
  ok(B.chargeList(bid).some(c => c.label === 'Pelotas'), 'cargo guardado');
  h = await admin.req('GET', back);
  ok(h.text.includes('Cobrar') && h.text.includes('Pelotas'), 'ficha: el cargo sale con su botón Cobrar');
  const chId = B.chargeList(bid)[0].id;
  h = await admin.req('POST', '/admin/reservas/cargos/' + chId + '/pagado', { paid: '1', back });
  ok(h.location.startsWith(back), 'cobrar con back → ficha');
  h = await admin.req('POST', '/admin/reservas/reservas/' + bid + '/pago', { paid: '1', back });
  ok(h.location.startsWith(back) && B.getBooking(bid).payment_status === 'paid', 'pago con back → ficha y pagado');
  h = await admin.req('POST', '/admin/reservas/reservas/' + bid + '/anadir-jugador', { name: 'Beto Mar', member_no: 'A02', back });
  ok(h.location.startsWith(back) && B.getBooking(bid).players.length === 3, 'añadir jugador con back → ficha');
  const pDel = B.getBooking(bid).players.find(p => p.member_no === 'A02');
  h = await admin.req('POST', '/admin/reservas/reservas/' + bid + '/quitar-jugador', { player_id: String(pDel.id), back });
  ok(h.location.startsWith(back) && B.getBooking(bid).players.length === 2, 'quitar jugador con back → ficha');
  // 3c. back malicioso → cae al día
  h = await admin.req('POST', '/admin/reservas/reservas/' + bid + '/pago', { paid: '0', back: 'https://evil.test/x' });
  ok(h.location.includes('/admin/reservas/dia?date='), 'back externo → se ignora, va al día');
  // 3d. día compacto
  h = await admin.req('GET', '/admin/reservas/dia?date=' + TOM);
  ok(h.statusCode === 200 && h.text.includes('Ficha →'), 'día: enlace a la ficha');
  ok(!h.text.includes('Completar jugadores'), 'día: sin formularios por fila (compacto)');
  ok(h.text.includes('/admin/reservas/reservas/' + bid + '">Ficha →'), 'día: la ficha enlaza la reserva');
  srv.kill();
  console.log(fail === 0 ? `OK run25: ${pass} pruebas` : `FALLOS run25: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO:', e.message); srv.kill(); process.exit(1); });
