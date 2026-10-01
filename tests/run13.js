// Pruebas: al completar los jugadores de un partido abierto desde el día
// (admin/recepción), las plazas libres se recalculan y el partido se cierra
// solo al llegar a 4 jugadores.
const DATA = '/tmp/test-v9k/data13';
process.env.DATA_DIR = DATA;
require('fs').rmSync(DATA, { recursive: true, force: true });
const B = require('../src/lib/bookings');
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

const dayStr = (off) => { const d = new Date(Date.now() + off * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TOM = dayStr(1);
B.setCfg('open_min', 540); B.setCfg('close_min', 1320);
B.setCfg('slot_durations', '75,60');
for (const [no, name] of [['301', 'Test Uno'], ['302', 'Test Dos'], ['303', 'Test Tres'], ['304', 'Test Cuatro']])
  B.upsertMember(no, name, '6000000' + no.slice(1));

// Partido abierto: titular + 3 plazas libres
const ins = B.bdb.prepare(`INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name, open_spots)
  VALUES(2,'Pista 2',?,?,?, '302','Test Dos', 3)`).run(TOM, 720, 795);
const id = Number(ins.lastInsertRowid);
B.setPlayers(id, '302', []);
const spots0 = () => B.bdb.prepare('SELECT open_spots FROM bookings WHERE id = ?').get(id).open_spots;

// Flujo "Completar jugadores": setPlayers + syncOpenSpots (como hacen las rutas staff)
function completar(extras) {
  B.setPlayers(id, '302', extras);
  B.syncOpenSpots(id);
}

// 1. Con 1 jugador más (2 en total) sigue abierto con 2 plazas
completar([{ name: 'Test Tres', member_no: '303' }]);
ok(spots0() === 2, '2 jugadores → 2 plazas libres, sigue abierto (obtenido ' + spots0() + ')');
ok(B.slotCell(2, TOM, 750, null).st === 'open', 'la parrilla lo sigue mostrando abierto');

// 2. Con los 3 que faltaban (4 en total) se cierra solo
completar([
  { name: 'Test Tres', member_no: '303' },
  { name: 'Test Cuatro', member_no: '304' },
  { name: 'Invitado X', member_no: '' },
]);
ok(spots0() === 0, '4 jugadores → 0 plazas, partido cerrado (obtenido ' + spots0() + ')');
const cell = B.slotCell(2, TOM, 750, null);
ok(cell.st === 'busy' && cell.booking && cell.booking.titular_name === 'Test Dos', 'la parrilla lo muestra cerrado con el nombre del titular');
ok(B.bookingColor({ open_spots: 0, kind: 'reserva' }) === '#f87171', 'cerrado → tarjeta roja');

// 3. Una reserva cerrada no se ve afectada por syncOpenSpots
const ins2 = B.bdb.prepare(`INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name)
  VALUES(1,'Pista 1',?,?,?, '301','Test Uno')`).run(TOM, 600, 675);
const id2 = Number(ins2.lastInsertRowid);
B.setPlayers(id2, '301', [{ name: 'Test Dos', member_no: '302' }]);
B.syncOpenSpots(id2);
ok(B.bdb.prepare('SELECT open_spots FROM bookings WHERE id = ?').get(id2).open_spots === 0, 'cerrada sigue cerrada');


// 4. Auto-reparación al arrancar: simula una fila inconsistente como la de producción
const ins3 = B.bdb.prepare(`INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name, open_spots)
  VALUES(2,'Pista 2',?,?,?, '302','Test Dos', 3)`).run(TOM, 900, 975);
const id3 = Number(ins3.lastInsertRowid);
B.setPlayers(id3, '302', [
  { name: 'Test Uno', member_no: '301' },
  { name: 'Test Tres', member_no: '303' },
  { name: 'Test Cuatro', member_no: '304' },
]); // 4 jugadores pero open_spots sigue en 3 (sin sync): estado inconsistente
B.bdb.exec(`UPDATE bookings SET open_spots = max(0, 4 - (SELECT COUNT(*) FROM booking_players bp WHERE bp.booking_id = bookings.id))
  WHERE status = 'active' AND open_spots > 4 - (SELECT COUNT(*) FROM booking_players bp WHERE bp.booking_id = bookings.id)`);
ok(B.bdb.prepare('SELECT open_spots FROM bookings WHERE id = ?').get(id3).open_spots === 0, 'la migración repara filas inconsistentes (4 jugadores, 3 plazas → 0)');
console.log(`\n${pass} OK, ${fail} FALLOS`);
process.exit(fail ? 1 : 0);
