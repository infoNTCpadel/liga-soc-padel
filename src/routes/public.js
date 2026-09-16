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
  res.renderPage('public/home', { phases: phases(), fmtDate, counts });
});

// ---- Normativa (resumen fiel al documento oficial) ----
router.get('/normativa', (req, res) => {
  res.renderPage('public/normativa', { brackets: L.PLAYTOMIC_BRACKETS });
});

// ---- Inscripción ----
function activeQuestions() {
  return db.prepare('SELECT * FROM custom_questions WHERE active = 1 ORDER BY position, id').all()
    .map(q => ({ ...q, options: JSON.parse(q.options || '[]') }));
}

function eur(v) { return Number(v || 0).toFixed(2).replace('.', ','); }
router.get('/inscripcion', (req, res) => {
  res.renderPage('public/inscripcion', { questions: activeQuestions(), error: null, form: {},
    priceInscription: eur(getSetting('inscription_price', '19.95')),
    priceShirt: eur(getSetting('shirt_price', '14.95')) });
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
  const error = (msg) => res.renderPage('public/inscripcion', { questions: activeQuestions(), error: msg, form: b,
    priceInscription: eur(getSetting('inscription_price', '19.95')),
    priceShirt: eur(getSetting('shirt_price', '14.95')) });

  const category = L.validCategory(b.category);
  const mk = (n) => ({
    name: (b[`p${n}_name`] || '').trim(),
    email: (b[`p${n}_email`] || '').trim(),
    phone: (b[`p${n}_phone`] || '').trim(),
    level: parseFloat(b[`p${n}_level`]),
    shirt: b[`p${n}_shirt`] ? 1 : 0,
    shirt_size: (b[`p${n}_shirt_size`] || '').trim(),
  });
  const p1 = mk(1), p2 = mk(2);

  if (!p1.name || !p2.name) return error('Faltan los nombres de los dos jugadores.');
  if (!p1.phone || !p2.phone) return error('Faltan los teléfonos de contacto (los necesitaréis para organizar los partidos).');
  for (const [p, n] of [[p1, 1], [p2, 2]]) {
    if (!(p.level >= 0 && p.level <= 6)) return error(`El nivel del jugador ${n} no es válido (0 – 6).`);
    if (p.shirt && !p.shirt_size) return error(`Falta la talla de camiseta del jugador ${n}.`);
  }
  if (p1.name.toLowerCase() === p2.name.toLowerCase()) return error('Los dos jugadores no pueden tener el mismo nombre.');

  const questions = activeQuestions();
  for (const q of questions) {
    const ans = (b[`q_${q.id}`] || '').trim();
    if (q.required && !ans) return error(`Falta responder: "${q.label}".`);
  }

  const captain = b.captain === '2' ? 2 : 1;
  const code = genCode();
  const ins = db.prepare(
    'INSERT INTO players(name, email, phone, level, shirt, shirt_size) VALUES(?, ?, ?, ?, ?, ?)'
  );
  const r1 = ins.run(p1.name, p1.email, p1.phone, p1.level, p1.shirt, p1.shirt_size);
  const r2 = ins.run(p2.name, p2.email, p2.phone, p2.level, p2.shirt, p2.shirt_size);
  const levelAvg = Math.round(((p1.level + p2.level) / 2) * 100) / 100;
  const rp = db.prepare(
    `INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, level_avg, status)
     VALUES(?, ?, ?, ?, ?, ?, 'pending')`
  ).run(code, category, Number(r1.lastInsertRowid), Number(r2.lastInsertRowid),
    captain === 2 ? Number(r2.lastInsertRowid) : Number(r1.lastInsertRowid), levelAvg);
  const pairId = Number(rp.lastInsertRowid);

  const ansIns = db.prepare('INSERT INTO registration_answers(pair_id, question_id, answer) VALUES(?, ?, ?)');
  for (const q of questions) {
    const ans = (b[`q_${q.id}`] || '').trim();
    if (ans) ansIns.run(pairId, q.id, ans);
  }

  res.renderPage('public/inscripcion-ok', {
    code, category, p1, p2, levelAvg,
    price: getSetting('inscription_price', '19.95'),
  });
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
    `SELECT * FROM matches WHERE stage = ? AND category = ? ORDER BY
     CASE bracket_round WHEN 'R32' THEN 0 WHEN 'R16' THEN 1 WHEN 'QF' THEN 2 WHEN 'SF' THEN 3 WHEN 'F' THEN 4 ELSE 9 END,
     bracket_slot`
  ).all(stage, category);
  const rounds = [];
  for (const m of matches) {
    let r = rounds.find(x => x.code === m.bracket_round);
    if (!r) { r = { code: m.bracket_round, name: L.BRACKET_NAME_BY_CODE[m.bracket_round] || m.bracket_round, matches: [] }; rounds.push(r); }
    r.matches.push({ ...m, outcome: L.matchOutcome(m) });
  }
  return rounds;
}

router.get('/playoffs', (req, res) => res.redirect('/playoffs/M'));
router.get('/playoffs/:category', (req, res) => {
  const category = L.validCategory(req.params.category);
  const generated = getSetting('playoffs_generated', '0') === '1';
  res.renderPage('public/playoffs', {
    category, generated,
    po1: bracketView(category, 'po1'),
    po2: bracketView(category, 'po2'),
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
