// Pruebas fase 1 reservas (rediseño 60/75): config por duraciones, activación
// con PIN, reserva con titular de la sesión + 3 jugadores opcionales,
// completar jugadores después, lista de espera con hora+duración,
// bloqueos por rango de fechas, reservas del personal y recepción.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3468;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-v9e/data7';
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA, BOOKING_HOST: 'reservas.test' };
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
const qdb = (f) => (sql, ...p) => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(DATA + '/' + f); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const bbq = qdb('meta.db');
const qrun = (f) => (sql, ...p) => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(DATA + '/' + f); try { return d.prepare(sql).run(...p); } finally { d.close(); } };
const dbrun = qrun('season-1.db');
const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
const dayStr = (off) => { const d = new Date(Date.now() + off * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TOM = dayStr(1), D3 = dayStr(3), D4 = dayStr(4), D5 = dayStr(5), D6 = dayStr(6);
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), pub = makeClient(), recep = makeClient(), anon = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });
  await admin.req('POST', '/admin/ajustes/recepcion-password', { password: 'recep123' });
  dbrun("INSERT INTO courts(name, active) VALUES('Pista 1', 1), ('Pista 2', 1)");

  // 1. Config: duraciones inválidas se rechazan, "60,75" se guarda
  let r = await admin.req('POST', '/admin/reservas/config', { open: '08:00', close: '20:00', slot_durations: '', days_ahead: '14', hold_min: '10', cancel_limit_h: '3', guest_price: '' });
  ok(r.statusCode === 200 && r.text.includes('al menos una duración'), 'config sin duraciones se rechaza');
  r = await admin.req('POST', '/admin/reservas/config', { open: '08:00', close: '08:00', slot_durations: '60,75', days_ahead: '14', hold_min: '10', cancel_limit_h: '3', guest_price: '' });
  ok(r.statusCode === 200 && r.text.includes('anterior al cierre'), 'apertura = cierre se rechaza');
  r = await admin.req('POST', '/admin/reservas/config', { open: '08:00', close: '20:00', slot_durations: '60,75', days_ahead: '14', hold_min: '10', cancel_limit_h: '3', guest_price: '6' });
  ok(r.statusCode === 200 && r.text.includes('Configuración guardada'), 'config 60/75 se guarda');
  ok(bbq("SELECT value FROM booking_config WHERE key = 'slot_durations'")[0].value === '60,75', 'duraciones en BD');

  // 2. Socios + activación con PIN
  await admin.req('POST', '/admin/reservas/socios', { member_no: '1001', name: 'Socio Uno', phone: '600111222' });
  await admin.req('POST', '/admin/reservas/socios', { member_no: '1002', name: 'Socio Dos', phone: '600333444' });
  await admin.req('POST', '/admin/reservas/socios', { member_no: '1003', name: 'Socio Tres', phone: '600777888' });
  r = await pub.req('GET', '/reservar/mis');
  ok(r.statusCode === 302 && r.location.startsWith('/reservar/entrar'), 'mis reservas sin login redirige a entrar');
  r = await pub.req('GET', '/reservar/nueva?court=1&date=' + TOM + '&desde=480');
  ok(r.statusCode === 302 && r.location.startsWith('/reservar/entrar'), 'nueva reserva sin login redirige a entrar');
  r = await pub.req('POST', '/reservar/activar', { member_no: '1001', phone: '600000000', pin: '1234', pin2: '1234' });
  ok(r.statusCode === 200 && r.text.includes('no coincide'), 'activación con teléfono erróneo se rechaza');
  r = await pub.req('POST', '/reservar/activar', { member_no: '1001', phone: '600111222', pin: '123', pin2: '123' });
  ok(r.statusCode === 200 && r.text.includes('4 y 8 dígitos'), 'PIN de 3 dígitos se rechaza');
  r = await pub.req('POST', '/reservar/activar', { member_no: '1001', phone: '600111222', pin: '1234', pin2: '1234' });
  ok(r.statusCode === 302 && r.location === '/reservar/mis', 'activación correcta entra en sesión');
  r = await pub.req('GET', '/reservar/mis');
  ok(r.statusCode === 200 && r.text.includes('Socio Uno'), 'mis reservas muestra al socio logueado');
  await pub.req('GET', '/reservar/salir');
  r = await pub.req('POST', '/reservar/entrar', { member_no: '1001', pin: '0000', next: '/reservar/mis' });
  ok(r.statusCode === 200 && r.text.includes('PIN incorrecto'), 'login con PIN erróneo se rechaza');
  r = await pub.req('POST', '/reservar/entrar', { member_no: '1001', pin: '1234', next: '/reservar/mis' });
  ok(r.statusCode === 302 && r.location === '/reservar/mis', 'login con PIN correcto');

  // 3. Parrilla pública por tramos
  r = await anon.req('GET', '/reservar?date=' + TOM);
  ok(r.statusCode === 200 && r.text.includes('Pista 1') && r.text.includes('Libre') && r.text.includes('08:00'), 'parrilla pública con tramos libres');

  // 4. Reserva: el titular sale de la sesión, 3 jugadores opcionales
  r = await pub.req('GET', '/reservar/nueva?court=1&date=' + TOM + '&desde=480');
  ok(r.statusCode === 200 && r.text.includes('Socio Uno') && r.text.includes('value="480"'), 'formulario con titular de la sesión e inicios');
  r = await pub.req('POST', '/reservar/nueva', { court_id: '1', date: TOM, start_min: '480', duration_min: '60',
    p1_name: 'Socio Dos', p1_member: '1002', p2_name: 'Invitado X', p2_member: '9999', p3_name: '', p3_member: '', titular_email: 'uno@example.com' });
  ok(r.statusCode === 302 && r.location.startsWith('/reservar/ok?id='), 'reserva creada (titular + 2 jugadores)');
  const bid = r.location.split('=')[1];
  const b1 = bbq('SELECT * FROM bookings WHERE id = ?', bid)[0];
  ok(b1.start_min === 480 && b1.end_min === 540 && b1.titular_member_no === '1001', 'reserva 08:00–09:00 del socio 1001');
  ok(bbq("SELECT COUNT(*) c FROM booking_players WHERE booking_id = ?", bid)[0].c === 3, '3 jugadores (titular + 2)');
  ok(b1.payment_status === 'pending', 'pago pendiente por el invitado');
  ok(bbq("SELECT email FROM club_members WHERE member_no = '1001'")[0].email === 'uno@example.com', 'email guardado en la ficha');

  // 5. El ejemplo de Mathius: reservada 09:00–10:15, desde 10:15 vale 10:15, 11:15, 11:30 pero no 10:30
  r = await pub.req('POST', '/reservar/nueva', { court_id: '1', date: TOM, start_min: '540', duration_min: '75',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 302, 'segunda reserva 09:00–10:15 (incompleta, solo el titular)');
  const bid2 = r.location.split('=')[1];
  ok(bbq("SELECT COUNT(*) c FROM booking_players WHERE booking_id = ?", bid2)[0].c === 1, 'reserva incompleta: solo el titular');
  ok(bbq("SELECT payment_status FROM bookings WHERE id = ?", bid2)[0].payment_status === 'ok', 'sin invitados no hay pago pendiente');
  r = await pub.req('POST', '/reservar/nueva', { court_id: '1', date: TOM, start_min: '630', duration_min: '60',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 200 && r.text.includes('no encaja sin dejar huecos'), '10:30 se rechaza (dejaría 10:15–10:30 inservible)');
  r = await pub.req('POST', '/reservar/nueva', { court_id: '1', date: TOM, start_min: '675', duration_min: '60',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 302, '11:15 sí se puede (queda 10:15–11:15 = 60 min, reservable)');

  // 6. Completar jugadores después recalcula el pago
  r = await pub.req('POST', '/reservar/jugadores', { booking_id: bid2, p1_name: 'Invitado Y', p1_member: '8888', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 302, 'jugadores completados desde mis reservas');
  ok(bbq("SELECT payment_status FROM bookings WHERE id = ?", bid2)[0].payment_status === 'pending', 'al añadir invitado el pago pasa a pendiente');
  r = await pub.req('POST', '/reservar/jugadores', { booking_id: bid2, p1_name: 'Socio Dos', p1_member: '1002', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(bbq("SELECT payment_status FROM bookings WHERE id = ?", bid2)[0].payment_status === 'ok', 'al poner socio el pago vuelve a OK');

  // 7. Lista de espera con hora + duración (en la pista 2, sin interferencias)
  const pub2 = makeClient(), pubW = makeClient();
  await pub2.req('POST', '/reservar/activar', { member_no: '1002', phone: '600333444', pin: '5678', pin2: '5678' });
  await pubW.req('POST', '/reservar/activar', { member_no: '1003', phone: '600777888', pin: '4321', pin2: '4321' });
  r = await pub2.req('POST', '/reservar/nueva', { court_id: '2', date: TOM, start_min: '480', duration_min: '75',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  const bidW = r.location.split('=')[1];
  r = await pubW.req('POST', '/reservar/espera', { court_id: '2', date: TOM, start_min: '480', duration_min: '75' });
  ok(r.statusCode === 302 && r.location.includes('ok=1'), 'apuntado a la lista de espera (08:00, 75 min)');
  await pub2.req('POST', '/reservar/anular', { booking_id: bidW });
  const offer = bbq("SELECT id FROM waitlist WHERE member_no = '1003' AND status = 'offered'");
  ok(offer.length === 1, 'al liberarse, la plaza se ofrece al primero en espera');
  r = await pubW.req('GET', '/reservar/nueva?offer=' + offer[0].id);
  ok(r.statusCode === 200 && r.text.includes('lista de espera'), 'formulario de confirmación de la oferta');
  r = await pubW.req('POST', '/reservar/nueva', { offer_id: String(offer[0].id), court_id: '1', date: D6, start_min: '700',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 302 && r.location.startsWith('/reservar/ok?id='), 'la oferta se confirma aunque el formulario venga manipulado');
  const bid3 = r.location.split('=')[1];
  const b3 = bbq('SELECT court_id, start_min, end_min FROM bookings WHERE id = ?', bid3)[0];
  ok(b3.court_id === 2 && b3.start_min === 480 && b3.end_min === 555, 'la reserva usa la hora+duración ofrecidas, no las manipuladas');

  // 8. Bloqueo por rango de fechas con conflicto
  r = await pub.req('POST', '/reservar/nueva', { court_id: '2', date: D4, start_min: '600', duration_min: '75',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  const bid4 = r.location.split('=')[1];
  r = await admin.req('POST', '/admin/reservas/bloqueos', { court_id: '2', date_from: D3, date_to: D5, start: '09:00', end: '14:00', reason: 'torneo', notes: 'prueba' });
  ok(r.statusCode === 200 && r.text.includes('afectadas'), 'bloqueo 3–5 con reserva afectada pide confirmación');
  r = await admin.req('POST', '/admin/reservas/bloqueos', { court_id: '2', date_from: D3, date_to: D5, start: '09:00', end: '14:00', reason: 'torneo', notes: 'prueba', force: '1' });
  ok(r.statusCode === 302, 'bloqueo forzado redirige');
  ok(bbq('SELECT status FROM bookings WHERE id = ?', bid4)[0].status === 'cancelled', 'la reserva afectada queda anulada');
  ok(bbq("SELECT COUNT(*) c FROM court_blocks WHERE date_from = ? AND date_to = ?", D3, D5)[0].c === 1, 'bloqueo guardado con rango');
  r = await anon.req('GET', '/reservar?date=' + D4);
  ok(r.text.includes('Bloqueada'), 'la parrilla muestra la pista bloqueada en el rango');
  r = await pub.req('POST', '/reservar/nueva', { court_id: '2', date: D4, start_min: '840', duration_min: '60',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 302, 'a las 14:00 (fin del bloqueo) sí se puede reservar');

  // 9. El personal crea reservas y completa jugadores
  r = await admin.req('GET', '/admin/reservas/nueva?date=' + D5 + '&court=1');
  ok(r.statusCode === 200 && r.text.includes('Elige el tramo libre'), 'admin: paso 1 de nueva reserva');
  r = await admin.req('GET', '/admin/reservas/nueva?date=' + D5 + '&court=1&desde=480');
  ok(r.statusCode === 200 && r.text.includes('Hora de inicio'), 'admin: paso 2 con inicios válidos');
  r = await admin.req('POST', '/admin/reservas/nueva', { court_id: '1', date: D5, desde: '480', start_min: '480', duration_min: '60',
    titular_member_no: '1002', p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 302 && r.location.includes('/admin/reservas/dia'), 'admin crea la reserva');
  const bidA = bbq("SELECT id FROM bookings WHERE date = ? AND titular_member_no = '1002' AND start_min = 480", D5)[0].id;
  r = await admin.req('POST', '/admin/reservas/reservas/' + bidA + '/jugadores', { p1_name: 'Invitado Z', p1_member: '7777', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 302, 'admin completa jugadores');
  ok(bbq('SELECT payment_status FROM bookings WHERE id = ?', bidA)[0].payment_status === 'pending', 'admin: invitado añadido → pago pendiente');
  await recep.req('POST', '/recepcion/login', { password: 'recep123' });
  r = await recep.req('GET', '/recepcion/reservas/nueva?date=' + D6 + '&court=2&desde=480');
  ok(r.statusCode === 200 && r.text.includes('Titular'), 'recepción: formulario de nueva reserva');
  r = await recep.req('POST', '/recepcion/reservas/nueva', { court_id: '2', date: D6, desde: '480', start_min: '480', duration_min: '75',
    titular_member_no: '1001', p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 302 && r.location.includes('/recepcion/reservas'), 'recepción crea la reserva');
  r = await recep.req('GET', '/recepcion/reservas?date=' + D6);
  ok(r.statusCode === 200 && r.text.includes('Socio Uno'), 'recepción ve la reserva creada');

  // 10. Restablecer PIN desde admin
  r = await admin.req('POST', '/admin/reservas/socios/pin', { member_no: '1002' });
  ok(r.statusCode === 302 && r.location.includes('&pin='), 'reset de PIN genera uno temporal');
  const newPin = decodeURIComponent(r.location.split('&pin=')[1]);
  const pub3 = makeClient();
  r = await pub3.req('POST', '/reservar/entrar', { member_no: '1002', pin: newPin, next: '/reservar/mis' });
  ok(r.statusCode === 302 && r.location === '/reservar/mis', 'el PIN temporal funciona');
  r = await pub3.req('POST', '/reservar/datos/pin', { pin_actual: newPin, pin: '9999', pin2: '9999' });
  ok(r.statusCode === 200 && r.text.includes('PIN cambiado'), 'el socio cambia su PIN desde mis datos');
  r = await pub3.req('POST', '/reservar/datos/telefono', { phone: '600999888', email: 'dos@example.com' });
  ok(r.statusCode === 200 && r.text.includes('Datos actualizados'), 'el socio cambia teléfono y email');

  // 11. Recepción: pagos y cargos (con el flujo nuevo)
  r = await recep.req('GET', '/recepcion/reservas?date=' + D5);
  ok(r.statusCode === 200 && r.text.includes('Pendientes de pago'), 'recepción ve pendientes de pago');
  await recep.req('POST', `/recepcion/reservas/${bidA}/pago`, { paid: '1' });
  ok(bbq('SELECT payment_status FROM bookings WHERE id = ?', bidA)[0].payment_status === 'ok', 'recepción marca pagado');
  await recep.req('POST', `/recepcion/reservas/${bidA}/cargo`, { label: 'Luz', amount: '4,50' });
  ok(bbq('SELECT amount_cents FROM booking_charges WHERE booking_id = ?', bidA)[0].amount_cents === 450, 'cargo de luz 4,50 €');

  // 12. Dominio propio: la raíz del BOOKING_HOST muestra la parrilla
  const hostGet = (host) => new Promise((res, rej) => {
    const rq = http.request({ port: PORT, path: '/', method: 'GET', headers: { Host: host } }, rs => {
      let t = ''; rs.on('data', c => t += c); rs.on('end', () => res({ statusCode: rs.statusCode, text: t }));
    });
    rq.on('error', rej); rq.end();
  });
  const domRes = await hostGet('reservas.test');
  ok(domRes.statusCode === 200 && domRes.text.includes('<h1>Reservar pista</h1>'), 'el dominio propio sirve la parrilla en /');
  const homeRes = await hostGet('localhost');
  ok(homeRes.statusCode === 200 && !homeRes.text.includes('href="/reservar"'), 'el dominio principal no muestra el enlace de reservas');

  // 13. Fuerza bruta del PIN: 5 intentos fallidos bloquean 15 min
  for (let i = 0; i < 5; i++) await pub.req('POST', '/reservar/entrar', { member_no: '1001', pin: '0000', next: '/reservar/mis' });
  r = await pub.req('POST', '/reservar/entrar', { member_no: '1001', pin: '1234', next: '/reservar/mis' });
  ok(r.statusCode === 200 && r.text.includes('15 minutos'), 'tras 5 fallos el PIN correcto también se bloquea');

  console.log(`\n${pass} OK, ${fail} FALLOS`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
