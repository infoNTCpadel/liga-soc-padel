// Grupos con mínimo 4 parejas: si el reparto dejara un grupo de 3,
// se reduce el nº de grupos y se redistribuye (algunos de 5 o 6).
// Los grupos de 4 van primero (grupo 1 = más nivel); los de 5, al final.
const L = require('../src/lib/league');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + ` (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`);
const ids = (n) => Array.from({ length: n }, (_, i) => i + 1);
const sizes = (n) => L.chunkIntoGroups(ids(n)).map(g => g.length);

eq(sizes(0), [], '0 → sin grupos');
eq(sizes(4), [4], '4 → [4]');
eq(sizes(5), [5], '5 → [5]');
eq(sizes(6), [6], '6 → [6] (no se puede partir en ≥4)');
eq(sizes(7), [7], '7 → [7] (no se puede partir en ≥4)');
eq(sizes(8), [4, 4], '8 → [4,4]');
eq(sizes(9), [4, 5], '9 → [4,5]: los de 5 al final');
eq(sizes(10), [5, 5], '10 → [5,5] (antes era 4,3,3)');
eq(sizes(11), [5, 6], '11 → [5,6] (antes era 4,4,3)');
eq(sizes(12), [4, 4, 4], '12 → [4,4,4]');
eq(sizes(13), [4, 4, 5], '13 → [4,4,5]');
eq(sizes(14), [4, 5, 5], '14 → [4,5,5] (antes era 4,4,3,3)');
eq(sizes(15), [5, 5, 5], '15 → [5,5,5] (antes era 4,4,4,3)');
eq(sizes(16), [4, 4, 4, 4], '16 → [4,4,4,4]');
eq(sizes(17), [4, 4, 4, 5], '17 → [4,4,4,5]');
eq(sizes(18), [4, 4, 5, 5], '18 → [4,4,5,5]');
eq(sizes(19), [4, 5, 5, 5], '19 → [4,5,5,5] (antes era 4,4,4,4,3)');
eq(sizes(20), [4, 4, 4, 4, 4], '20 → cinco de 4');
eq(sizes(22), [4, 4, 4, 5, 5], '22 → [4,4,4,5,5]');
eq(sizes(23), [4, 4, 5, 5, 5], '23 → [4,4,5,5,5] (ejemplo de Mathius)');
eq(sizes(27), [4, 4, 4, 5, 5, 5], '27 → [4,4,4,5,5,5]');

// Propiedades generales: orden conservado, tamaños no decrecientes,
// ningún grupo de menos de 4 (si hay parejas suficientes)
for (let n = 1; n <= 60; n++) {
  const gs = L.chunkIntoGroups(ids(n));
  const flat = gs.flat();
  ok(JSON.stringify(flat) === JSON.stringify(ids(n)), `n=${n}: se conservan todas las parejas en orden`);
  const ss = gs.map(g => g.length);
  ok(ss.every((s, i) => i === 0 || s >= ss[i - 1]), `n=${n}: tamaños no decrecientes (${ss})`);
  if (n >= 4) ok(ss.every(s => s >= 4), `n=${n}: ningún grupo de menos de 4 (${ss})`);
}

// Los grupos impares generan calendario round-robin válido (con descansos)
for (const n of [5, 6, 7]) {
  const fx = L.roundRobin(ids(n));
  const jugados = {};
  fx.forEach(f => { jugados[f.a] = (jugados[f.a] || 0) + 1; jugados[f.b] = (jugados[f.b] || 0) + 1; });
  ok(Object.keys(jugados).length === n && Object.values(jugados).every(c => c === n - 1),
    `round-robin de ${n}: cada pareja juega ${n - 1} partidos`);
}

console.log(`\n${pass} OK, ${fail} fallos`);
process.exit(fail ? 1 : 0);
