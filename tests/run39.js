// Escala de puntos de ranking por ronda (acortada 2026-11-09):
// 1º 200 · 2º 175 · 3º 155 · 4º 140 · 5º 130 en el grupo 1, -5 por grupo más abajo.
const L = require('../src/lib/league');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };
const eq = (a, b, n) => ok(a === b, n + ` (esperado ${b}, obtenido ${a})`);

const exp = {
  1: [200, 175, 155, 140, 130],
  2: [195, 170, 150, 135, 125],
  3: [190, 165, 145, 130, 120],
  4: [185, 160, 140, 125, 115],
  5: [180, 155, 135, 120, 110],
};
for (const g of [1, 2, 3, 4, 5]) {
  for (let p = 1; p <= 5; p++) eq(L.roundPoints(g, p), exp[g][p - 1], `grupo ${g} posición ${p}`);
}
// Diferencias entre posiciones, acortadas respecto a la escala anterior (58/46/39/3)
eq(L.roundPoints(1, 1) - L.roundPoints(1, 2), 25, '1º-2º en grupo 1 = 25 (antes 58)');
eq(L.roundPoints(1, 2) - L.roundPoints(1, 3), 20, '2º-3º en grupo 1 = 20 (antes 46)');
eq(L.roundPoints(1, 3) - L.roundPoints(1, 4), 15, '3º-4º en grupo 1 = 15 (antes 39)');
eq(L.roundPoints(1, 4) - L.roundPoints(1, 5), 10, '4º-5º en grupo 1 = 10 (antes 3)');
// Penalización por grupo: -5 uniforme para todas las posiciones
for (let p = 1; p <= 5; p++) {
  eq(L.roundPoints(1, p) - L.roundPoints(2, p), 5, `grupo 1 → 2, posición ${p}: -5`);
  eq(L.roundPoints(2, p) - L.roundPoints(5, p), 15, `grupo 2 → 5, posición ${p}: -15`);
}
// Extrapolación: 6º en adelante, -10 por posición; nunca negativo
eq(L.roundPoints(1, 6), 120, '6º grupo 1 = 120');
eq(L.roundPoints(1, 7), 110, '7º grupo 1 = 110');
eq(L.roundPoints(1, 0), 0, 'posición 0 = 0');
ok(L.roundPoints(20, 1) >= 0 && L.roundPoints(1, 30) === 0, 'nunca negativo');
ok(L.roundPoints(1, 1) === 200, 'el 1º del grupo 1 sigue en 200, como antes');

console.log(`\nrun39: ${pass} OK, ${fail} fallos`);
process.exit(fail ? 1 : 0);
