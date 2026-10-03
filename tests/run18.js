// Pruebas: reserva exprés en 2 clics (quickBook + modales en la parrilla),
// auto-apertura al faltar jugadores y titulares recientes.
const DATA = '/tmp/test-v9k/data18';
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
B.upsertMember('301', 'Test Uno', '600000001');
B.upsertMember('302', 'Test Dos', '600000002');
const courts = [{ id: 1, name: 'Pista 1', active: 1 }, { id: 2, name: 'Pista 2', active: 1 }];

// ---- 1. quickBook socio: sin jugadores, abierta por defecto ----
let r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 690, duration_min: 75, titular_member_no: '301', players: [], open: true });
ok(r.id > 0, 'quickBook crea la reserva');
let b = B.getBooking(r.id);
ok(b.open_spots === 3 && b.players.length === 1, 'exprés socio: abierta con 3 plazas, solo el titular');

// ---- 2. quickBook con 1 jugador: auto-apertura con 2 plazas ----
r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 840, duration_min: 75, titular_member_no: '302', players: [{ name: 'Test Uno', member_no: '301' }], open: true });
b = B.getBooking(r.id);
ok(b.open_spots === 2, 'con 1 jugador: 2 plazas libres (obtenido ' + b.open_spots + ')');

// ---- 3. quickBook cerrada ----
r = B.quickBook({ court_id: 2, court_name: 'Pista 2', date: TOM, start_min: 690, duration_min: 60, titular_member_no: '302', players: [], open: false, byStaff: true });
ok(B.getBooking(r.id).open_spots === 0, 'exprés staff cerrada: 0 plazas');

// ---- 4. quickBook valida (hueco ocupado) ----
r = B.quickBook({ court_id: 1, court_name: 'Pista 1', date: TOM, start_min: 690, duration_min: 75, titular_member_no: '302', players: [], open: true });
ok(r.error, 'hueco ocupado → error de validación');

// ---- 5. quickBook titular inválido ----
r = B.quickBook({ court_id: 2, court_name: 'Pista 2', date: TOM, start_min: 840, duration_min: 60, titular_member_no: '999', players: [], open: false, byStaff: true });
ok(r.error, 'titular inexistente → error');

// ---- 6. recentTitulars ----
const rec = B.recentTitulars(6);
ok(rec.length >= 2 && rec[0].member_no && rec[0].name, 'recentTitulars devuelve titulares (' + rec.length + ')');
ok(new Set(rec.map(t => t.member_no)).size === rec.length, 'sin duplicados');

// ---- 7. Parrilla socio: modal exprés con data-attrs ----
const pubHtml = ejs.render(fs.readFileSync('src/views/reservas/grid.ejs', 'utf8'), {
  date: TOM, rows: B.slotDay(TOM, null, courts), courts, config: B.getConfig(), waitStarts: {},
  noCourts: false, closed: false, member: { name: 'Test Uno', member_no: '301' }, staffMode: false,
  info: null, error: null, prev: null, next: null, tabs: [TOM], tabLabel: (d) => d, minToStr: B.minToStr,
  chatEnabled: false, filename: 'src/views/reservas/grid.ejs',
});
ok(pubHtml.includes('id="qModal"') && pubHtml.includes('action="/reservar/rapida"'), 'socio: modal con form a /reservar/rapida');
ok(pubHtml.includes('data-cname="Pista 1"') && pubHtml.includes('data-start='), 'socio: enlaces libres con data-attrs');
ok(pubHtml.includes('Añadir jugadores'), 'socio: enlace a más opciones');
ok(pubHtml.includes('id="qOpen" checked'), 'socio: abierto marcado por defecto');

// ---- 8. Parrilla staff: modal con buscador y recientes ----
const g = B.staffGrid(TOM, { staffBase: '/admin/reservas', staffDay: '/admin/reservas/dia', anularPrefix: '/admin/reservas/reservas/' }, courts);
const staffHtml = ejs.render(fs.readFileSync('src/views/reservas/grid.ejs', 'utf8'), {
  ...g, rows: B.slotDay(TOM, null, courts), config: B.getConfig(), waitStarts: {},
  noCourts: false, closed: false, member: null, staffMode: true, info: null, error: null,
  filename: 'src/views/reservas/grid.ejs',
});
ok(staffHtml.includes('action="/admin/reservas/rapida"'), 'staff: modal con form a /admin/reservas/rapida');
ok(staffHtml.includes('id="qSearch"') && staffHtml.includes('/admin/reservas/socios/buscar'), 'staff: buscador de titular en el modal');
ok(staffHtml.includes('qrecent'), 'staff: chips de titulares recientes');
ok(staffHtml.includes('Más opciones'), 'staff: enlace al formulario completo');

// ---- 9. ok.ejs: aviso de partido abierto ----
const okHtml = ejs.render(fs.readFileSync('src/views/reservas/ok.ejs', 'utf8'), {
  b: B.getBooking(1), config: B.getConfig(), minToStr: B.minToStr, abierto: true,
  filename: 'src/views/reservas/ok.ejs',
});
ok(okHtml.includes('partido abierto'), 'ok.ejs: aviso de partido abierto');
const okHtml2 = ejs.render(fs.readFileSync('src/views/reservas/ok.ejs', 'utf8'), {
  b: B.getBooking(1), config: B.getConfig(), minToStr: B.minToStr, abierto: false,
  filename: 'src/views/reservas/ok.ejs',
});
ok(!okHtml2.includes('Se ha publicado como'), 'ok.ejs: sin aviso si no es abierto');

console.log(`\n${pass} OK, ${fail} FALLOS`);
process.exit(fail ? 1 : 0);
