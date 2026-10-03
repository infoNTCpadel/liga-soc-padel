// Pruebas: colores por tipo en la parrilla del personal (abierto=azul, reservada=rojo,
// bloqueo=gris), tarjeta rica en reservas cerradas con nombre del titular,
// columna kind en bookings, y buscador en "Completar jugadores" de las vistas del día.
const DATA = '/tmp/test-v9k/data12';
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
const courts = [
  { id: 1, name: 'Pista 1', active: 1 }, { id: 2, name: 'Pista 2', active: 1 },
];

// ---- 1. Columna kind: existe y vale 'reserva' por defecto ----
const cols = B.bdb.prepare('PRAGMA table_info(bookings)').all().map(c => c.name);
ok(cols.includes('kind'), 'bookings tiene columna kind');

// ---- 2. Reserva cerrada y partido abierto ----
B.bdb.prepare(`INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name)
  VALUES(1,'Pista 1',?,?,?, '301','Test Uno')`).run(TOM, 600, 675); // 10:00–11:15 cerrada
B.bdb.prepare(`INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name, open_spots)
  VALUES(2,'Pista 2',?,?,?, '302','Test Dos', 2)`).run(TOM, 720, 795); // 12:00–13:15 abierta
ok(B.bdb.prepare(`SELECT kind FROM bookings WHERE titular_member_no='301'`).get().kind === 'reserva', 'kind por defecto = reserva');

// ---- 3. slotCell adjunta la reserva en celdas busy cerradas ----
const busy = B.slotCell(1, TOM, 630, null);
ok(busy.st === 'busy' && busy.booking && busy.booking.titular_name === 'Test Uno', 'busy cerrada lleva booking con el nombre');
const open = B.slotCell(2, TOM, 750, null);
ok(open.st === 'open' && open.booking, 'abierta sigue siendo open con booking');

// ---- 4. bookingColor por tipo ----
ok(B.bookingColor({ open_spots: 0, kind: 'reserva' }) === '#f87171', 'cerrada → rojo');
ok(B.bookingColor({ open_spots: 2, kind: 'reserva' }) === '#60a5fa', 'abierta → azul');
ok(B.bookingColor({ open_spots: 0, kind: 'clase' }) === '#a78bfa', 'clase → morado');
ok(B.bookingColor({ open_spots: 0, kind: 'torneo' }) === '#fbbf24', 'torneo → ámbar');
ok(B.bookingColor(null) === '#9aa88f', 'bloqueo/nulo → gris');

// ---- 5. Bloqueo: st 'blocked' con motivo ----
B.bdb.prepare(`INSERT INTO court_blocks(court_id, court_name, date, start_min, end_min, reason, date_from, date_to)
  VALUES(1,'Pista 1',?,?,?,'Clase escuela','${TOM}','${TOM}')`).run(TOM, 900, 975);
const bl = B.slotCell(1, TOM, 930, null);
ok(bl.st === 'blocked' && bl.block && bl.block.reason === 'Clase escuela', 'bloqueo → st blocked con motivo');

// ---- 6. Render de la parrilla del personal (admin) ----
const g = B.staffGrid(TOM, { staffBase: '/admin/reservas', staffDay: '/admin/reservas/dia', anularPrefix: '/admin/reservas/reservas/' }, courts);
const html = ejs.render(fs.readFileSync('src/views/reservas/grid.ejs', 'utf8'), {
  ...g, rows: B.slotDay(TOM, null, courts), config: B.getConfig(), waitStarts: {},
  noCourts: false, closed: false, member: null, joinedIds: new Set(), staffMode: true, info: null, error: null,
  filename: 'src/views/reservas/grid.ejs',
});
ok(html.includes('border-color:#f87171') && html.includes('Test Uno'), 'cerrada: tarjeta roja con el nombre del titular');
ok(html.includes('border-color:#60a5fa') && html.includes('<span class="rname">Test Dos</span>'), 'abierta: tarjeta azul con el nombre del titular');
ok(!html.includes('· abierto'), 'abierta: sin el texto "abierto" (el color azul ya lo dice)');
ok(/\d\/4/.test(html), 'tarjeta: contador de jugadores n/4 en dos líneas');
ok(html.includes('Bloqueo') && html.includes('Clase escuela'), 'bloqueo: chip gris con motivo en title');
ok(!html.includes('color de la pista'), 'leyenda sin colores por pista');
ok(html.includes('Reservada (pulsa para ver el detalle)'), 'leyenda: Reservada');
ok(html.includes('data-bid'), 'cerrada: botón clicable con detalle');

// ---- 7. Parrilla pública: ocupada/bloqueo sin colores de tipos ----
const pub = ejs.render(fs.readFileSync('src/views/reservas/grid.ejs', 'utf8'), {
  date: TOM, rows: B.slotDay(TOM, null, courts), courts, config: B.getConfig(), waitStarts: {},
  noCourts: false, closed: false, member: null, joinedIds: new Set(), staffMode: false, info: null, error: null,
  prev: null, next: null, tabs: [TOM], tabLabel: (d) => d, minToStr: B.minToStr,
  filename: 'src/views/reservas/grid.ejs',
});
ok(pub.includes('ocupada'), 'pública: ocupada/bloqueo siguen como "ocupada"');
ok(!pub.includes('#f87171') && !pub.includes('#60a5fa'), 'pública: sin colores de tipos');

// ---- 8. Vistas del día: buscador en "Completar jugadores" ----
for (const [f, base] of [
  ['src/views/reservas-admin/dia.ejs', '/admin/reservas/socios/buscar'],
  ['src/views/recepcion/reservas.ejs', '/recepcion/reservas/socios/buscar'],
]) {
  const src = fs.readFileSync(f, 'utf8');
  ok(src.includes('class="psearch"') && src.includes(base), f + ': buscador de jugadores');
  ok(src.includes('p<%= i + 1 %>_name') && src.includes('p<%= i + 1 %>_member'), f + ': conserva campos p1..p3');
  ok(!src.includes('placeholder="nº socio"'), f + ': sin campos manuales antiguos');
}

console.log(`\n${pass} OK, ${fail} FALLOS`);
process.exit(fail ? 1 : 0);
