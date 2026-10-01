// Tamaños de playoff configurables por categoría (Ajustes → playoff_sizes_M/F/X).
// Solo lógica pura de league.js: no toca la BD.
const L = require('../src/lib/league');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + ` (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`);
const ids = (n) => Array.from({ length: n }, (_, i) => i + 1);

// ---- parsePlayoffSizes ----
eq(L.parsePlayoffSizes('').sizes, [], 'vacío → automático');
eq(L.parsePlayoffSizes('   ').sizes, [], 'espacios → automático');
eq(L.parsePlayoffSizes('16,8').sizes, [16, 8], '«16,8»');
eq(L.parsePlayoffSizes(' 16 , 8 ').sizes, [16, 8], 'con espacios');
eq(L.parsePlayoffSizes('16,,8').sizes, [16, 8], 'comas dobles se ignoran');
eq(L.parsePlayoffSizes('12').sizes, [12], 'un solo cuadro');
ok(L.parsePlayoffSizes('3').error, '3 → error (mínimo 4)');
ok(L.parsePlayoffSizes('16,2').error, '2 → error');
ok(L.parsePlayoffSizes('33').error, '33 → error (máximo 32)');
ok(L.parsePlayoffSizes('abc').error, 'texto → error');
ok(L.parsePlayoffSizes('16,abc').error, 'mezcla válida/inválida → error');
ok(L.parsePlayoffSizes('16.5').error, 'decimal → error');
eq(L.parsePlayoffSizes('4').sizes, [4], '4 válido (mínimo)');
eq(L.parsePlayoffSizes('32').sizes, [32], '32 válido (máximo)');

// ---- splitPlayoffCategories sin configurar: comportamiento anterior intacto ----
{
  const r = L.splitPlayoffCategories(ids(20));
  eq(r.cats.map(c => c.length), [16], 'auto 20 → [16]');
  eq(r.unused.length, 4, 'auto 20 → 4 sin playoff');
}
{
  const r = L.splitPlayoffCategories(ids(24));
  eq(r.cats.map(c => c.length), [16, 8], 'auto 24 → [16,8]');
  eq(r.unused.length, 0, 'auto 24 → nadie fuera');
}
{
  const r = L.splitPlayoffCategories(ids(40));
  eq(r.cats.map(c => c.length), [16, 16, 8], 'auto 40 → [16,16,8]');
}

// ---- splitPlayoffCategories configurado ----
{
  const r = L.splitPlayoffCategories(ids(20), [16, 8]);
  eq(r.cats.map(c => c.length), [16, 4], '20 con [16,8] → [16,4]');
  eq(r.unused.length, 0, '20 con [16,8] → nadie fuera');
  eq(r.cats[0][0], 1, 'el primer bloque coge lo alto del ranking');
  eq(r.cats[1][0], 17, 'el segundo bloque sigue en orden');
}
{
  const r = L.splitPlayoffCategories(ids(18), [16, 8]);
  eq(r.cats.map(c => c.length), [16], '18 con [16,8] → [16]');
  eq(r.unused.length, 2, '18 con [16,8] → 2 fuera (bloque de 2 < 4)');
}
{
  const r = L.splitPlayoffCategories(ids(20), [16]);
  eq(r.cats.map(c => c.length), [16], '20 con [16] → [16]');
  eq(r.unused.length, 4, '20 con [16] → 4 fuera (sobran del total)');
}
{
  const r = L.splitPlayoffCategories(ids(10), [8]);
  eq(r.cats.map(c => c.length), [8], '10 con [8] → [8]');
  eq(r.unused.length, 2, '10 con [8] → 2 fuera');
}
{
  const r = L.splitPlayoffCategories(ids(30), [16, 16]);
  eq(r.cats.map(c => c.length), [16, 14], '30 con [16,16] → [16,14]');
  eq(r.unused.length, 0, '30 con [16,16] → nadie fuera');
}
// corrección del caso anterior: 5 >= 4 sí juega
{
  const r = L.splitPlayoffCategories(ids(5), [8]);
  eq(r.cats.map(c => c.length), [5], '5 con [8] → [5] (≥4 juega)');
  eq(r.unused.length, 0, '5 con [8] → nadie fuera');
}
{
  const r = L.splitPlayoffCategories(ids(3), [8]);
  eq(r.cats.length, 0, '3 con [8] → ningún cuadro');
  eq(r.unused.length, 3, '3 con [8] → 3 fuera');
}
{
  const r = L.splitPlayoffCategories(ids(10), [16, 8]);
  eq(r.cats.map(c => c.length), [10], '10 con [16,8] → [10] (el 1º coge lo que hay)');
  eq(r.unused.length, 0, '10 con [16,8] → nadie fuera');
}

// ---- los bloques configurados generan cuadros válidos ----
for (const n of [4, 5, 6, 10, 12, 14, 16]) {
  const rounds = L.buildBracket(ids(n), [3, 4]);
  const first = rounds[0];
  ok(first.matches.length === Math.pow(2, Math.ceil(Math.log2(n)) - 1),
    `cuadro de ${n}: ${first.matches.length} partidos en 1ª ronda`);
  ok(rounds[rounds.length - 1].code === 'F', `cuadro de ${n}: termina en final`);
}

console.log(`\n${pass} OK, ${fail} fallos`);
process.exit(fail ? 1 : 0);
