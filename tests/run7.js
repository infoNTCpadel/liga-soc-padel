// Pruebas fase 1 reservas (rediseño 60/75): config por duraciones, activación
// con PIN, reserva con titular de la sesión + 3 jugadores opcionales,
// completar jugadores después, lista de espera con hora+duración,
// bloqueos por rango de fechas, reservas del personal y recepción,
// partidos abiertos (niveles ±1, unirse, bloqueos entre jugadores).
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
  r = await admin.req('POST', '/admin/reservas/config', { open: '08:00', close: '20:00', slot_durations: '60,75', days_ahead: '14', hold_min: '10', cancel_limit_h: '3', guest_price: '6', max_active_bookings: '2' });
  ok(r.statusCode === 200 && r.text.includes('Configuración guardada'), 'config 60/75 se guarda');
  ok(bbq("SELECT value FROM booking_config WHERE key = 'slot_durations'")[0].value === '60,75', 'duraciones en BD');
  ok(bbq("SELECT value FROM booking_config WHERE key = 'max_active_bookings'")[0].value === '2', 'tope de reservas activas en BD');

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

  // 3. Parrilla por franjas
  r = await anon.req('GET', '/reservar?date=' + TOM);
  ok(r.statusCode === 200 && r.text.includes('Pista 1') && r.text.includes('Libre') && r.text.includes('08:00'), 'parrilla por franjas');
  ok(r.text.includes('chip free') && r.text.includes('duracion%3D75'), 'las franjas libres enlazan a reservar 75 min');

  // 4. Reserva: el titular sale de la sesión, 3 jugadores opcionales
  r = await pub.req('GET', '/reservar/nueva?court=1&date=' + TOM + '&desde=480');
  ok(r.statusCode === 200 && r.text.includes('Socio Uno') && r.text.includes('value="480"') && r.text.includes('75 minutos'), 'formulario con titular, franja e inicio y duración automática');
  r = await pub.req('POST', '/reservar/nueva', { court_id: '1', date: TOM, start_min: '480', duration_min: '60',
    p1_name: 'Socio Dos', p1_member: '1002', p2_name: 'Invitado X', p2_member: '9999', p3_name: '', p3_member: '', titular_email: 'uno@example.com' });
  ok(r.statusCode === 200 && r.text.includes('¿Partido abierto?'), 'con un hueco pregunta si publicar abierto');
  r = await pub.req('POST', '/reservar/abrir/confirmar', { abrir: '0' });
  ok(r.statusCode === 302 && r.location.startsWith('/reservar/ok?id='), 'reserva creada (titular + 2 jugadores, cerrada)');
  const bid = r.location.split('=')[1];
  const b1 = bbq('SELECT * FROM bookings WHERE id = ?', bid)[0];
  ok(b1.start_min === 480 && b1.end_min === 540 && b1.titular_member_no === '1001', 'reserva 08:00–09:00 del socio 1001');
  ok(bbq("SELECT COUNT(*) c FROM booking_players WHERE booking_id = ?", bid)[0].c === 3, '3 jugadores (titular + 2)');
  ok(b1.payment_status === 'pending', 'pago pendiente por el invitado');
  ok(bbq("SELECT email FROM club_members WHERE member_no = '1001'")[0].email === 'uno@example.com', 'email guardado en la ficha');
  r = await pub.req('POST', '/reservar/anular', { booking_id: bid });
  ok(r.statusCode === 200 && r.text.includes('Reserva anulada'), 'el socio anula su 1ª reserva (hace hueco en el tope de 2)');

  // 5. El ejemplo de Mathius: reservada 09:00–10:15, desde 10:15 vale 10:15, 11:15, 11:30.
  // Las 10:30 son fila de la parrilla (apertura 08:00 + 75) y por tanto se aceptan;
  // las 10:45 no son ni encadenadas ni de parrilla y se siguen rechazando.
  r = await pub.req('POST', '/reservar/nueva', { court_id: '1', date: TOM, start_min: '540', duration_min: '75',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 200 && r.text.includes('¿Partido abierto?'), 'incompleta: pregunta si abrirla');
  r = await pub.req('POST', '/reservar/abrir/confirmar', { abrir: '0' });
  ok(r.statusCode === 302, 'reserva 09:00–10:15 (incompleta, solo el titular)');
  const bid2 = r.location.split('=')[1];
  ok(bbq("SELECT COUNT(*) c FROM booking_players WHERE booking_id = ?", bid2)[0].c === 1, 'reserva incompleta: solo el titular');
  ok(bbq("SELECT payment_status FROM bookings WHERE id = ?", bid2)[0].payment_status === 'ok', 'sin invitados no hay pago pendiente');
  r = await pub.req('POST', '/reservar/nueva', { court_id: '1', date: TOM, start_min: '645', duration_min: '60',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 200 && r.text.includes('no encaja sin dejar huecos'), '10:45 se rechaza (ni encadena ni es parrilla)');
  r = await pub.req('POST', '/reservar/nueva', { court_id: '1', date: TOM, start_min: '630', duration_min: '60',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 200 && r.text.includes('¿Partido abierto?'), '10:30 (fila de la parrilla) se acepta');
  r = await pub.req('POST', '/reservar/nueva', { court_id: '1', date: TOM, start_min: '675', duration_min: '60',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 200 && r.text.includes('¿Partido abierto?'), '11:15 pregunta si abrirla');
  r = await pub.req('POST', '/reservar/abrir/confirmar', { abrir: '0' });
  ok(r.statusCode === 302, '11:15 sí se puede (queda 10:15–11:15 = 60 min, reservable)');

  // 6. Completar jugadores después recalcula el pago
  r = await pub.req('POST', '/reservar/jugadores', { booking_id: bid2, p1_name: 'Invitado Y', p1_member: '8888', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 302, 'jugadores completados desde mis reservas');
  ok(bbq("SELECT payment_status FROM bookings WHERE id = ?", bid2)[0].payment_status === 'pending', 'al añadir invitado el pago pasa a pendiente');
  r = await pub.req('POST', '/reservar/jugadores', { booking_id: bid2, p1_name: 'Socio Dos', p1_member: '1002', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(bbq("SELECT payment_status FROM bookings WHERE id = ?", bid2)[0].payment_status === 'ok', 'al poner socio el pago vuelve a OK');
  // El tope es 2 reservas activas: anulamos las de 1001 para no interferir con los siguientes tests
  const bid1115 = bbq("SELECT id FROM bookings WHERE titular_member_no = '1001' AND date = ? AND start_min = 675 AND status = 'active'", TOM)[0].id;
  r = await pub.req('POST', '/reservar/anular', { booking_id: bid2 });
  ok(r.statusCode === 200 && r.text.includes('Reserva anulada'), 'anula la reserva incompleta');
  r = await pub.req('POST', '/reservar/anular', { booking_id: bid1115 });
  ok(r.statusCode === 200 && r.text.includes('Reserva anulada'), 'anula la de las 11:15');

  // 7. Lista de espera con hora + duración (en la pista 2, sin interferencias)
  const pub2 = makeClient(), pubW = makeClient();
  await pub2.req('POST', '/reservar/activar', { member_no: '1002', phone: '600333444', pin: '5678', pin2: '5678' });
  await pubW.req('POST', '/reservar/activar', { member_no: '1003', phone: '600777888', pin: '4321', pin2: '4321' });
  r = await pub2.req('POST', '/reservar/nueva', { court_id: '2', date: TOM, start_min: '480', duration_min: '75',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  r = await pub2.req('POST', '/reservar/abrir/confirmar', { abrir: '0' });
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
  r = await pub.req('POST', '/reservar/abrir/confirmar', { abrir: '0' });
  const bid4 = r.location.split('=')[1];
  r = await admin.req('POST', '/admin/reservas/bloqueos', { court_id: '2', date_from: D3, date_to: D5, start: '09:00', end: '14:00', reason: 'torneo', notes: 'prueba' });
  ok(r.statusCode === 200 && r.text.includes('afectadas'), 'bloqueo 3–5 con reserva afectada pide confirmación');
  r = await admin.req('POST', '/admin/reservas/bloqueos', { court_id: '2', date_from: D3, date_to: D5, start: '09:00', end: '14:00', reason: 'torneo', notes: 'prueba', force: '1' });
  ok(r.statusCode === 302, 'bloqueo forzado redirige');
  ok(bbq('SELECT status FROM bookings WHERE id = ?', bid4)[0].status === 'cancelled', 'la reserva afectada queda anulada');
  ok(bbq("SELECT COUNT(*) c FROM court_blocks WHERE date_from = ? AND date_to = ?", D3, D5)[0].c === 1, 'bloqueo guardado con rango');
  r = await anon.req('GET', '/reservar?date=' + D4);
  ok(r.text.includes('Pista 2 · ocupada'), 'la parrilla muestra la pista bloqueada como ocupada');
  r = await pub.req('POST', '/reservar/nueva', { court_id: '2', date: D4, start_min: '840', duration_min: '60',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  r = await pub.req('POST', '/reservar/abrir/confirmar', { abrir: '0' });
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
  // El tope es 2 reservas activas: 1001 anula las suyas para los siguientes tests
  const b1400 = bbq("SELECT id FROM bookings WHERE titular_member_no = '1001' AND date = ? AND start_min = 840 AND status = 'active'", D4)[0].id;
  const bRecep = bbq("SELECT id FROM bookings WHERE titular_member_no = '1001' AND date = ? AND start_min = 480 AND status = 'active'", D6)[0].id;
  r = await pub.req('POST', '/reservar/anular', { booking_id: b1400 });
  ok(r.statusCode === 200 && r.text.includes('Reserva anulada'), '1001 anula la de las 14:00');
  r = await pub.req('POST', '/reservar/anular', { booking_id: bRecep });
  ok(r.statusCode === 200 && r.text.includes('Reserva anulada'), '1001 anula la creada por recepción');

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

  // 13. Partidos abiertos: niveles, visibilidad ±1, unirse, bloqueos
  const D7 = dayStr(7);
  const pub4 = makeClient(), pub5 = makeClient();
  r = await pub.req('POST', '/reservar/datos/nivel', { level: '3.5' });
  ok(r.statusCode === 200 && r.text.includes('Nivel actualizado'), '1001 pone su nivel 3.5');
  r = await pubW.req('POST', '/reservar/datos/nivel', { level: '3' });
  r = await pub2.req('POST', '/reservar/datos/nivel', { level: '5.5' });
  ok(bbq("SELECT level FROM club_members WHERE member_no = '1002'")[0].level === 5.5, 'nivel 5.5 en BD');
  r = await pub.req('POST', '/reservar/datos/nivel', { level: 'mal' });
  ok(r.statusCode === 200 && r.text.includes('Nivel no válido'), 'nivel inválido se rechaza');
  r = await pub.req('GET', '/reservar/socios/buscar?q=600777888');
  ok(JSON.parse(r.text).some(s => s.member_no === '1003'), 'búsqueda por móvil encuentra al socio');
  r = await pub.req('GET', '/reservar/socios/buscar?q=Socio%20Dos');
  ok(JSON.parse(r.text).some(s => s.member_no === '1002'), 'búsqueda por nombre encuentra al socio');
  r = await pub.req('GET', '/reservar/socios/buscar?q=1001');
  ok(JSON.parse(r.text).some(s => s.member_no === '1001'), 'búsqueda por nº de socio');
  r = await anon.req('GET', '/reservar/socios/buscar?q=6007');
  ok(r.statusCode === 302, 'el buscador exige login');

  // 1001 reserva con 1 acompañante → se pregunta si abrirlo
  r = await pub.req('POST', '/reservar/nueva', { court_id: '1', date: D7, start_min: '480', duration_min: '75',
    p1_name: 'Socio Tres', p1_member: '1003', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 200 && r.text.includes('¿Partido abierto?'), 'con huecos se pregunta si publicar abierto');
  ok(r.text.includes('2.5–4.5'), 'se muestra el rango de nivel del titular (3.5 ±1)');
  r = await pub.req('POST', '/reservar/abrir/confirmar', { abrir: '1' });
  ok(r.statusCode === 302 && r.location.startsWith('/reservar/ok?id='), 'publicar abierto redirige a ok');
  const bidO = r.location.split('=')[1];
  ok(bbq('SELECT open_spots FROM bookings WHERE id = ?', bidO)[0].open_spots === 2, 'abierto con 2 plazas');

  r = await pubW.req('GET', '/reservar?date=' + D7);
  ok(r.text.includes('2 plazas'), '1003 (nivel 3.0) ve el abierto en la parrilla');
  r = await pub2.req('GET', '/reservar?date=' + D7);
  ok(!r.text.includes('plazas') && r.text.includes('ocupada'), '1002 (nivel 5.5) lo ve como ocupada');
  r = await anon.req('GET', '/reservar?date=' + D7);
  ok(r.text.includes('2 plazas'), 'sin login el abierto también es visible');
  r = await anon.req('GET', '/reservar/abierto/' + bidO);
  ok(r.statusCode === 200 && r.text.includes('plazas libres'), 'detalle del abierto visible sin login');

  // Unirse: 1003 ya es jugador → error; 1004 (4.0) sí; 1002 (5.5) fuera de rango → no
  await admin.req('POST', '/admin/reservas/socios', { member_no: '1004', name: 'Socio Cuatro', phone: '600444555' });
  await admin.req('POST', '/admin/reservas/socios', { member_no: '1005', name: 'Socio Cinco', phone: '600555666' });
  await pub4.req('POST', '/reservar/activar', { member_no: '1004', phone: '600444555', pin: '1111', pin2: '1111' });
  await pub5.req('POST', '/reservar/activar', { member_no: '1005', phone: '600555666', pin: '2222', pin2: '2222' });
  await pub4.req('POST', '/reservar/datos/nivel', { level: '4' });
  await pub5.req('POST', '/reservar/datos/nivel', { level: '3.25' });
  r = await pubW.req('POST', '/reservar/abierto/' + bidO + '/unirse');
  ok(r.statusCode === 302 && decodeURIComponent(r.location).includes('Ya estás apuntado'), 'un jugador del partido no puede apuntarse dos veces');
  r = await pub4.req('POST', '/reservar/abierto/' + bidO + '/unirse');
  ok(r.statusCode === 302 && r.location.includes('/reservar/mis'), '1004 (nivel 4.0) se apunta');
  ok(bbq('SELECT open_spots FROM bookings WHERE id = ?', bidO)[0].open_spots === 1, 'queda 1 plaza');
  r = await pub2.req('POST', '/reservar/abierto/' + bidO + '/unirse');
  ok(r.statusCode === 302 && decodeURIComponent(r.location).includes('No puedes ver'), '1002 (nivel 5.5) no puede apuntarse');
  r = await pub5.req('POST', '/reservar/abierto/' + bidO + '/unirse');
  ok(bbq('SELECT open_spots FROM bookings WHERE id = ?', bidO)[0].open_spots === 0, 'al completarse se cierra solo');
  r = await pub.req('POST', '/reservar/anular', { booking_id: bidO });
  ok(r.statusCode === 200 && r.text.includes('Reserva anulada'), '1001 anula el abierto completado (hace hueco en el tope)');
  r = await pubW.req('GET', '/reservar?date=' + D7);
  ok(!r.text.includes('plazas'), 'cerrado: la parrilla ya no lo muestra en verde');

  // Bloqueo entre jugadores: 1001 bloquea a 1004 y abre otro partido
  await pub.req('POST', '/reservar/datos/bloqueos', { member_no: '1004' });
  ok(bbq("SELECT COUNT(*) c FROM member_blocks WHERE blocker_member_no = '1001'")[0].c === 1, 'bloqueo guardado');
  r = await pub.req('POST', '/reservar/nueva', { court_id: '2', date: D7, start_min: '600', duration_min: '75',
    p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 200 && r.text.includes('¿Partido abierto?'), 'segundo abierto: pregunta');
  r = await pub.req('POST', '/reservar/abrir/confirmar', { abrir: '1' });
  const bidO2 = r.location.split('=')[1];
  ok(bbq('SELECT open_spots FROM bookings WHERE id = ?', bidO2)[0].open_spots === 3, 'abierto con 3 plazas');
  r = await pub4.req('GET', '/reservar?date=' + D7);
  ok(!r.text.includes('plazas'), '1004 bloqueado no ve el abierto de 1001');
  r = await pub4.req('GET', '/reservar/abierto/' + bidO2);
  ok(r.statusCode === 302, '1004 bloqueado tampoco ve el detalle');
  r = await anon.req('GET', '/reservar?date=' + D7);
  ok(r.text.includes('3 plazas'), 'sin login sí se ve (público)');
  // El titular completa 1 jugador a mano: las plazas se reajustan solas
  await pub.req('POST', '/reservar/jugadores', { booking_id: bidO2, p1_name: 'Socio Dos', p1_member: '1002', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(bbq('SELECT open_spots FROM bookings WHERE id = ?', bidO2)[0].open_spots === 2, 'al añadir jugador manual bajan las plazas');
  await pub.req('POST', '/reservar/datos/bloqueos/eliminar', { member_no: '1004' });
  ok(bbq("SELECT COUNT(*) c FROM member_blocks WHERE blocker_member_no = '1001'")[0].c === 0, 'bloqueo eliminado');

  // Quitar un jugador de un partido cerrado pregunta si abrirlo
  const D8 = dayStr(8);
  r = await pub.req('POST', '/reservar/nueva', { court_id: '1', date: D8, start_min: '480', duration_min: '75',
    p1_name: 'Socio Dos', p1_member: '1002', p2_name: 'Socio Tres', p2_member: '1003', p3_name: 'Socio Cuatro', p3_member: '1004' });
  ok(r.statusCode === 302 && r.location.startsWith('/reservar/ok?id='), 'cerrado con los 4: sin preguntas');
  const bidC = r.location.split('=')[1];
  r = await pub.req('POST', '/reservar/jugadores', { booking_id: bidC, p1_name: 'Socio Dos', p1_member: '1002', p2_name: 'Socio Tres', p2_member: '1003', p3_name: '', p3_member: '' });
  ok(r.statusCode === 200 && r.text.includes('¿Partido abierto?'), 'al quitar un jugador se pregunta si abrirlo');
  r = await pub.req('POST', '/reservar/abrir/confirmar', { abrir: '0' });
  ok(r.statusCode === 302, 'responde que no → sigue cerrado');
  ok(bbq('SELECT open_spots FROM bookings WHERE id = ?', bidC)[0].open_spots === 0, 'sigue cerrado incompleto');

  // Invitado con nombre libre → pago pendiente (elige inicio válido del formulario)
  r = await pub2.req('GET', '/reservar/nueva?court=2&date=' + D7 + '&desde=680');
  const startG = (r.text.match(/<option value="(\d+)" data-d/) || [])[1];
  ok(!!startG, 'formulario ofrece inicios válidos tras el abierto');
  r = await pub2.req('POST', '/reservar/nueva', { court_id: '2', date: D7, start_min: startG, duration_min: '60',
    p1_name: 'Pepe Invitado', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '' });
  ok(r.statusCode === 200 && r.text.includes('¿Partido abierto?'), 'con invitado y huecos también pregunta');
  r = await pub2.req('POST', '/reservar/abrir/confirmar', { abrir: '0' });
  const bidG = r.location.split('=')[1];
  ok(bbq('SELECT payment_status FROM bookings WHERE id = ?', bidG)[0].payment_status === 'pending', 'invitado con nombre libre → pago pendiente');

  // El titular puede cerrar su abierto; el personal crea abiertos
  r = await pub.req('POST', '/reservar/abierto/' + bidO2 + '/cerrar');
  ok(bbq('SELECT open_spots FROM bookings WHERE id = ?', bidO2)[0].open_spots === 0, 'el titular cierra su abierto');
  r = await admin.req('GET', '/admin/reservas/nueva?date=' + D7 + '&court=2&desde=555');
  const startS = (r.text.match(/<option value="(\d+)" data-d/) || [])[1];
  r = await admin.req('POST', '/admin/reservas/nueva', { court_id: '2', date: D7, desde: '555', start_min: startS, duration_min: '60',
    titular_member_no: '1002', p1_name: '', p1_member: '', p2_name: '', p2_member: '', p3_name: '', p3_member: '', open_spots: '2' });
  ok(r.statusCode === 302, 'admin crea abierto con 2 plazas');
  ok(bbq("SELECT open_spots FROM bookings WHERE date = ? AND titular_member_no = '1002' AND start_min = ?", D7, startS)[0].open_spots === 2, 'plazas del staff en BD');
  r = await admin.req('GET', '/admin/reservas/dia?date=' + D7);
  ok(r.text.includes('Abierto'), 'el día del admin muestra la insignia de abierto');
  r = await admin.req('GET', '/admin/reservas/socios');
  ok(r.text.includes('<th>Nivel</th>'), 'socios muestra la columna de nivel');

  // 14. Fuerza bruta del PIN: 5 intentos fallidos bloquean 15 min
  for (let i = 0; i < 5; i++) await pub.req('POST', '/reservar/entrar', { member_no: '1001', pin: '0000', next: '/reservar/mis' });
  r = await pub.req('POST', '/reservar/entrar', { member_no: '1001', pin: '1234', next: '/reservar/mis' });
  ok(r.statusCode === 200 && r.text.includes('15 minutos'), 'tras 5 fallos el PIN correcto también se bloquea');

  // 16. Tope de reservas activas por socio (2 por defecto)
  process.env.DATA_DIR = DATA;
  const B = require('../src/lib/bookings');
  const nowHM = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  B.upsertMember('1004', 'Socio Cuatro', '600555666');
  B.bdb.prepare(`INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name, payment_status, open_spots)
    VALUES(4, 'Pista 4', ?, ?, ?, '1004', 'Socio Cuatro', 'ok', 0)`)
    .run(B.todayStr(), nowHM() - 120, nowHM() - 60);
  ok(B.activeBookingCount('1004') === 0, 'una reserva de hoy ya terminada no cuenta como activa');
  B.upsertMember('1005', 'Socio Cinco', '600666777');
  const findStart = (court, date) => {
    for (let s = 480; s <= 1200; s += 15) if (B.isBookable(court, date, s, 60)) return s;
    return null;
  };
  const sA = findStart(1, D6), sB = findStart(1, D5);
  ok(sA && sB, 'hay huecos libres en la parrilla para probar el tope');
  const mk5 = (court, date, start, byStaff) => B.createBooking({
    court_id: court, court_name: 'Pista ' + court, date, start_min: start, duration_min: 60,
    titular_member_no: '1005', players: [], byStaff: !!byStaff,
  });
  const t1 = mk5(1, D6, sA); ok(t1.id, '1ª reserva activa del socio 1005');
  const t2 = mk5(1, D5, sB); ok(t2.id, '2ª reserva activa del socio 1005');
  ok(B.activeBookingCount('1005') === 2, 'activeBookingCount = 2');
  // Tercer hueco el mismo día que t1 pero sin solaparse con ella
  let sC = null;
  for (let s = 480; s <= 1200; s += 15) {
    if (B.overlaps(s, s + 60, sA, sA + 60)) continue;
    if (B.isBookable(2, D6, s, 60)) { sC = s; break; }
  }
  ok(!!sC, 'hay un tercer hueco sin solape');
  const t3 = mk5(2, D6, sC);
  ok(!t3.id && t3.error && t3.error.includes('2 reservas activas'), 'la 3ª reserva se rechaza por el tope');
  const t4 = mk5(2, D6, sC, true);
  ok(t4.id, 'recepción/admin (byStaff) pueden saltarse el tope');
  B.cancelBooking(t4.id, true); B.cancelBooking(t1.id, true);
  const t5 = mk5(2, D6, sC);
  ok(t5.id, 'tras anular una, el socio vuelve a poder reservar');

  console.log(`\n${pass} OK, ${fail} FALLOS`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
