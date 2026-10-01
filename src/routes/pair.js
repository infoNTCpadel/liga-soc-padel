// Zona de la pareja (acceso con código): partidos, resultados, validaciones,
// datos de contacto de rivales y solicitud de cambio de pareja.
const express = require('express');
const router = express.Router();
const { db, getSetting } = require('../db');
const L = require('../lib/league');

function requirePair(req, res, next) {
  const pair = req.session.pairId
    ? db.prepare("SELECT * FROM pairs WHERE id = ? AND status = 'active'").get(req.session.pairId)
    : null;
  if (!pair) return res.redirect('/acceso');
  req.pair = pair;
  res.locals.section = 'pair';
  res.locals.pair = pair;
  next();
}
router.use(requirePair);

// Pregunta del sistema "camiseta": preconfigurada, por jugador; solo visible si está activa.
function shirtQuestion() {
  const q = db.prepare("SELECT * FROM custom_questions WHERE sys_key = 'shirt' AND active = 1").get();
  return q ? { ...q, options: JSON.parse(q.options || '[]') } : null;
}

function pairPlayers(pairId) {
  return db.prepare(
    `SELECT p.*, pl.name, pl.email, pl.phone, pl.level, pl.shirt, pl.shirt_size, pl.paid
     FROM pairs p JOIN players pl ON pl.id = p.player1_id OR pl.id = p.player2_id
     WHERE p.id = ? ORDER BY pl.id`
  ).all(pairId);
}

// Propaga el ganador de un partido de playoff al siguiente cruce.
function advanceWinner(match) {
  if (!L.isPlayoffStage(match.stage)) return;
  const o = L.matchOutcome(match);
  if (!o || !L.countsForStandings({ ...match, validation: match.validation })) return;
  const next = L.BRACKET_NEXT[match.bracket_round];
  if (!next) return;
  const slot = Math.floor(match.bracket_slot / 2);
  const col = match.bracket_slot % 2 === 0 ? 'pair_a_id' : 'pair_b_id';
  const nm = db.prepare(
    'SELECT * FROM matches WHERE stage = ? AND category = ? AND bracket_round = ? AND bracket_slot = ?'
  ).get(match.stage, match.category, next, slot);
  if (nm && !nm[col]) db.prepare(`UPDATE matches SET ${col} = ? WHERE id = ?`).run(o.winnerId, nm.id);
}

// ---- Panel ----
router.get('/', (req, res) => {
  const pair = req.pair;
  const players = db.prepare(
    `SELECT pl.* FROM pairs p
     JOIN players pl ON pl.id IN (p.player1_id, p.player2_id)
     WHERE p.id = ?`
  ).all(pair.id);
  const byId = Object.fromEntries(players.map(p => [p.id, p]));
  const captain = byId[pair.captain_id];

  // Partidos de la pareja (fase de grupos)
  const matches = db.prepare(
    `SELECT m.*, g.group_no, g.round_no, c.name AS court_name
     FROM matches m LEFT JOIN groups g ON g.id = m.group_id LEFT JOIN courts c ON c.id = m.court_id
     WHERE m.stage = 'groups' AND (m.pair_a_id = ? OR m.pair_b_id = ?)
     ORDER BY g.round_no, g.group_no, m.id`
  ).all(pair.id, pair.id);

  // Partidos de playoff
  const poMatches = db.prepare(
    `SELECT m.*, c.name AS court_name FROM matches m LEFT JOIN courts c ON c.id = m.court_id
     WHERE stage LIKE 'po%' AND (pair_a_id = ? OR pair_b_id = ?)
     ORDER BY CASE bracket_round WHEN 'R32' THEN 0 WHEN 'R16' THEN 1 WHEN 'QF' THEN 2 WHEN 'SF' THEN 3 WHEN 'F' THEN 4 ELSE 9 END`
  ).all(pair.id, pair.id);

  // Resultados pendientes de validar (soy el rival)
  const toValidate = matches.concat(poMatches).filter(m =>
    m.validation === 'pending' && m.submitted_by && m.submitted_by !== pair.id
  );

  const rivalInfo = {};
  for (const m of matches.concat(poMatches)) {
    const rid = m.pair_a_id === pair.id ? m.pair_b_id : m.pair_a_id;
    if (rid && !rivalInfo[rid]) {
      const rp = db.prepare('SELECT * FROM pairs WHERE id = ?').get(rid);
      const cap = db.prepare('SELECT name, phone FROM players WHERE id = ?').get(rp.captain_id);
      rivalInfo[rid] = { name: L.pairName(db, rid), captain: cap };
    }
  }

  const changeReq = db.prepare(
    'SELECT * FROM pair_changes WHERE pair_id = ? ORDER BY id DESC LIMIT 1'
  ).get(pair.id);

  res.renderPage('pair/home', {
    pair, players, captain, matches, poMatches, toValidate, rivalInfo, changeReq,
    error: req.query.error || null,
    pairName: (id) => L.pairName(db, id),
    canChange: pair.changes_used < 1 && getSetting('playoffs_generated', '0') !== '1',
  });
});

// ---- Subir resultado ----
function parseScore(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 && n <= 30 ? n : NaN;
}

// Deduce quién ganó a partir del marcador en columnas "tú – rival".
// Devuelve { winnerIsMe: true|false } o { error: 'mensaje' }.
function deduceWinner(s1a, s1b, s2a, s2b, mode, s3a, s3b) {
  const vals = [s1a, s1b, s2a, s2b].concat(mode !== 'none' ? [s3a, s3b] : []);
  if (vals.some(v => v == null || Number.isNaN(v))) return { error: 'Revisa el marcador: faltan juegos o hay valores no válidos.' };
  if (s1a === s1b || s2a === s2b) return { error: 'Un set no puede terminar en empate.' };
  let setsA = 0, setsB = 0;
  for (const [a, b] of [[s1a, s1b], [s2a, s2b]]) {
    if (!L.isSetFinished(a, b)) return { error: 'Los dos primeros sets deben estar terminados (p. ej. 6-4, 7-5 o 7-6).' };
    if (a > b) setsA++; else setsB++;
  }
  let deciderWinner = null; // 'a' | 'b'
  if (mode !== 'none') {
    if (s3a === s3b) return { error: 'El desempate no puede terminar en empate.' };
    if (!((s3a >= 10 || s3b >= 10) && Math.abs(s3a - s3b) >= 2))
      return { error: 'El súper tie-break se juega a 10 puntos con diferencia de 2.' };
    deciderWinner = s3a > s3b ? 'a' : 'b';
  } else if (setsA === 1) {
    return { error: 'Con empate a un set hay que disputar el súper tie-break.' };
  }
  const totA = setsA + (deciderWinner === 'a' ? 1 : 0);
  const totB = setsB + (deciderWinner === 'b' ? 1 : 0);
  if (totA === totB || Math.max(totA, totB) < 2) return { error: 'El marcador no deja un ganador claro.' };
  return { winnerIsMe: totA > totB };
}

router.post('/resultado/:id', (req, res) => {
  const pair = req.pair;
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m || (m.pair_a_id !== pair.id && m.pair_b_id !== pair.id)) return res.status(403).send('Partido no válido.');
  if (m.winner_id || m.wo_winner_id) return res.redirect('/pareja'); // ya tiene resultado
  const fail = (msg) => res.redirect('/pareja?error=' + encodeURIComponent(msg));
  if (L.matchStageClosed(getSetting, m)) return fail('La fase está cerrada: no se pueden subir resultados.');

  const b = req.body;
  const wo = !!b.wo;

  if (wo) {
    db.prepare(`UPDATE matches SET winner_id = ?, wo_winner_id = ?, submitted_by = ?, submitted_at = datetime('now'),
                validation = 'pending', validation_deadline = datetime('now', '+1 day'), notes = ? WHERE id = ?`)
      .run(pair.id, pair.id, pair.id, (b.notes || '').trim(), m.id);
    const upd = db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id);
    advanceWinner(upd);
    return res.redirect('/pareja');
  }

  // El formulario usa columnas "tú – rival" (sufijo F); la BD usa pair_a/pair_b.
  const s1aF = parseScore(b.s1a), s1bF = parseScore(b.s1b);
  const s2aF = parseScore(b.s2a), s2bF = parseScore(b.s2b);
  const mode = b.set3mode === 'stb' ? 'stb' : 'none';
  const s3aF = mode !== 'none' ? parseScore(b.s3a) : null;
  const s3bF = mode !== 'none' ? parseScore(b.s3b) : null;

  // Cualquiera de las dos parejas puede subir el resultado, gane o pierda:
  // el ganador se deduce del marcador. En el formulario, "a" = quien sube
  // ("tú") y "b" = el rival. La otra pareja lo valida en 24 h.
  const dw = deduceWinner(s1aF, s1bF, s2aF, s2bF, mode, s3aF, s3bF);
  if (dw.error) return fail(dw.error);
  const winnerIsMe = dw.winnerIsMe;

  // Convertir "tú – rival" a columnas pair_a/pair_b para guardar en la BD.
  const meIsA = m.pair_a_id === pair.id;
  const otherId = meIsA ? m.pair_b_id : m.pair_a_id;
  const winnerId = winnerIsMe ? pair.id : otherId;
  if (!winnerId) return fail('El partido aún no tiene rival asignado.');
  const s1a = meIsA ? s1aF : s1bF, s1b = meIsA ? s1bF : s1aF;
  const s2a = meIsA ? s2aF : s2bF, s2b = meIsA ? s2bF : s2aF;
  const s3a = meIsA ? s3aF : s3bF, s3b = meIsA ? s3bF : s3aF;

  const q = mode === 'stb' ? [null, null, s3a, s3b] : [null, null, null, null];
  db.prepare(`UPDATE matches SET s1a=?, s1b=?, s2a=?, s2b=?, s3a=?, s3b=?, stb_a=?, stb_b=?,
              winner_id=?, submitted_by=?, submitted_at=datetime('now'),
              validation='pending', validation_deadline=datetime('now','+1 day'), notes=? WHERE id=?`)
    .run(s1a, s1b, s2a, s2b, q[0], q[1], q[2], q[3], winnerId, pair.id, (b.notes || '').trim(), m.id);
  const upd = db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id);
  advanceWinner(upd);
  res.redirect('/pareja');
});

// ---- Validar / disputar resultado del rival ----
router.post('/validar/:id', (req, res) => {
  const pair = req.pair;
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m || (m.pair_a_id !== pair.id && m.pair_b_id !== pair.id)) return res.status(403).send('No válido.');
  if (m.validation !== 'pending' || m.submitted_by === pair.id) return res.redirect('/pareja');
  if (L.matchStageClosed(getSetting, m)) return res.redirect('/pareja?error=' + encodeURIComponent('La fase está cerrada.'));
  db.prepare("UPDATE matches SET validation = 'validated' WHERE id = ?").run(m.id);
  res.redirect('/pareja');
});

router.post('/disputar/:id', (req, res) => {
  const pair = req.pair;
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m || (m.pair_a_id !== pair.id && m.pair_b_id !== pair.id)) return res.status(403).send('No válido.');
  if (m.validation !== 'pending' || m.submitted_by === pair.id) return res.redirect('/pareja');
  if (L.matchStageClosed(getSetting, m)) return res.redirect('/pareja?error=' + encodeURIComponent('La fase está cerrada.'));
  db.prepare("UPDATE matches SET validation = 'disputed' WHERE id = ?").run(m.id);
  res.redirect('/pareja');
});

// ---- Solicitud de cambio de pareja ----
router.get('/cambio', (req, res) => {
  const pair = req.pair;
  if (pair.changes_used >= 1 || getSetting('playoffs_generated', '0') === '1') return res.redirect('/pareja');
  const players = db.prepare('SELECT * FROM players WHERE id IN (?, ?)').all(pair.player1_id, pair.player2_id);
  res.renderPage('pair/cambio', { pair, players, error: null, brackets: L.PLAYTOMIC_BRACKETS });
});

router.post('/cambio', (req, res) => {
  const pair = req.pair;
  if (pair.changes_used >= 1 || getSetting('playoffs_generated', '0') === '1') return res.redirect('/pareja');
  const b = req.body;
  const oldId = parseInt(b.old_player_id, 10);
  const old = db.prepare('SELECT * FROM players WHERE id = ?').get(oldId);
  const err = (msg) => res.renderPage('pair/cambio', {
    pair, players: db.prepare('SELECT * FROM players WHERE id IN (?, ?)').all(pair.player1_id, pair.player2_id),
    error: msg, brackets: L.PLAYTOMIC_BRACKETS,
  });
  if (!old || ![pair.player1_id, pair.player2_id].includes(oldId)) return err('Jugador no válido.');
  const nl = parseFloat(b.new_level);
  if (!(nl >= 0 && nl <= 6)) return err('El nivel del nuevo jugador no es válido.');
  if (!(b.new_name || '').trim() || !(b.new_phone || '').trim()) return err('Faltan los datos del nuevo jugador.');
  const newMember = (b.new_member || '').trim();
  if (!newMember) return err('Falta el nº de socio del club del nuevo jugador (también el sustituto debe ser socio).');
  if (!L.validSpanishMobile(b.new_phone))
    return err('El teléfono del nuevo jugador no parece un móvil válido (9 dígitos, empieza por 6 o 7): revísalo por favor.');
  const ng = (b.new_gender || '').toUpperCase();
  if (!['M', 'F'].includes(ng)) return err('Indica el sexo del nuevo jugador.');
  // Mismo nivel: mismo tramo Playtomic que el jugador sustituido.
  if (L.bracketOf(nl).name !== L.bracketOf(old.level).name) {
    return err(`El nuevo jugador debe ser del mismo nivel (${L.bracketOf(old.level).name}).`);
  }
  // En mixta, la pareja debe seguir siendo un hombre y una mujer.
  if (pair.category === 'X') {
    const other = db.prepare('SELECT * FROM players WHERE id = ?')
      .get(pair.player1_id === oldId ? pair.player2_id : pair.player1_id);
    if (other && other.gender === ng) return err('En la categoría mixta la pareja debe estar formada por un hombre y una mujer.');
  }
  db.prepare(`INSERT INTO pair_changes(pair_id, old_player_id, new_name, new_email, new_phone, new_level, new_gender, new_member_no)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(pair.id, oldId, b.new_name.trim(), (b.new_email || '').trim(), b.new_phone.trim(), nl, ng, newMember);
  res.redirect('/pareja');
});

// ---- Mis datos: la pareja puede corregir sus datos de contacto ----
router.get('/datos', (req, res) => {
  const pair = req.pair;
  const players = db.prepare('SELECT * FROM players WHERE id IN (?, ?)').all(pair.player1_id, pair.player2_id)
    .sort((a, b) => (a.id === pair.player1_id ? -1 : 1));
  res.renderPage('pair/datos', { pair, players, error: null, ok: req.query.ok === '1', shirtQ: shirtQuestion() });
});

router.post('/datos', (req, res) => {
  const pair = req.pair;
  const b = req.body;
  const shirtQ = shirtQuestion();
  const players = db.prepare('SELECT * FROM players WHERE id IN (?, ?)').all(pair.player1_id, pair.player2_id);
  const err = (msg) => res.renderPage('pair/datos', {
    pair,
    players: players.sort((a, x) => (a.id === pair.player1_id ? -1 : 1)),
    error: msg, ok: false, shirtQ,
  });
  const availability = (b.availability || '').trim().slice(0, 120);
  const upd = [];
  for (const pl of players) {
    const n = pl.id === pair.player1_id ? 1 : 2;
    const name = (b[`p${n}_name`] || '').trim();
    const phone = (b[`p${n}_phone`] || '').trim();
    const email = (b[`p${n}_email`] || '').trim();
    const level = parseFloat(b[`p${n}_level`]);
    const gender = (b[`p${n}_gender`] || '').toUpperCase();
    const shirt = shirtQ ? (b[`p${n}_shirt`] ? 1 : 0) : pl.shirt;
    const shirtSize = shirtQ ? (b[`p${n}_shirt_size`] || '').trim() : pl.shirt_size;
    if (!name) return err('El nombre de cada jugador es obligatorio.');
    if (!phone) return err('El teléfono de cada jugador es obligatorio (lo usan los rivales para organizar los partidos).');
    if (!(level >= 0 && level <= 6)) return err('El nivel debe estar entre 0 y 6.');
    if (!['M', 'F'].includes(gender)) return err(`Indica el sexo de ${name}.`);
    if (shirt && !shirtSize) return err(`Falta la talla de camiseta de ${name}.`);
    upd.push({ id: pl.id, name, phone, email, level, gender, shirt, shirtSize });
  }
  if (pair.category === 'X' && upd[0].gender === upd[1].gender)
    return err('En la categoría mixta la pareja debe estar formada por un hombre y una mujer.');
  const capId = parseInt(b.captain, 10);
  if (!players.some((p) => p.id === capId)) return err('El capitán debe ser uno de los dos jugadores de la pareja.');
  const u = db.prepare('UPDATE players SET name = ?, phone = ?, email = ?, level = ?, gender = ?, shirt = ?, shirt_size = ? WHERE id = ?');
  for (const p of upd) u.run(p.name, p.phone, p.email, p.level, p.gender, p.shirt, p.shirtSize, p.id);
  const avg = Math.round(((upd[0].level + upd[1].level) / 2) * 100) / 100;
  db.prepare('UPDATE pairs SET level_avg = ?, availability = ?, captain_id = ? WHERE id = ?').run(avg, availability, capId, pair.id);
  res.redirect('/pareja/datos?ok=1');
});

module.exports = router;
module.exports.advanceWinner = advanceWinner;
module.exports.deduceWinner = deduceWinner;
