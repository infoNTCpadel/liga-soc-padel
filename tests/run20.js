// Pruebas: 1 reserva/partido por socio y día; pestañas de Mis reservas;
// chip "Apuntado" en parrilla; bloqueos multi-pista con color y motivo en la pista.
const DATA = '/tmp/test-v9k/data20';
process.env.DATA_DIR = DATA;
require('fs').rmSync(DATA, { recursive: true, force: true });
const B = require('../src/lib/bookings');
const ejs = require('ejs'), fs = require('fs');
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

const dayStr = (off) => { const d = new Date(Date.now() + off * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TOM = dayStr(1), YEST = dayStr(-1);
B.setCfg('open_min', 540); B.setCfg('close_min', 1320);
B.setCfg('slot_durations', '75,60');
B.upsertMember('501', 'Socio Uno', '600000501');
B.upsertMember('502', 'Socio Dos', '600000502');
B.upsertMember('503', 'Socio Tres', '600000503');
B.upsertMember('504', 'Socio Cuatro', '600000504');
B.setPin('501', '1111'); B.setPin('502', '2222'); B.setPin('504', '4444');
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
const courts = [{ id: 1, name: 'Pista 1', active: 1 }, { id: 2, name: 'Pista 2', active: 1 }];
const gridLocals = (memberNo) => ({
  date: TOM, rows: B.slotDay(TOM, memberNo ? { member_no: memberNo, level: null } : null, courts),
  courts, config: B.getConfig(), waitStarts: {}, noCourts: false, closed: false,
  member: memberNo ? { name: 'Socio', member_no: memberNo } : null, staffMode: false,
  joinedIds: new Set(memberNo ? B.playerBookingIds(TOM, memberNo) : []),
  info: null, error: null, prev: null, next: null, tabs: [TOM], tabLabel: (d) => d,
  minToStr: B.minToStr, chatEnabled: false, filename: 'src/views/reservas/grid.ejs',
});
const renderGrid = (memberNo) => ejs.render(fs.readFileSync('src/views/reservas/grid.ejs', 'utf8'), gridLocals(memberNo));

// ---- 1. Una reserva o partido por socio y día ----
let r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 600, duration_min: 75, titular_member_no: '501', players: [], open: false, byStaff: true });
ok(r.id > 0, '1/día: primera reserva del día OK');
r = B.quickBook({ court_id: 2, court_name: 'Pista 2', date: TOM, start_min: 900, duration_min: 75, titular_member_no: '501', players: [], open: false });
ok(r.error && r.error.includes('uno por día'), '1/día: segunda reserva el mismo día → error (' + (r.error || 'sin error') + ')');
r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: dayStr(2), start_min: 600, duration_min: 75, titular_member_no: '501', players: [], open: false });
ok(r.id > 0, '1/día: otro día sí se puede');
r = B.quickBook({ court_id: 2, court_name: 'Pista 2', date: TOM, start_min: 960, duration_min: 60, titular_member_no: '501', players: [], open: false, byStaff: true });
ok(r.id > 0, '1/día: el personal puede saltarse la regla');
ok(B.memberDayBooking(TOM, '501') && B.memberDayBooking(TOM, '501').id > 0, 'memberDayBooking encuentra la reserva');
ok(!B.memberDayBooking(TOM, '999'), 'memberDayBooking null sin nada ese día');

// unirse a un segundo partido el mismo día
r = B.quickBook({ court_id: 2, court_name: 'Pista 2', date: TOM, start_min: 840, duration_min: 75, titular_member_no: '503', players: [], open: true, byStaff: true });
const openA = r.id;
let j = B.joinOpenMatch(openA, B.getMember('502'));
ok(j.ok, '502 se apunta al partido A');
r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 1020, duration_min: 75, titular_member_no: '503', players: [], open: true, byStaff: true });
const openB = r.id;
j = B.joinOpenMatch(openB, B.getMember('502'));
ok(j.error && j.error.includes('uno por día'), '1/día: apuntarse a otro partido el mismo día → error');
j = B.joinOpenMatch(openB, B.getMember('501'));
ok(j.error && j.error.includes('uno por día'), '1/día: con reserva propia tampoco puede apuntarse');

// ---- 2. memberArea: partidos e historial ----
const area502 = B.memberArea('502');
ok(area502.partidos.some(b => b.id === openA), 'partidos: incluye el abierto donde está apuntado (no titular)');
ok(!area502.partidos.some(b => b.ya_jugada), 'partidos: solo próximos');
B.bdb.prepare(`INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name, status)
  VALUES(1,'Pista 1',?,600,675,'501','Socio Uno','active')`).run(YEST);
const pastId = Number(B.bdb.prepare('SELECT last_insert_rowid() AS id').get().id);
B.bdb.prepare(`INSERT INTO booking_players(booking_id, name, member_no, is_guest) VALUES(?, 'Socio Uno', '501', 0)`).run(pastId);
const area501 = B.memberArea('501');
ok(area501.historial.some(b => b.id === pastId), 'historial: incluye la reserva pasada');
ok(area501.historial.length && area501.partidos.length >= 0, 'memberArea devuelve partidos e historial');

// ---- 3. Parrilla: chip "Apuntado" para el no titular ----
const html502 = renderGrid('502');
ok(html502.includes('chip joined') && html502.includes('Apuntado'), 'parrilla: el apuntado ve "✓ Apuntado"');
ok(html502.includes('href="/reservar/mis?tab=partidos"'), 'parrilla: "Apuntado" enlaza a la pestaña Partidos');
const html501 = renderGrid('501');
ok(html501.includes('chip mine'), 'parrilla: el titular sigue viendo "Mi reserva" en lima');
const htmlAnon = renderGrid(null);
ok(!htmlAnon.includes('chip joined') && !htmlAnon.includes('chip mine'), 'parrilla: visitante sin marcas');

// ---- 4. Bloqueos: color + motivo (20 car.) en la pista ----
r = B.createBlock({ court_id: 1, court_name: 'Pista 1', date_from: TOM, date_to: TOM, start_min: 720, end_min: 795, reason: 'torneo', notes: 'Torneo social del club', color: '#60a5fa' });
ok(r.id > 0 && !r.error, 'bloqueo con color creado');
const brow = B.bdb.prepare('SELECT * FROM court_blocks WHERE id = ?').get(r.id);
ok(brow.color === '#60a5fa', 'color guardado en la BD');
const cell = B.slotCell(1, TOM, 730, null);
ok(cell.st === 'blocked' && cell.block.color === '#60a5fa' && cell.block.notes === 'Torneo social del club', 'slotCell adjunta color y notas');
const g = B.staffGrid(TOM, { staffBase: '/admin/reservas', staffDay: '/admin/reservas/dia', anularPrefix: '/admin/reservas/reservas/' }, courts);
const staffHtml = ejs.render(fs.readFileSync('src/views/reservas/grid.ejs', 'utf8'), {
  ...g, rows: B.slotDay(TOM, null, courts), config: B.getConfig(), waitStarts: {},
  noCourts: false, closed: false, member: null, staffMode: true, info: null, error: null,
  joinedIds: new Set(), filename: 'src/views/reservas/grid.ejs',
});
ok(staffHtml.includes('Torneo social del cl') && !staffHtml.includes('Torneo social del club</span>'), 'staff: motivo recortado a 20 caracteres');
ok(staffHtml.includes('border-color:#60a5fa'), 'staff: la celda usa el color del bloqueo');
// multi-pista: segundo bloqueo en otra pista, mismo tramo
r = B.createBlock({ court_id: 2, court_name: 'Pista 2', date_from: TOM, date_to: TOM, start_min: 720, end_min: 795, reason: 'torneo', notes: '', color: '#f87171' });
ok(r.id > 0, 'segundo bloqueo en otra pista');
const htmlPub = renderGrid(null);
ok((htmlPub.match(/Torneo/g) || []).length >= 2, 'pública: el motivo sale en las dos pistas');
const bloqHtml = ejs.render(fs.readFileSync('src/views/reservas-admin/bloqueos.ejs', 'utf8'), {
  blocks: B.listBlocks(), courts, config: B.getConfig(), error: null, minToStr: B.minToStr, today: TOM,
  filename: 'src/views/reservas-admin/bloqueos.ejs',
});
ok(bloqHtml.includes('name="court_ids"') && bloqHtml.includes('name="color"'), 'formulario: multi-pista y selector de color');

// ---- 5. mis.ejs: 3 pestañas + buscador ----
for (const tab of ['pendientes', 'partidos', 'historial']) {
  const misHtml = ejs.render(fs.readFileSync('src/views/reservas/mis.ejs', 'utf8'), {
    error: null, info: null, area: B.memberArea('501'), minToStr: B.minToStr,
    config: B.getConfig(), member: { name: 'Socio Uno', member_no: '501' }, tab,
    filename: 'src/views/reservas/mis.ejs',
  });
  ok(misHtml.includes('Reservas pendientes') && misHtml.includes('Partidos') && misHtml.includes('Historial'), 'mis: pestañas visibles (' + tab + ')');
}
const misPen = ejs.render(fs.readFileSync('src/views/reservas/mis.ejs', 'utf8'), {
  error: null, info: null, area: B.memberArea('501'), minToStr: B.minToStr,
  config: B.getConfig(), member: { name: 'Socio Uno', member_no: '501' }, tab: 'pendientes',
  filename: 'src/views/reservas/mis.ejs',
});
ok(misPen.includes('class="psearch"') && misPen.includes('/reservar/socios/buscar'), 'mis: buscador de socios para añadir jugadores');
ok(misPen.includes('mrow') && !misPen.includes('Añadir / cambiar jugadores</summary>\n      <form method="post" action="/reservar/jugadores" style="margin-top:.5em">'), 'mis: filas compactas con el nuevo formulario');

// ---- 6. HTTP: la regla 1/día también en la reserva exprés ----
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3462;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
function makeClient() {
  let cookie = '';
  const req = (method, pth, data) => new Promise((resolve, reject) => {
    const body = data ? new URLSearchParams(data).toString() : null;
    const rq = http.request({ port: PORT, path: pth, method,
      headers: { ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
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
  const c4 = makeClient();
  B.quickBook({ court_id: 2, court_name: 'Pista 2', date: TOM, start_min: 1080, duration_min: 75, titular_member_no: '504', players: [], open: false, byStaff: true });
  await c4.req('POST', '/reservar/entrar', { member_no: '504', pin: '4444' });
  // 504 ya tiene reserva ese día (10:00): la exprés debe fallar por la regla 1/día
  let h = await c4.req('POST', '/reservar/rapida', { court_id: '1', date: TOM, start_min: '915', duration_min: '75', abrir: '1' });
  ok(h.statusCode === 302 && decodeURIComponent(h.location).includes('uno por día'), 'HTTP: exprés con reserva ese día → error 1/día');
  // apuntarse por HTTP al partido B con 501 (tiene reserva) → error
  const c1 = makeClient();
  await c1.req('POST', '/reservar/entrar', { member_no: '501', pin: '1111' });
  h = await c1.req('POST', '/reservar/abierto/' + openB + '/unirse');
  ok(h.statusCode === 302 && decodeURIComponent(h.location).includes('uno por día'), 'HTTP: unirse con reserva ese día → error 1/día');
  srv.kill();
  console.log(fail === 0 ? 'OK run20: ' + pass + ' pruebas' : 'FALLOS run20: ' + fail + ' de ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO: excepción', e.message); srv.kill(); process.exit(1); });
