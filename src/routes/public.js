// Rutas públicas: portada, normativa, inscripción, consulta de la liga.
const express = require('express');
const router = express.Router();
const { db, getSetting } = require('../db');
const L = require('../lib/league');

function phases() {
  const g = (k, f = '') => getSetting(k, f);
  const list = [
    { key: 'insc', label: g('phase_insc_label'), ini: g('phase_insc_ini'), fin: g('phase_insc_fin') },
    { key: 'r1', label: g('phase_r1_label'), ini: g('phase_r1_ini'), fin: g('phase_r1_fin') },
    { key: 'r2', label: g('phase_r2_label'), ini: g('phase_r2_ini'), fin: g('phase_r2_fin') },
    { key: 'r3', label: g('phase_r3_label'), ini: g('phase_r3_ini'), fin: g('phase_r3_fin') },
    { key: 'po', label: g('phase_po_label'), ini: g('phase_po_ini'), fin: g('phase_po_fin') },
  ];
  const today = new Date().toISOString().slice(0, 10);
  for (const p of list) {
    p.current = p.ini && p.fin && today >= p.ini && today <= p.fin;
    p.past = p.fin && today > p.fin;
  }
  return list;
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ---- Portada ----
router.get('/', (req, res) => {
  const counts = {
    pairs: db.prepare("SELECT COUNT(*) c FROM pairs WHERE status = 'active'").get().c,
    pending: db.prepare("SELECT COUNT(*) c FROM pairs WHERE status = 'pending'").get().c,
  };
  res.renderPage('public/home', { phases: phases(), fmtDate, counts,
    registrationClosed: getSetting('registration_closed', '0') === '1' });
});

// ---- Normativa (resumen fiel al documento oficial) ----
router.get('/normativa', (req, res) => {
  res.renderPage('public/normativa', { brackets: L.PLAYTOMIC_BRACKETS,
    price1: eur(getSetting('inscription_price', '15')),
    price2: eur(getSetting('inscription_price_2', '25')),
    priceShirt: eur(getSetting('shirt_price', '14.95')) });
});

// ---- Inscripción ----
function activeQuestions() {
  // Preguntas genéricas (la camiseta del sistema se gestiona aparte, por jugador)
  return db.prepare("SELECT * FROM custom_questions WHERE active = 1 AND sys_key = '' ORDER BY position, id").all()
    .map(q => ({ ...q, options: JSON.parse(q.options || '[]') }));
}
// Pregunta del sistema "camiseta": preconfigurada, por jugador; solo visible si está activa.
function shirtQuestion() {
  const q = db.prepare("SELECT * FROM custom_questions WHERE sys_key = 'shirt' AND active = 1").get();
  return q ? { ...q, options: JSON.parse(q.options || '[]') } : null;
}

function eur(v) { return Number(v || 0).toFixed(2).replace('.', ','); }
function formParams(b) {
  return { questions: activeQuestions(), form: b || {},
    closed: getSetting('registration_closed', '0') === '1',
    price1: eur(getSetting('inscription_price', '15')),
    price2: eur(getSetting('inscription_price_2', '25')),
    priceShirt: eur(getSetting('shirt_price', '14.95')), shirtQ: shirtQuestion() };
}
router.get('/inscripcion', (req, res) => {
  res.renderPage('public/inscripcion', { ...formParams({}), error: null });
});

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (db.prepare('SELECT 1 FROM pairs WHERE code = ?').get(code));
  return code;
}

router.post('/inscripcion', (req, res) => {
  const b = req.body;
  const error = (msg) => res.renderPage('public/inscripcion', { ...formParams(b), error: msg });

  if (getSetting('registration_closed', '0') === '1') return error('La inscripción está cerrada.');

  // Modalidades elegidas: 1 o 2 (orden M, F, X del formulario)
  const rawMods = Array.isArray(b.modality) ? b.modality : (b.modality ? [b.modality] : []);
  const mods = [...new Set(rawMods.filter(m => L.CATEGORY_CODES.includes(m)))];
  if (!mods.length) return error('Elige al menos una modalidad.');
  if (mods.length > 2) return error('Puedes inscribirte como máximo en dos modalidades.');

  const shirtActive = !!shirtQuestion();
  const shirtPrice = parseFloat(String(getSetting('shirt_price', '14.95')).replace(',', '.')) || 0;
  const blocks = [];
  for (let i = 0; i < mods.length; i++) {
    const pfx = i === 0 ? 'a' : 'b';
    const category = mods[i];
    const mk = (n) => ({
      name: (b[`${pfx}_p${n}_name`] || '').trim(),
      email: (b[`${pfx}_p${n}_email`] || '').trim(),
      phone: (b[`${pfx}_p${n}_phone`] || '').trim(),
      level: parseFloat(b[`${pfx}_p${n}_level`]),
      gender: (b[`${pfx}_p${n}_gender`] || '').toUpperCase(),
      shirt: shirtActive && b[`${pfx}_p${n}_shirt`] ? 1 : 0,
      shirt_size: shirtActive ? (b[`${pfx}_p${n}_shirt_size`] || '').trim() : '',
    });
    const p1 = mk(1), p2 = mk(2);
    const tag = `Pareja ${i + 1}`;
    if (!p1.name || !p2.name) return error(`${tag}: faltan los nombres de los dos jugadores.`);
    if (!p1.phone || !p2.phone) return error(`${tag}: faltan los teléfonos de contacto (los necesitaréis para organizar los partidos).`);
    if (L.normPhone(p1.phone) === L.normPhone(p2.phone)) return error(`${tag}: los dos jugadores no pueden tener el mismo teléfono.`);
    if (p1.name.toLowerCase() === p2.name.toLowerCase()) return error(`${tag}: los dos jugadores no pueden tener el mismo nombre.`);
    for (const [p, n] of [[p1, 1], [p2, 2]]) {
      if (!(p.level >= 0 && p.level <= 6)) return error(`${tag}: el nivel del jugador ${n} no es válido (0 – 6).`);
      if (!['M', 'F'].includes(p.gender)) return error(`${tag}: indica el sexo del jugador ${n}.`);
      if (p.shirt && !p.shirt_size) return error(`${tag}: falta la talla de camiseta del jugador ${n}.`);
      // Solo una camiseta por jugador y temporada
      if (p.shirt && L.personHasShirt(db, p.phone)) { p.shirt = 0; p.shirt_size = ''; p.shirtDup = true; }
    }
    if (category === 'X' && p1.gender === p2.gender)
      return error(`${tag}: en la categoría mixta la pareja debe estar formada por un hombre y una mujer.`);
    blocks.push({ category, p1, p2, captain: b[`${pfx}_captain`] === '2' ? 2 : 1 });
  }

  // Ni dos camisetas para la misma persona en este envío...
  const shirtSeen = {};
  for (const bl of blocks) for (const p of [bl.p1, bl.p2]) {
    const ph = L.normPhone(p.phone);
    if (p.shirt && shirtSeen[ph]) return error('Solo se puede pedir una camiseta por jugador y temporada.');
    if (p.shirt) shirtSeen[ph] = true;
  }

  // ...ni repetir modalidad ni pasar de dos modalidades por persona
  const catsOf = (phone) => {
    const ph = L.normPhone(phone);
    const s = new Set(L.personCategories(db, phone));
    for (const bl of blocks)
      if ([bl.p1, bl.p2].some(p => L.normPhone(p.phone) === ph)) s.add(bl.category);
    return s;
  };
  for (const bl of blocks) for (const p of [bl.p1, bl.p2]) {
    if (L.personCategories(db, p.phone).includes(bl.category))
      return error(`${p.name} ya está inscrito en ${L.catName(bl.category).toLowerCase()}: no se puede inscribir dos veces en la misma modalidad.`);
    if (catsOf(p.phone).size > 2)
      return error(`${p.name} ya está inscrito en dos modalidades: no puede apuntarse a una tercera.`);
  }

  // Preguntas adicionales (se guardan para cada pareja creada)
  const questions = activeQuestions();
  for (const q of questions) {
    const ans = (b[`q_${q.id}`] || '').trim();
    if (q.required && !ans) return error(`Falta responder: "${q.label}".`);
  }

  const created = [];
  for (const bl of blocks) {
    const code = genCode();
    const ins = db.prepare(
      'INSERT INTO players(name, email, phone, level, gender, shirt, shirt_size) VALUES(?, ?, ?, ?, ?, ?, ?)'
    );
    const r1 = ins.run(bl.p1.name, bl.p1.email, bl.p1.phone, bl.p1.level, bl.p1.gender, bl.p1.shirt, bl.p1.shirt_size);
    const r2 = ins.run(bl.p2.name, bl.p2.email, bl.p2.phone, bl.p2.level, bl.p2.gender, bl.p2.shirt, bl.p2.shirt_size);
    const levelAvg = Math.round(((bl.p1.level + bl.p2.level) / 2) * 100) / 100;
    const rp = db.prepare(
      `INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, level_avg, status)
       VALUES(?, ?, ?, ?, ?, ?, 'pending')`
    ).run(code, bl.category, Number(r1.lastInsertRowid), Number(r2.lastInsertRowid),
      bl.captain === 2 ? Number(r2.lastInsertRowid) : Number(r1.lastInsertRowid), levelAvg);
    const pairId = Number(rp.lastInsertRowid);
    const ansIns = db.prepare('INSERT INTO registration_answers(pair_id, question_id, answer) VALUES(?, ?, ?)');
    for (const q of questions) {
      const ans = (b[`q_${q.id}`] || '').trim();
      if (ans) ansIns.run(pairId, q.id, ans);
    }
    created.push({ code, category: bl.category, p1: bl.p1, p2: bl.p2, levelAvg });
  }

  // Resumen de pago por persona (el precio depende de sus modalidades totales)
  const persons = [];
  const seenP = new Set();
  const personBlock = (ph) => {
    for (const bl of created) for (const p of [bl.p1, bl.p2])
      if (L.normPhone(p.phone) === ph) return p;
    return null;
  };
  for (const bl of created) for (const p of [bl.p1, bl.p2]) {
    const ph = L.normPhone(p.phone);
    if (seenP.has(ph)) continue;
    seenP.add(ph);
    const cats = L.personCategories(db, p.phone).map(c => L.catName(c).toLowerCase());
    const price = L.priceForModalities(getSetting, cats.length);
    const bp = personBlock(ph);
    const shirt = bp && bp.shirt ? shirtPrice : 0;
    persons.push({ name: p.name, cats, price: eur(price), shirt: shirt ? eur(shirt) : null,
      shirtDup: !!(bp && bp.shirtDup), total: eur(price + shirt) });
  }
  const grandTotal = eur(persons.reduce((s, ps) => s + parseFloat(ps.total.replace(',', '.')), 0));

  res.renderPage('public/inscripcion-ok', { pairs: created, persons, grandTotal });
});

// ---- Consulta de la liga: grupos y clasificaciones ----
router.get('/liga', (req, res) => {
  res.redirect('/liga/M/1');
});

router.get('/liga/:category/:round', (req, res) => {
  const category = L.validCategory(req.params.category);
  const round = Math.min(3, Math.max(1, parseInt(req.params.round) || 1));
  const groups = L.getGroups(db, category, round);
  const showMov = round < 3 && groups.length > 1;
  const data = groups.map(g => {
    const members = L.getGroupMembers(db, g.id);
    const matches = L.getGroupMatches(db, g.id);
    const standings = L.computeStandings(members.map(m => m.pair_id), matches);
    const byId = Object.fromEntries(members.map(m => [m.pair_id, m]));
    return {
      ...g,
      standings: standings.map(s => {
        const target = showMov ? L.targetGroup(g.group_no, groups.length, s.position, members.length) : null;
        return {
          ...s,
          info: byId[s.pairId],
          movementTarget: target,
          // +1 sube (hacia el Grupo 1), -1 baja, 0 permanece
          movementDir: target == null ? 0 : Math.sign(g.group_no - target),
        };
      }),
      matches: matches.map(m => ({ ...m, outcome: L.matchOutcome(m), counts: L.countsForStandings(m) })),
      members,
    };
  });
  const closed = getSetting(`round${round}_closed`, '0') === '1';
  res.renderPage('public/liga', { category, round, groups: data, closed, showMov, pairName: (id) => L.pairName(db, id) });
});

// ---- Ranking ----
router.get('/ranking', (req, res) => res.redirect('/ranking/M'));
router.get('/ranking/:category', (req, res) => {
  const category = L.validCategory(req.params.category);
  const ranking = L.getRanking(db, category);
  const detail = ranking.map(r => {
    const rows = db.prepare(
      'SELECT round_no, group_no, position, round_points FROM round_results WHERE pair_id = ? ORDER BY round_no'
    ).all(r.pair_id);
    return { ...r, rows };
  });
  res.renderPage('public/ranking', { category, ranking: detail });
});

// ---- Playoffs ----
function bracketView(category, stage) {
  const matches = db.prepare(
    `SELECT m.*, c.name AS court_name FROM matches m LEFT JOIN courts c ON c.id = m.court_id
     WHERE stage = ? AND category = ? ORDER BY
     CASE bracket_round WHEN 'R32' THEN 0 WHEN 'R16' THEN 1 WHEN 'QF' THEN 2 WHEN 'SF' THEN 3 WHEN 'F' THEN 4 ELSE 9 END,
     bracket_slot`
  ).all(stage, category);
  const rounds = [];
  for (const m of matches) {
    let r = rounds.find(x => x.code === m.bracket_round);
    if (!r) { r = { code: m.bracket_round, name: L.BRACKET_NAME_BY_CODE[m.bracket_round] || m.bracket_round, matches: [] }; rounds.push(r); }
    r.matches.push({ ...m, outcome: L.matchOutcome(m), slot: L.formatSlot(m.scheduled_at, m.court_name) });
  }
  // Cabezas de serie en la primera ronda (guardadas al generar el cuadro).
  if (rounds.length) {
    const first = rounds[0].matches;
    first.forEach((m) => {
      m.seed_a = m.pair_a_id ? (m.seed_a || null) : null;
      m.seed_b = m.pair_b_id ? (m.seed_b || null) : null;
    });
  }
  return rounds;
}

router.get('/playoffs', (req, res) => res.redirect('/playoffs/M'));
router.get('/playoffs/:category', (req, res) => {
  const category = L.validCategory(req.params.category);
  const generated = getSetting('playoffs_generated', '0') === '1';
  const stages = db.prepare(
    `SELECT DISTINCT stage FROM matches WHERE category = ? AND stage LIKE 'po%' ORDER BY stage`
  ).all(category).map(r => r.stage);
  const brackets = stages.map(stage => ({
    stage, ordinal: L.playoffOrdinal(stage), rounds: bracketView(category, stage),
  }));
  res.renderPage('public/playoffs', {
    category, generated, brackets,
    pairName: (id) => L.pairName(db, id),
  });
});

// ---- Acceso de parejas ----
router.get('/acceso', (req, res) => {
  if (req.session.pairId) return res.redirect('/pareja');
  res.renderPage('public/acceso', { error: null });
});

router.post('/acceso', (req, res) => {
  const code = (req.body.code || '').trim().toUpperCase();
  const pair = db.prepare("SELECT * FROM pairs WHERE code = ? AND status = 'active'").get(code);
  if (!pair) return res.renderPage('public/acceso', { error: 'Código no válido o pareja aún no activada.' });
  req.session.pairId = pair.id;
  res.redirect('/pareja');
});

router.get('/salir', (req, res) => {
  req.session.pairId = null;
  req.session.admin = null;
  res.redirect('/');
});

module.exports = router;
