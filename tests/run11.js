// Pruebas: (1) parrilla tras reserva que termina fuera de cadencia (bookableStarts),
// (2) horarios por día de la semana, fechas especiales y cierres (dayHours).
const DATA = '/tmp/test-v9e/data11';
process.env.DATA_DIR = DATA;
require('fs').rmSync(DATA, { recursive: true, force: true });
const B = require('../src/lib/bookings');
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + ` (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`);

const dayStr = (off) => { const d = new Date(Date.now() + off * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TOM = dayStr(1);
B.setCfg('open_min', 540); B.setCfg('close_min', 1320); // 09:00–22:00 como en producción
B.upsertMember('301', 'Test Uno', '600000001');

// ---- 1. Reserva 17:30–18:30: las filas 19:00 y 20:15 deben seguir libres ----
B.bdb.prepare(`INSERT INTO bookings(court_id, court_name, date, start_min, end_min, titular_member_no, titular_name)
  VALUES(1,'Pista 1',?,?,?, '301','Test Uno')`).run(TOM, 1050, 1110);
ok(B.slotCell(1, TOM, 1065, null).st === 'busy', '17:45 sale ocupada');
ok(B.slotCell(1, TOM, 1140, null).st === 'free', '19:00 vuelve a salir libre');
ok(B.slotCell(1, TOM, 1215, null).st === 'free', '20:15 vuelve a salir libre');
ok(B.isBookable(1, TOM, 1140, 60), '19:00 60 min reservable');
ok(B.isBookable(1, TOM, 1110, 75), '18:30 75 min reservable');
ok(B.isBookable(1, TOM, 1185, 75), '19:45 75 min reservable');
ok(B.isBookable(1, TOM, 1170, 60), '19:30 60 min reservable');
const bs = B.bookableStarts(1110, 1320, TOM).map(v => v.start_min);
ok(bs.includes(1140) && bs.includes(1215), 'bookableStarts incluye 19:00 y 20:15');
ok(!B.validStarts(1110, 1320).some(v => v.start_min === 1140), 'validStarts (antiguo) no incluía 19:00: confirma la causa');
// Sin reservas raras, la parrilla clásica sigue igual
B.bdb.prepare(`DELETE FROM bookings`).run();
const bs2 = B.bookableStarts(540, 1320, TOM).map(v => v.start_min);
ok(bs2.includes(540) && bs2.includes(600) && bs2.includes(615), 'encadenados clásicos intactos (09:00, 10:00, 10:15)');
ok(B.slotCell(1, TOM, 540, null).st === 'free', '09:00 libre sin reservas');

// ---- 2. Horarios por día ----
// Próximo sábado y domingo (siempre en futuro)
const satOff = ((6 - new Date().getDay() + 7) % 7) || 7;
const SAT = dayStr(satOff), SUN = B.addDays(SAT, 1), MON = B.addDays(SAT, 2);
const CLOSED = dayStr(20); // fecha especial cerrada
B.setCfg('hours_json', JSON.stringify({
  weekday: { '6': [540, 840], '0': null },           // sábado 09:00–14:00, domingo cerrado
  dates: { [CLOSED]: null, [MON]: [540, 780] },      // fecha cerrada + lunes con horario especial
}));
eq(B.dayHours(SAT), { open_min: 540, close_min: 840 }, 'sábado: horario propio 09:00–14:00');
eq(B.dayHours(SUN), null, 'domingo: cerrado');
eq(B.dayHours(CLOSED), null, 'fecha especial: cerrada');
eq(B.dayHours(MON), { open_min: 540, close_min: 780 }, 'fecha especial pisa al día de la semana');
eq(B.dayHours(dayStr(21)), { open_min: 540, close_min: 1320 }, 'día normal: horario general');
eq(B.freeSegments(1, SUN), [], 'domingo cerrado: sin tramos libres');
eq(B.slotStarts(SUN), [], 'domingo cerrado: sin filas de parrilla');
eq(B.slotStarts(SAT).map(B.minToStr), ['09:00', '10:15', '11:30', '12:45'], 'sábado: filas 09:00–12:45');
ok(!B.isBookable(1, SUN, 600, 60), 'domingo cerrado: nada reservable');
ok(!B.isBookable(1, SAT, 900, 60), 'sábado 15:00 fuera de horario: no reservable');
ok(B.isBookable(1, SAT, 780, 60), 'sábado 13:00: reservable');
const rClosed = B.createBooking({ court_id: 1, court_name: 'P1', date: SUN, start_min: 600, duration_min: 60, titular_member_no: '301', players: [], byStaff: true });
eq(rClosed.error, 'Ese día el club está cerrado.', 'crear en domingo: error claro de día cerrado');
// validateHoursJson
ok(B.validateHoursJson('{"weekday":{"6":[540,840],"0":null},"dates":{"2026-12-25":null}}').value.dates['2026-12-25'] === null, 'validateHoursJson: JSON válido');
ok(B.validateHoursJson('no-json').error, 'validateHoursJson: JSON roto → error');
ok(B.validateHoursJson('{"weekday":{"7":[1,2]}}').error, 'validateHoursJson: día 7 → error');
ok(B.validateHoursJson('{"weekday":{"6":[840,540]}}').error, 'validateHoursJson: cierre antes de apertura → error');
ok(B.validateHoursJson('{"dates":{"25-12-2026":null}}').error, 'validateHoursJson: fecha mal formateada → error');
// Sin hours_json, todo como antes
B.setCfg('hours_json', '{}');
eq(B.dayHours(MON), { open_min: 540, close_min: 1320 }, 'sin overrides: horario general');

console.log(`\n${pass} OK, ${fail} FALLOS`);
process.exit(fail ? 1 : 0);
