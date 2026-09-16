// Lógica de la normativa de Master Padel League.
// Todo el cálculo deportivo (puntos, clasificaciones, desempates,
// ascensos/descensos, ranking y playoffs) vive aquí.

'use strict';

// ---------------------------------------------------------------------------
// Categorías de juego del club.
// ---------------------------------------------------------------------------
const CATEGORIES = [
  { code: 'M', name: 'Masculina' },
  { code: 'F', name: 'Femenina' },
  { code: 'X', name: 'Mixta' },
];
const CATEGORY_CODES = CATEGORIES.map(c => c.code);
function catName(code) {
  const c = CATEGORIES.find(c => c.code === code);
  return c ? c.name : code;
}
function validCategory(v) {
  return CATEGORY_CODES.includes(v) ? v : 'M';
}

// ---------------------------------------------------------------------------
// Puntos de ranking por ronda según grupo y posición.
// Tabla oficial: 1º=210-10n, 2º=149-7n, 3º=101-5n, 4º=60-3n (n = nº de grupo).
// La tabla oficial llega al Grupo 15; más allá se extrapola con la fórmula.
// ---------------------------------------------------------------------------
function roundPoints(groupNo, position) {
  const n = Math.max(1, groupNo);
  let pts;
  switch (position) {
    case 1: pts = 210 - 10 * n; break;
    case 2: pts = 149 - 7 * n; break;
    case 3: pts = 101 - 5 * n; break;
    case 4: pts = 60 - 3 * n; break;
    default:
      if (position <= 0) return 0;
      pts = (60 - 3 * n) - (position - 4) * 3; // extrapolación para grupos de != 4
  }
  return Math.max(0, pts);
}

// ---------------------------------------------------------------------------
// Resultado computable de un partido.
// Devuelve null si el partido no se ha jugado o no tiene resultado.
// sets: solo cuentan los sets terminados; los juegos cuentan siempre.
// El súper tie-break (o tercer set pactado) cuenta como 1 set + 1 juego.
// W.O.: 6-4 / 6-4 → 2-0 en sets, 12-8 en juegos.
// Puntos: victoria 3, derrota 1, no jugado 0.
// ---------------------------------------------------------------------------
function isSetFinished(a, b) {
  if (a == null || b == null) return false;
  if (a === 6 && b <= 4) return true;
  if (b === 6 && a <= 4) return true;
  if (a === 7 && (b === 5 || b === 6)) return true;
  if (b === 7 && (a === 5 || a === 6)) return true;
  return false;
}

function matchOutcome(m) {
  if (!m || m.unplayed) return null;
  const A = m.pair_a_id, B = m.pair_b_id;
  if (!A || !B) return null;

  // W.O.: se cuenta como 6-4 / 6-4, partido ganado / perdido.
  if (m.wo_winner_id) {
    const wIsA = m.wo_winner_id === A;
    return {
      winnerId: m.wo_winner_id, loserId: wIsA ? B : A,
      setsA: wIsA ? 2 : 0, setsB: wIsA ? 0 : 2,
      gamesA: wIsA ? 12 : 8, gamesB: wIsA ? 8 : 12,
      ptsA: wIsA ? 3 : 1, ptsB: wIsA ? 1 : 3,
      wo: true,
    };
  }
  if (!m.winner_id) return null;
  const wIsA = m.winner_id === A;

  let setsA = 0, setsB = 0, gamesA = 0, gamesB = 0;
  for (const [a, b] of [[m.s1a, m.s1b], [m.s2a, m.s2b]]) {
    if (a == null || b == null) continue;
    gamesA += a; gamesB += b;
    if (isSetFinished(a, b)) { if (a > b) setsA++; else setsB++; }
  }
  // Tercer set pactado: cuenta como si fuera un súper tie-break.
  if (m.s3a != null && m.s3b != null) {
    if (m.s3a > m.s3b) { setsA++; gamesA += 1; }
    else if (m.s3b > m.s3a) { setsB++; gamesB += 1; }
  } else if (m.stb_a != null && m.stb_b != null) {
    if (m.stb_a > m.stb_b) { setsA++; gamesA += 1; }
    else if (m.stb_b > m.stb_a) { setsB++; gamesB += 1; }
  }

  return {
    winnerId: m.winner_id, loserId: wIsA ? B : A,
    setsA, setsB, gamesA, gamesB,
    ptsA: wIsA ? 3 : 1, ptsB: wIsA ? 1 : 3,
    wo: false,
  };
}

// ¿El resultado cuenta para la clasificación? (disputados y sin resultado, no)
function countsForStandings(m) {
  if (!m || m.unplayed) return false;
  if (m.wo_winner_id) return true;
  if (!m.winner_id) return false;
  return m.validation !== 'disputed';
}

// ---------------------------------------------------------------------------
// Clasificación de un grupo.
// Orden: puntos; desempates según normativa:
//  - Doble empate: 1) enfrentamiento directo, 2) dif. sets, 3) dif. juegos,
//    4) juegos a favor, 5) sorteo.
//  - Triple empate (o más): 1) dif. sets, 2) dif. juegos, 3) juegos a favor,
//    4) sorteo.
// El sorteo en la vista en directo es determinista; al cerrar la ronda el
// admin puede ajustar posiciones manualmente si hace sorteo físico.
// ---------------------------------------------------------------------------
function hashInt(x) {
  let h = 2166136261;
  const s = String(x);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function headToHead(idA, idB, matches) {
  for (const m of matches) {
    const ps = [m.pair_a_id, m.pair_b_id];
    if (!ps.includes(idA) || !ps.includes(idB)) continue;
    if (!countsForStandings(m)) continue;
    const w = m.winner_id || m.wo_winner_id;
    if (w === idA || w === idB) return w;
  }
  return null;
}

// -1 si a va antes que b
function compareCriteria(a, b) {
  let d = (b.setsW - b.setsL) - (a.setsW - a.setsL); if (d !== 0) return d > 0 ? 1 : -1;
  d = (b.gamesW - b.gamesL) - (a.gamesW - a.gamesL); if (d !== 0) return d > 0 ? 1 : -1;
  d = b.gamesW - a.gamesW; if (d !== 0) return d > 0 ? 1 : -1;
  d = hashInt(a.pairId) - hashInt(b.pairId); if (d !== 0) return d > 0 ? 1 : -1;
  return a.pairId - b.pairId;
}

function criterionDecided(sorted) {
  // Describe qué criterio desempató (para mostrarlo en la clasificación).
  const first = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const o = sorted[i];
    if (o.setsW - o.setsL !== first.setsW - first.setsL) return 'Diferencia de sets';
    if (o.gamesW - o.gamesL !== first.gamesW - first.gamesL) return 'Diferencia de juegos';
    if (o.gamesW !== first.gamesW) return 'Juegos a favor';
  }
  return 'Sorteo';
}

function breakTie(block, matches) {
  const ordered = [...block].sort(compareCriteria);
  if (block.length === 2) {
    const [x, y] = block;
    const h2h = headToHead(x.pairId, y.pairId, matches);
    if (h2h === x.pairId) return [x, y].map((r, i) => ({ ...r, tieNote: i === 0 ? 'Enfrentamiento directo' : null }));
    if (h2h === y.pairId) return [y, x].map((r, i) => ({ ...r, tieNote: i === 0 ? 'Enfrentamiento directo' : null }));
  }
  const note = criterionDecided(ordered);
  return ordered.map((r, i) => ({ ...r, tieNote: i === 0 && block.length > 1 ? note : null }));
}

function computeStandings(pairIds, matches) {
  const st = {};
  for (const id of pairIds) {
    st[id] = { pairId: id, pj: 0, pg: 0, pp: 0, pts: 0, setsW: 0, setsL: 0, gamesW: 0, gamesL: 0, tieNote: null };
  }
  for (const m of matches) {
    if (!countsForStandings(m)) continue;
    const o = matchOutcome(m);
    if (!o) continue;
    const a = st[m.pair_a_id], b = st[m.pair_b_id];
    if (!a || !b) continue;
    a.pj++; b.pj++;
    a.pts += o.ptsA; b.pts += o.ptsB;
    if (o.winnerId === m.pair_a_id) { a.pg++; b.pp++; } else { b.pg++; a.pp++; }
    a.setsW += o.setsA; a.setsL += o.setsB;
    b.setsW += o.setsB; b.setsL += o.setsA;
    a.gamesW += o.gamesA; a.gamesL += o.gamesB;
    b.gamesW += o.gamesB; b.gamesL += o.gamesA;
  }
  const arr = Object.values(st).sort((x, y) => y.pts - x.pts);
  const out = [];
  let i = 0;
  while (i < arr.length) {
    let j = i + 1;
    while (j < arr.length && arr[j].pts === arr[i].pts) j++;
    const block = arr.slice(i, j);
    out.push(...(block.length === 1 ? [{ ...block[0], tieNote: null }] : breakTie(block, matches)));
    i = j;
  }
  out.forEach((r, idx) => { r.position = idx + 1; });
  return out;
}

// ---------------------------------------------------------------------------
// Ascensos y descensos al final de cada ronda.
// General (grupos de 4): 1º sube 2, 2º sube 1, 3º baja 1, 4º baja 2.
// Excepciones: Grupo 1, Grupo 2, penúltimo grupo y último grupo.
// Devuelve el delta de grupos (+2, +1, 0, -1, -2).
// ---------------------------------------------------------------------------
function movementDelta(groupNo, totalGroups, position, groupSize) {
  if (totalGroups <= 1) return 0;
  const isLast = position === groupSize;
  const isSecondLast = position === groupSize - 1;

  if (groupNo === 1) {                       // Grupo 1: los 2 primeros se mantienen
    if (position <= 2) return 0;
    if (isSecondLast) return -1;
    if (isLast) return -2;
    return 0;
  }
  if (groupNo === 2 && totalGroups > 2) {     // Grupo 2
    if (position === 1) return 1;
    if (position === 2) return 0;
    if (isSecondLast) return -1;
    if (isLast) return -2;
    return 0;
  }
  if (groupNo === totalGroups - 1 && totalGroups > 2) { // Penúltimo grupo
    if (position === 1) return 2;
    if (position === 2) return 1;
    if (isSecondLast) return 0;
    if (isLast) return -1;
    return 0;
  }
  if (groupNo === totalGroups) {              // Último grupo
    if (position === 1) return 2;
    if (position === 2) return 1;
    return 0;
  }
  // Grupos intermedios
  if (position === 1) return 2;
  if (position === 2) return 1;
  if (isSecondLast) return -1;
  if (isLast) return -2;
  return 0;
}

function targetGroup(groupNo, totalGroups, position, groupSize) {
  // Subir = ir hacia el Grupo 1 (número menor); bajar = número mayor.
  const t = groupNo - movementDelta(groupNo, totalGroups, position, groupSize);
  return Math.min(totalGroups, Math.max(1, t));
}

// ---------------------------------------------------------------------------
// Generación de grupos de la Ronda 1: por nivel medio (mejor nivel → Grupo 1).
// Grupos de 4; si el total no es múltiplo de 4 se reparten lo más parejo posible.
// ---------------------------------------------------------------------------
function chunkIntoGroups(sortedIds) {
  const n = sortedIds.length;
  if (n === 0) return [];
  const numGroups = Math.max(1, Math.round(n / 4));
  const base = Math.floor(n / numGroups);
  const rem = n % numGroups;
  const groups = [];
  let idx = 0;
  for (let g = 0; g < numGroups; g++) {
    const size = base + (g < rem ? 1 : 0);
    groups.push(sortedIds.slice(idx, idx + size));
    idx += size;
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Round-robin (todos contra todos) dentro de un grupo. Cada pareja juega
// groupSize-1 partidos (3 en grupos de 4).
// ---------------------------------------------------------------------------
function roundRobin(ids) {
  const list = [...ids];
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const arr = [...list];
  const fixtures = [];
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a != null && b != null) fixtures.push({ a, b, matchday: r + 1 });
    }
    arr.splice(1, 0, arr.pop());
  }
  return fixtures;
}

// ---------------------------------------------------------------------------
// Cuadros de playoff (eliminatoria simple).
// Cabezas de serie clásicas: 1 vs último, etc. Con byes si no es potencia de 2.
// ---------------------------------------------------------------------------
function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function seedOrder(size) {
  if (size <= 1) return [1];
  if (size === 2) return [1, 2];
  const prev = seedOrder(size / 2);
  const out = [];
  for (const s of prev) { out.push(s); out.push(size + 1 - s); }
  return out;
}

const BRACKET_NAMES = { 32: 'Dieciseisavos', 16: 'Octavos', 8: 'Cuartos', 4: 'Semis', 2: 'Final' };
const BRACKET_NAME_BY_CODE = { R32: 'Dieciseisavos', R16: 'Octavos', QF: 'Cuartos', SF: 'Semis', F: 'Final' };
const BRACKET_NEXT = { R32: 'R16', R16: 'QF', QF: 'SF', SF: 'F', F: null };
const BRACKET_CODE = { 32: 'R32', 16: 'R16', 8: 'QF', 4: 'SF', 2: 'F' };

function buildBracket(rankedIds) {
  const n = rankedIds.length;
  const size = nextPowerOfTwo(Math.max(n, 2));
  const order = seedOrder(size);
  const seeds = order.map(s => (s <= n ? rankedIds[s - 1] : null)); // null = bye
  const rounds = [];
  let matchCount = size / 2;
  let code = BRACKET_CODE[size];
  const first = [];
  for (let i = 0; i < size; i += 2) {
    first.push({ slot: i / 2, a: seeds[i], b: seeds[i + 1] });
  }
  rounds.push({ code, name: BRACKET_NAMES[size], matches: first });
  let prevSlots = matchCount;
  let prevSize = size;
  while (prevSlots > 1) {
    prevSize = prevSize / 2;
    prevSlots = prevSlots / 2;
    const ms = [];
    for (let i = 0; i < prevSlots; i++) ms.push({ slot: i, a: null, b: null });
    rounds.push({ code: BRACKET_CODE[prevSize], name: BRACKET_NAMES[prevSize], matches: ms });
  }
  return rounds;
}

// División del ranking en dos mitades para los playoffs de 1ª y 2ª.
// Máximo 32 parejas por cuadro (normativa).
function splitPlayoffs(rankedIds) {
  const half = Math.ceil(rankedIds.length / 2);
  return {
    po1: rankedIds.slice(0, half).slice(0, 32),
    po2: rankedIds.slice(half).slice(0, 32),
  };
}

// ---------------------------------------------------------------------------
// Validación automática: resultados pendientes de más de 24h se validan solos.
// ---------------------------------------------------------------------------
function autoValidateExpired(db) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE matches SET validation = 'auto'
     WHERE validation = 'pending' AND validation_deadline IS NOT NULL AND validation_deadline <= ?`
  ).run(now);
}

// ---------------------------------------------------------------------------
// Consultas de conveniencia sobre la BD.
// ---------------------------------------------------------------------------
function getGroups(db, category, roundNo) {
  return db.prepare(
    'SELECT * FROM groups WHERE category = ? AND round_no = ? ORDER BY group_no'
  ).all(category, roundNo);
}

function getGroupMembers(db, groupId) {
  return db.prepare(
    `SELECT gm.*, p.code, p.category, p.status, p.level_avg,
            p1.name AS name1, p2.name AS name2
     FROM group_members gm
     JOIN pairs p ON p.id = gm.pair_id
     JOIN players p1 ON p1.id = p.player1_id
     JOIN players p2 ON p2.id = p.player2_id
     WHERE gm.group_id = ?`
  ).all(groupId);
}

function getGroupMatches(db, groupId) {
  return db.prepare('SELECT * FROM matches WHERE group_id = ? ORDER BY id').all(groupId);
}

function pairName(db, pairId) {
  const r = db.prepare(
    `SELECT p1.name AS n1, p2.name AS n2 FROM pairs p
     JOIN players p1 ON p1.id = p.player1_id
     JOIN players p2 ON p2.id = p.player2_id
     WHERE p.id = ?`
  ).get(pairId);
  return r ? `${r.n1} / ${r.n2}` : '—';
}

function getRanking(db, category) {
  // Suma de puntos de las rondas cerradas, por categoría.
  return db.prepare(
    `SELECT p.id AS pair_id, p.code, p1.name AS name1, p2.name AS name2,
            COALESCE(SUM(rr.round_points), 0) AS total,
            COUNT(rr.id) AS rounds_played
     FROM pairs p
     JOIN players p1 ON p1.id = p.player1_id
     JOIN players p2 ON p2.id = p.player2_id
     LEFT JOIN round_results rr ON rr.pair_id = p.id AND rr.category = ?
     WHERE p.category = ? AND p.status = 'active'
     GROUP BY p.id
     ORDER BY total DESC, p.id ASC`
  ).all(category, category);
}

const PLAYTOMIC_BRACKETS = [
  { name: 'Iniciación', min: 0, max: 0.999 },
  { name: 'Principiante', min: 1, max: 1.499 },
  { name: 'Intermedio de Iniciación', min: 1.5, max: 2.4 },
  { name: 'Intermedio', min: 2.5, max: 3.4 },
  { name: 'Intermedio Alto', min: 3.5, max: 4.4 },
  { name: 'Intermedio Avanzado', min: 4.5, max: 5.4 },
  { name: 'Competición', min: 5.4, max: 5.6 },
];
function bracketOf(level) {
  return PLAYTOMIC_BRACKETS.find(b => level >= b.min && level <= b.max) || PLAYTOMIC_BRACKETS[3];
}

module.exports = {
  roundPoints, matchOutcome, countsForStandings, isSetFinished,
  computeStandings, movementDelta, targetGroup,
  chunkIntoGroups, roundRobin,
  buildBracket, splitPlayoffs, BRACKET_NEXT, BRACKET_NAMES, BRACKET_NAME_BY_CODE,
  autoValidateExpired,
  getGroups, getGroupMembers, getGroupMatches, pairName, getRanking,
  PLAYTOMIC_BRACKETS, bracketOf,
  CATEGORIES, CATEGORY_CODES, catName, validCategory,
};
