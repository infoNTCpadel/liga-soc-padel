// Pruebas unitarias del núcleo de reservas: inicios alcanzables por
// combinaciones de 60/75, tramos libres, PIN y bloqueos por rango.
const DATA = '/tmp/test-v9e/data8';
process.env.DATA_DIR = DATA;
require('fs').rmSync(DATA, { recursive: true, force: true });
const B = require('../src/lib/bookings');
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + ` (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`);

// reachableSet: desplazamientos alcanzables sumando 60/75
eq([...B.reachableSet([60, 75], 200)].sort((a, b) => a - b), [0, 60, 75, 120, 135, 150, 180, 195], 'reachableSet 60/75 hasta 200');

// validStarts: tramo de 10:15 (615) a cierre 20:00 (1200) — el ejemplo de Mathius
const vs = B.validStarts(615, 1200, [60, 75]);
const starts = vs.map(v => v.start_min);
ok(starts.includes(615), 'desde 10:15 se puede a las 10:15');
ok(starts.includes(675), 'desde 10:15 se puede a las 11:15 (+60)');
ok(starts.includes(690), 'desde 10:15 se puede a las 11:30 (+75)');
ok(!starts.includes(630), 'desde 10:15 NO se puede a las 10:30');
ok(!starts.includes(645), 'desde 10:15 NO se puede a las 10:45');
const at1115 = vs.find(v => v.start_min === 675);
eq(at1115.durations, [60, 75], 'a las 11:15 caben 60 y 75');

// Tramo de exactamente 60: solo el inicio, solo 60
eq(B.validStarts(0, 60, [60, 75]).map(v => [v.start_min, v.durations]), [[0, [60]]], 'tramo de 60 → un inicio, duración 60');

// Tramo de 130: 0 (60,75), 60 (60), 75 no deja nada rellenable
eq(B.validStarts(0, 130, [60, 75]).map(v => [v.start_min, v.durations]), [[0, [60, 75]], [60, [60]]], 'tramo de 130 → inicios 0 y 60');

// Tramo menor que la duración mínima
eq(B.validStarts(0, 45, [60, 75]), [], 'tramo de 45 → sin inicios');

// parseDurations: normaliza, ordena y elimina duplicados
eq(B.parseDurations('75,60,75,abc'), [60, 75], 'parseDurations normaliza');
eq(B.parseDurations(''), [], 'parseDurations vacío');

// validateConfig
ok(B.validateConfig(480, 1380, '60,75') === null, 'config válida');
ok(B.validateConfig(480, 480, '60,75') !== null, 'apertura = cierre inválida');
ok(B.validateConfig(480, 1380, '') !== null, 'sin duraciones inválida');
ok(B.validateConfig(480, 1380, '900') !== null, 'duración mayor que el horario inválida');

// PIN: activación, verificación y reseteo
B.upsertMember('P1', 'Pin Uno', '600111222');
ok(!B.hasPin('P1'), 'sin PIN al principio');
ok(!B.checkPin('P1', '1234'), 'sin PIN no valida');
B.setPin('P1', '1234');
ok(B.hasPin('P1'), 'PIN guardado');
ok(B.checkPin('P1', '1234'), 'PIN correcto valida');
ok(!B.checkPin('P1', '1235'), 'PIN erróneo no valida');
ok(!B.checkPin('P1', ''), 'PIN vacío no valida');
ok(B.validPin('1234') && B.validPin('12345678') && !B.validPin('123') && !B.validPin('abcd'), 'validPin: 4–8 dígitos');
const tmp = B.resetPin('P1');
ok(/^\d{6}$/.test(tmp) && B.checkPin('P1', tmp), 'resetPin genera temporal válido');
const stored = B.bdb.prepare('SELECT pin_hash FROM club_members WHERE member_no = ?').get('P1').pin_hash;
ok(!stored.includes('1234') && !stored.includes(tmp), 'el PIN se guarda con hash, no en claro');
B.setMemberActive('P1', false);
ok(!B.checkPin('P1', tmp), 'socio desactivado no puede entrar');

// Bloqueos por rango: validación y detección de reservas afectadas
B.setCfg('open_min', '480'); B.setCfg('close_min', '1200'); B.setCfg('slot_durations', '60,75');
B.setCfg('days_ahead', '30');
const D1 = B.addDays(B.todayStr(), 2), D2 = B.addDays(B.todayStr(), 4);
B.upsertMember('B1', 'Bloqueo Uno', '600000001');
const created = B.createBooking({ court_id: 1, court_name: 'P1', date: D2, start_min: 600, duration_min: 75, titular_member_no: 'B1', players: [] });
ok(!created.error, 'reserva de prueba creada');
const pre = B.createBlock({ court_id: 1, court_name: 'P1', date_from: D1, date_to: B.addDays(B.todayStr(), 4), start_min: 540, end_min: 840, reason: 'torneo' });
ok(pre.conflict && pre.conflict.length === 1, 'bloqueo con reserva afectada devuelve conflicto');
ok(B.bdb.prepare('SELECT status FROM bookings WHERE id = ?').get(created.id).status === 'active', 'sin force la reserva sigue activa');
const forced = B.createBlock({ court_id: 1, court_name: 'P1', date_from: D1, date_to: B.addDays(B.todayStr(), 4), start_min: 540, end_min: 840, reason: 'torneo', force: true });
ok(!forced.error && forced.cancelled === 1, 'con force se anula la afectada');
ok(B.bdb.prepare('SELECT status FROM bookings WHERE id = ?').get(created.id).status === 'cancelled', 'reserva anulada por el bloqueo');
ok(B.validateBlock({ court_id: 1, date_from: D2, date_to: D1, start_min: 540, end_min: 840 }) !== null, 'rango invertido inválido');
ok(B.validateBlock({ court_id: 1, date_from: D1, date_to: D2, start_min: 840, end_min: 540 }) !== null, 'tramo invertido inválido');
// El bloqueo afecta a todos los días del rango
ok(!B.isPotentiallyValid(1, D1, 600, 75), '09:00–14:00 bloqueado también el primer día del rango');
ok(!B.isPotentiallyValid(1, B.addDays(B.todayStr(), 4), 600, 75), '…y el último');
ok(B.isPotentiallyValid(1, D2, 840, 60), 'a las 14:00 (fin del bloqueo) sí es válido');

// isBookable respeta el rango de fechas configurado
B.setCfg('days_ahead', '7');
ok(!B.isBookable(1, B.addDays(B.todayStr(), 8), 600, 75), 'fuera de days_ahead no es reservable');
ok(B.isPotentiallyValid(1, B.addDays(B.todayStr(), 7), 600, 75), 'en el límite de days_ahead sí');

// normalizePlayers: invitado = nombre sin socio válido
B.upsertMember('S1', 'Socio Uno', '1');
const rows = B.normalizePlayers(B.getMember('S1'), [
  { name: 'Socio Dos', member_no: '' }, { name: 'Invitado', member_no: 'ZZZ' }, { name: '', member_no: '' },
]);
eq(rows.map(r => [r.name, r.is_guest]), [['Socio Uno', 0], ['Socio Dos', 1], ['Invitado', 1]], 'jugadores: titular socio, resto invitados si no son socios');
const rows2 = B.normalizePlayers(B.getMember('S1'), [{ name: 'Socio Uno Bis', member_no: 'S1' }]);
eq(rows2[1].is_guest, 0, 'nº de socio válido no es invitado');

// Nivel del jugador
eq(B.validLevel('3.5'), 3.5, 'validLevel 3.5');
eq(B.validLevel('3,25'), 3.25, 'validLevel acepta coma');
eq(B.validLevel(''), null, 'validLevel vacío → null');
ok(B.validLevel('mal') === undefined, 'validLevel texto inválido');
ok(B.validLevel('9') === undefined, 'validLevel fuera de rango');
B.setLevel('S1', '4.25');
eq(B.getMember('S1').level, 4.25, 'setLevel guarda el nivel');
ok(B.setLevel('S1', 'mal').error, 'setLevel rechaza nivel inválido');
eq(B.levelRangeText(3.5), '2.5–4.5', 'rango visible = nivel ±1');
eq(B.levelRangeText(null), null, 'sin nivel no hay rango');

// Buscador de socios
B.upsertMember('S2', 'Socio Dos', '600222333');
B.upsertMember('S3', 'Ana Tres', '600333444');
ok(B.searchMembers('ana').some(s => s.member_no === 'S3'), 'busca por nombre');
ok(B.searchMembers('600222').some(s => s.member_no === 'S2'), 'busca por móvil');
ok(B.searchMembers('S3').some(s => s.member_no === 'S3'), 'busca por nº de socio');
eq(B.searchMembers('x'), [], 'menos de 2 caracteres no busca');

// Visibilidad de abiertos y bloqueos entre jugadores
B.upsertMember('B1', 'Bloqueador', '1'); B.upsertMember('B2', 'Bloqueado', '2');
B.setLevel('B1', 3.5);
ok(B.openVisibleTo('B1', 3.5, null) === true, 'público siempre ve el abierto');
ok(B.openVisibleTo('B1', 3.5, { member_no: 'X', level: 3 }) === true, 'nivel -0.5 lo ve');
ok(B.openVisibleTo('B1', 3.5, { member_no: 'X', level: 4.5 }) === true, 'límite +1 lo ve');
ok(B.openVisibleTo('B1', 3.5, { member_no: 'X', level: 4.75 }) === false, '+1.25 no lo ve');
ok(B.openVisibleTo('B1', 3.5, { member_no: 'X', level: null }) === true, 'visitante sin nivel ve todo');
ok(B.openVisibleTo('B1', null, { member_no: 'X', level: 6 }) === true, 'titular sin nivel visible para todos');
ok(B.addBlock('B1', 'B1').error, 'no vale auto-bloquearse');
ok(B.addBlock('B1', 'ZZZ').error, 'bloquear socio inexistente falla');
B.addBlock('B1', 'B2');
eq(B.getBlocks('B1').map(b => b.member_no), ['B2'], 'getBlocks lista bloqueados');
ok(B.openVisibleTo('B1', 3.5, { member_no: 'B2', level: 3.5 }) === false, 'bloqueado no ve aunque el nivel encaje');
B.removeBlock('B1', 'B2');
ok(B.openVisibleTo('B1', 3.5, { member_no: 'B2', level: 3.5 }) === true, 'tras quitar el bloqueo vuelve a ver');

// joinOpenMatch y syncOpenSpots
B.setCfg('days_ahead', '14');
const D9 = B.addDays(B.todayStr(), 9);
B.upsertMember('J1', 'Join Uno', '1'); B.upsertMember('J2', 'Join Dos', '2');
B.upsertMember('J3', 'Join Tres', '3'); B.upsertMember('J4', 'Join Cuatro', '4');
B.setLevel('J1', 3.5); B.setLevel('J2', 4); B.setLevel('J3', 6);
const jb = B.createBooking({ court_id: 2, court_name: 'P2', date: D9, start_min: 900, duration_min: 75, titular_member_no: 'J1', players: [], open_spots: 3 });
ok(!jb.error && B.getBooking(jb.id).open_spots === 3, 'abierto con 3 plazas');
ok(B.joinOpenMatch(jb.id, B.getMember('J2')).ok, 'J2 (nivel 4.0) se une');
eq(B.getBooking(jb.id).open_spots, 2, 'las plazas bajan a 2');
ok(B.joinOpenMatch(jb.id, B.getMember('J2')).error, 'no puede unirse dos veces');
ok(B.joinOpenMatch(jb.id, B.getMember('J3')).error, 'J3 (nivel 6.0) fuera de rango no puede');
ok(B.joinOpenMatch(jb.id, B.getMember('J1')).error, 'el titular no se une a su propio partido');
B.setPlayers(jb.id, 'J1', [{ name: 'Join Dos', member_no: 'J2' }, { name: 'Extra', member_no: '' }]);
B.syncOpenSpots(jb.id);
eq(B.getBooking(jb.id).open_spots, 1, 'syncOpenSpots: 4 − 3 jugadores = 1 plaza');
B.setPlayers(jb.id, 'J1', [{ name: 'Join Dos', member_no: 'J2' }, { name: 'A', member_no: '' }, { name: 'B', member_no: '' }]);
B.syncOpenSpots(jb.id);
eq(B.getBooking(jb.id).open_spots, 0, 'al completar los 4 se cierra solo');
ok(B.joinOpenMatch(jb.id, B.getMember('J4')).error, 'cerrado: nadie más puede unirse');
B.closeOpenMatch(jb.id);
eq(B.getBooking(jb.id).open_spots, 0, 'closeOpenMatch deja 0 plazas');

// Parrilla por franjas: la franja es la duración más larga del ajuste
const D = B.addDays(B.todayStr(), 1);
eq(B.slotInterval(), 75, 'franja = duración más larga (75)');
const slots = B.slotStarts(D);
ok(slots[0] === 480 && slots.every((s, i) => i === 0 || s - slots[i - 1] === 75), 'franjas cada 75 min desde la apertura');
const cell = B.slotCell(1, D, 480, null);
ok(cell.st === 'free' && cell.duration === 75, 'franja libre ofrece 75 sin preguntar');
// Si 75 no cabe, ofrece 60
B.createBooking({ court_id: 1, court_name: 'P1', date: D, start_min: 540, duration_min: 60, titular_member_no: 'S1', players: [] });
const cell2 = B.slotCell(1, D, 480, null);
ok(cell2.st === 'free' && cell2.duration === 60, 'si 75 no cabe se ofrecen 60');
ok(B.slotCell(1, D, 540, null).st === 'busy', 'franja con reserva sale ocupada');

console.log(`\n${pass} OK, ${fail} FALLOS`);
process.exit(fail ? 1 : 0);
