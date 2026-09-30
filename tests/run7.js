// Pruebas fase 1 reservas: config, parrilla, reserva con invitados,
// lista de espera, recepción (pagos/cargos) y bloqueos.
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
const dbq = qdb('season-1.db'), bbq = qdb('meta.db');
const qrun = (f) => (sql, ...p) => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(DATA + '/' + f); try { return d.prepare(sql).run(...p); } finally { d.close(); } };
const dbrun = qrun('season-1.db');
const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
const TOM = (() => { const d = new Date(Date.now() + 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), pub = makeClient(), recep = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });
  await admin.req('POST', '/admin/ajustes/recepcion-password', { password: 'recep123' });
  dbrun("INSERT INTO courts(name, active) VALUES('Pista 1', 1), ('Pista 2', 1)");

  // 1. Config: parrilla inválida se rechaza, válida se guarda
  let r = await admin.req('GET', '/admin/reservas/config');
  ok(r.statusCode === 200 && r.text.includes('Franja de reserva'), 'config de reservas accesible');
  r = await admin.req('POST', '/admin/reservas/config', { open: '08:00', close: '20:00', slot_min: '75', days_ahead: '14', hold_min: '10', cancel_limit_h: '3', guest_price: '' });
  ok(r.statusCode === 200 && r.text.includes('múltiplo exacto'), 'parrilla con huecos se rechaza (75 min en 12 h)');
  r = await admin.req('POST', '/admin/reservas/config', { open: '08:00', close: '20:00', slot_min: '60', days_ahead: '14', hold_min: '10', cancel_limit_h: '3', guest_price: '6' });
  ok(r.statusCode === 200 && r.text.includes('Configuración guardada'), 'parrilla válida se guarda');

  // 2. Socios: alta manual + importación de la liga
  await admin.req('POST', '/admin/reservas/socios', { member_no: '1001', name: 'Socio Uno', phone: '600111222' });
  await admin.req('POST', '/admin/reservas/socios', { member_no: '1002', name: 'Socio Dos', phone: '600333444' });
  dbrun("INSERT INTO players(name, phone, member_no, member_verified) VALUES('Liga Tres', '600555666', '1003', 1)");
  r = await admin.req('POST', '/admin/reservas/socios/importar', {});
  ok(r.location.includes('1%20socio'), 'importa 1 socio verificado de la liga');
  ok(bbq("SELECT COUNT(*) c  FROM club_members")[0].c === 3, 'hay 3 socios en total');

  // 3. Parrilla pública
  r = await pub.req('GET', '/reservar?date=' + TOM);
  ok(r.statusCode === 200 && r.text.includes('Pista 1') && r.text.includes('Libre'), 'parrilla pública con franjas libres');

  // 4. Reserva con un invitado (nº de socio inexistente cuenta como invitado)
  const B1 = { court_id: '1', date: TOM, start_min: '600', nslots: '1', titular: '1001',
    p1_name: 'Socio Uno', p1_member: '1001', p2_name: 'Socio Dos', p2_member: '1002',
    p3_name: 'Liga Tres', p3_member: '1003', p4_name: 'Invitado X', p4_member: '9999' };
  r = await pub.req('POST', '/reservar/nueva', B1);
  ok(r.statusCode === 302 && r.location.startsWith('/reservar/ok?id='), 'reserva creada redirige a confirmación');
  const bid = r.location.split('=')[1];
  r = await pub.req('GET', '/reservar/ok?id=' + bid);
  ok(r.text.includes('Invitado') && r.text.includes('recepción'), 'confirmación avisa del pago del invitado en recepción');
  ok(bbq("SELECT payment_status FROM bookings WHERE id = ?", bid)[0].payment_status === 'pending', 'pago pendiente por el invitado');

  // 5. La franja ya no está libre y no se puede duplicar
  r = await pub.req('GET', '/reservar?date=' + TOM);
  ok(r.text.includes('Ocupado'), 'la parrilla marca la franja como ocupada');
  r = await pub.req('POST', '/reservar/nueva', { ...B1, titular: '1002' });
  ok(r.statusCode === 200 && r.text.includes('ya está reservada'), 'no se puede reservar dos veces la misma franja');

  // 6. Mis reservas + anulación
  r = await pub.req('POST', '/reservar/mis', { member_no: '1001' });
  ok(r.text.includes('Pista 1') && r.text.includes('Anular'), 'mis reservas muestra la reserva');
  r = await pub.req('POST', '/reservar/anular', { booking_id: bid, member_no: '1001' });
  ok(r.text.includes('Reserva anulada'), 'el socio puede anular su reserva');
  ok(bbq("SELECT status FROM bookings WHERE id = ?", bid)[0].status === 'cancelled', 'reserva anulada en BD');

  // 7. Lista de espera: se ocupa, se apunta el 1002, se libera y se le ofrece
  r = await pub.req('POST', '/reservar/nueva', B1);
  const bid2 = r.location.split('=')[1];
  r = await pub.req('POST', '/reservar/espera', { court_id: '1', date: TOM, start_min: '600', member_no: '1002' });
  ok(r.text.includes('lista de espera'), 'apuntado a la lista de espera');
  await pub.req('POST', '/reservar/anular', { booking_id: bid2, member_no: '1001' });
  const offer = bbq("SELECT id FROM waitlist WHERE member_no = '1002' AND status = 'offered'");
  ok(offer.length === 1, 'al liberarse, la plaza se ofrece al primero en espera');
  r = await pub.req('GET', '/reservar/nueva?offer=' + offer[0].id);
  ok(r.statusCode === 200 && r.text.includes('lista de espera'), 'formulario de confirmación de oferta');
  r = await pub.req('POST', '/reservar/nueva', { offer_id: String(offer[0].id), court_id: '2', date: TOM, start_min: '700', titular: '1002',
    p1_name: 'Socio Dos', p1_member: '1002', p2_name: 'A', p2_member: '', p3_name: 'B', p3_member: '', p4_name: 'C', p4_member: '' });
  ok(r.statusCode === 302 && r.location.startsWith('/reservar/ok?id='), 'la oferta se confirma aunque el formulario venga manipulado (usa la franja ofrecida)');
  const bid3 = r.location.split('=')[1];
  const b3 = bbq("SELECT court_id, start_min FROM bookings WHERE id = ?", bid3)[0];
  ok(b3.court_id === 1 && b3.start_min === 600, 'la reserva de la oferta es la franja ofrecida, no la manipulada');

  // 8. Recepción: ve pendientes, marca pagado y añade cargo de luz
  await recep.req('POST', '/recepcion/login', { password: 'recep123' });
  r = await recep.req('GET', '/recepcion/reservas?date=' + TOM);
  ok(r.statusCode === 200 && r.text.includes('Pendientes de pago'), 'recepción ve los pagos pendientes');
  await recep.req('POST', `/recepcion/reservas/${bid3}/pago`, { paid: '1' });
  ok(bbq("SELECT payment_status FROM bookings WHERE id = ?", bid3)[0].payment_status === 'ok', 'recepción marca la reserva como pagada');
  await recep.req('POST', `/recepcion/reservas/${bid3}/cargo`, { label: 'Luz', amount: '4,50' });
  ok(bbq("SELECT amount_cents FROM booking_charges WHERE booking_id = ?", bid3)[0].amount_cents === 450, 'cargo extra de luz de 4,50 €');
  r = await recep.req('GET', '/recepcion/reservas?date=' + TOM);
  ok(r.text.includes('Luz') && r.text.includes('Cobrado'), 'recepción ve el cargo pendiente de cobro');

  // 9. Bloqueo con conflicto: avisa, y con force anula y bloquea
  r = await pub.req('POST', '/reservar/nueva', { ...B1, court_id: '2', start_min: '660' });
  const bid4 = r.location.split('=')[1];
  r = await admin.req('POST', '/admin/reservas/bloqueos', { court_id: '2', date: TOM, start: '11:00', end: '12:00', reason: 'torneo', notes: '' });
  ok(r.statusCode === 200 && r.text.includes('afectadas'), 'el bloqueo con reservas muestra confirmación');
  r = await admin.req('POST', '/admin/reservas/bloqueos', { court_id: '2', date: TOM, start: '11:00', end: '12:00', reason: 'torneo', notes: '', force: '1' });
  ok(r.statusCode === 302, 'bloqueo forzado redirige');
  ok(bbq("SELECT status FROM bookings WHERE id = ?", bid4)[0].status === 'cancelled', 'la reserva afectada queda anulada');
  r = await pub.req('GET', '/reservar?date=' + TOM);
  ok(r.text.includes('Bloqueada'), 'la parrilla muestra la pista bloqueada');

  // 10. Recordatorios por email (lógica directa del lib; sin clave no se envía nada)
  process.env.DATA_DIR = DATA;
  const B2 = require('../src/lib/bookings');
  B2.setCfg('reminders_enabled', '1');
  B2.setCfg('reminder_hours', '3');
  B2.upsertMember('MREM', 'Remi', '', 'remi@example.com');
  const bbrun = qrun('meta.db');
  const soon = new Date(Date.now() + 60 * 60000); // empieza dentro de 1 h
  const sMin = soon.getHours() * 60 + soon.getMinutes();
  const bidR = bbrun('INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name) VALUES(1, ?, ?, ?, ?, ?, ?)',
    'Pista 1', B2.todayStr(soon), sMin, sMin + 60, 'MREM', 'Remi').lastInsertRowid;
  bbrun('INSERT INTO booking_players(booking_id, name, member_no, is_guest) VALUES(?, ?, ?, 0), (?, ?, ?, 1), (?, ?, ?, 1), (?, ?, ?, 1)', bidR, 'Remi', 'MREM', bidR, 'A', '', bidR, 'B', '', bidR, 'C', '');
  const due1 = B2.dueReminders();
  ok(due1.length === 1 && due1[0].titular_email === 'remi@example.com', 'dueReminders detecta la reserva próxima con email');
  const past = new Date(Date.now() - 179 * 60000);
  ok(B2.dueReminders(past).length === 0, 'fuera de la ventana (3 h) no hay recordatorio');
  const nR = await B2.checkReminders();
  ok(nR === 1, 'checkReminders procesa 1 recordatorio');
  ok(bbq('SELECT reminded_at FROM bookings WHERE id = ?', bidR)[0].reminded_at == null, 'sin BREVO_API_KEY no marca como avisada (skipped)');
  B2.upsertMember('MNO', 'Sin Email');
  bbrun('INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name) VALUES(1, ?, ?, ?, ?, ?, ?)',
    'Pista 1', B2.todayStr(soon), sMin, sMin + 60, 'MNO', 'Sin Email');
  ok(B2.dueReminders().length === 1, 'el titular sin email no genera recordatorio');

  // 11. Dominio propio: la raíz del BOOKING_HOST muestra la parrilla
  const hostGet = (host) => new Promise((res, rej) => {
    const rq = http.request({ port: PORT, path: '/', method: 'GET', headers: { Host: host } }, rs => {
      let t = ''; rs.on('data', c => t += c); rs.on('end', () => res({ statusCode: rs.statusCode, text: t }));
    });
    rq.on('error', rej); rq.end();
  });
  const gridRes = await pub.req('GET', '/reservar');
  const domRes = await hostGet('reservas.test');
  ok(domRes.statusCode === 200 && domRes.text === gridRes.text, 'el dominio propio sirve la parrilla en /');
  const homeRes = await hostGet('localhost');
  ok(homeRes.statusCode === 200 && homeRes.text !== gridRes.text, 'el dominio principal sigue mostrando la liga');

  console.log(`\n${pass} OK, ${fail} FALLOS`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
