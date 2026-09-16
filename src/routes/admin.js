// Panel de organización: inscripciones, pagos, grupos, rondas, resultados,
// playoffs, cambios de pareja y ajustes.
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { db, getSetting, setSetting } = require('../db');
const L = require('../lib/league');
const { advanceWinner } = require('./pair');

function requireAdmin(req, res, next) {
  res.locals.section = 'admin';
  if (!getSetting('admin_password_hash')) {
    if (req.path === '/setup') return next();
    return res.redirect('/admin/setup');
  }
  if (!req.session.admin) {
    if (req.path === '/login') return next();
    return res.redirect('/admin/login');
  }
  next();
}
router.use(requireAdmin);

// ---- Setup inicial / login ----
router.get('/setup', (req, res) => {
  if (getSetting('admin_password_hash')) return res.redirect('/admin/login');
  res.renderPage('admin/setup', { error: null });
});
router.post('/setup', (req, res) => {
  if (getSetting('admin_password_hash')) return res.redirect('/admin/login');
  const pw = (req.body.password || '').trim();
  if (pw.length < 6) return res.renderPage('admin/setup', { error: 'La contraseña debe tener al menos 6 caracteres.' });
  setSetting('admin_password_hash', bcrypt.hashSync(pw, 10));
  req.session.admin = true;
  res.redirect('/admin');
});
router.get('/login', (req, res) => {
  if (!getSetting('admin_password_hash')) return res.redirect('/admin/setup');
  res.renderPage('admin/login', { error: null });
});
router.post('/login', (req, res) => {
  const hash = getSetting('admin_password_hash');
  if (hash && bcrypt.compareSync(req.body.password || '', hash)) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.renderPage('admin/login', { error: 'Contraseña incorrecta.' });
});
router.post('/logout', (req, res) => { req.session.admin = null; res.redirect('/'); });

// ---- Panel principal ----
router.get('/', (req, res) => {
  const c = (sql, ...p) => db.prepare(sql).get(...p).c;
  const stats = {
    pending: c("SELECT COUNT(*) c FROM pairs WHERE status = 'pending'"),
    active: c("SELECT COUNT(*) c FROM pairs WHERE status = 'active'"),
    unpaid: c('SELECT COUNT(*) c FROM players WHERE paid = 0 AND id IN (SELECT player1_id FROM pairs WHERE status IN (\'pending\',\'active\') UNION SELECT player2_id FROM pairs WHERE status IN (\'pending\',\'active\'))'),
    toValidate: c("SELECT COUNT(*) c FROM matches WHERE validation = 'pending'"),
    disputed: c("SELECT COUNT(*) c FROM matches WHERE validation = 'disputed'"),
    changes: c("SELECT COUNT(*) c FROM pair_changes WHERE status = 'pending'"),
    shirts: c('SELECT COUNT(*) c FROM players WHERE shirt = 1'),
  };
  const rounds = [1, 2, 3].map(n => {
    const info = {};
    for (const cat of L.CATEGORY_CODES) {
      const groups = L.getGroups(db, cat, n);
      const total = db.prepare('SELECT COUNT(*) c FROM matches WHERE stage = \'groups\' AND round_no = ? AND category = ?').get(n, cat).c;
      const done = db.prepare(
        "SELECT COUNT(*) c FROM matches WHERE stage = 'groups' AND round_no = ? AND category = ? AND (winner_id IS NOT NULL OR wo_winner_id IS NOT NULL OR unplayed = 1)"
      ).get(n, cat).c;
      info[cat] = { groups: groups.length, total, done };
    }
    return { n, closed: getSetting(`round${n}_closed`, '0') === '1', info };
  });
  res.renderPage('admin/home', { stats, rounds, playoffsGenerated: getSetting('playoffs_generated', '0') === '1' });
});

// ================= INSCRIPCIONES =================
router.get('/inscripciones', (req, res) => {
  const { status = '', paid = '', q = '' } = req.query;
  let sql = `SELECT p.*, p1.name n1, p1.phone t1, p1.paid paid1, p2.name n2, p2.phone t2, p2.paid paid2
             FROM pairs p JOIN players p1 ON p1.id = p.player1_id JOIN players p2 ON p2.id = p.player2_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND p.status = ?'; params.push(status); }
  if (paid === '0') { sql += ' AND (p1.paid = 0 OR p2.paid = 0)'; }
  if (paid === '1') { sql += ' AND p1.paid = 1 AND p2.paid = 1'; }
  if (q) { sql += ' AND (p1.name LIKE ? OR p2.name LIKE ? OR p.code LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY p.created_at DESC';
  res.renderPage('admin/inscripciones', { rows: db.prepare(sql).all(...params), status, paid, q });
});

router.get('/inscripciones/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM pairs WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('No existe.');
  const players = db.prepare('SELECT * FROM players WHERE id IN (?, ?)').all(p.player1_id, p.player2_id);
  const answers = db.prepare(
    `SELECT q.label, a.answer FROM registration_answers a JOIN custom_questions q ON q.id = a.question_id WHERE a.pair_id = ?`
  ).all(p.id);
  res.renderPage('admin/inscripcion-detalle', { p, players, answers });
});

router.post('/inscripciones/:id/estado', (req, res) => {
  const st = req.body.status;
  if (!['pending', 'active', 'rejected'].includes(st)) return res.redirect('/admin/inscripciones');
  db.prepare('UPDATE pairs SET status = ? WHERE id = ?').run(st, req.params.id);
  res.redirect('/admin/inscripciones/' + req.params.id);
});

router.post('/inscripciones/:id/pago', (req, res) => {
  const playerId = parseInt(req.body.player_id, 10);
  const paid = req.body.paid === '1' ? 1 : 0;
  const p = db.prepare('SELECT * FROM pairs WHERE id = ?').get(req.params.id);
  if (p && [p.player1_id, p.player2_id].includes(playerId)) {
    db.prepare('UPDATE players SET paid = ? WHERE id = ?').run(paid, playerId);
  }
  res.redirect('/admin/inscripciones/' + req.params.id);
});

router.get('/inscripciones.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT p.id, p.code, p.category, p.status, p.created_at,
            p1.name n1, p1.email e1, p1.phone t1, p1.level l1, p1.paid paid1, p1.shirt s1, p1.shirt_size ts1,
            p2.name n2, p2.email e2, p2.phone t2, p2.level l2, p2.paid paid2, p2.shirt s2, p2.shirt_size ts2
     FROM pairs p JOIN players p1 ON p1.id = p.player1_id JOIN players p2 ON p2.id = p.player2_id
     ORDER BY p.id`
  ).all();
  const questions = db.prepare('SELECT id, label FROM custom_questions ORDER BY position, id').all();
  const head = ['id', 'codigo', 'categoria', 'estado', 'fecha', 'jugador1', 'email1', 'tlf1', 'nivel1', 'pagado1', 'camiseta1', 'talla1',
    'jugador2', 'email2', 'tlf2', 'nivel2', 'pagado2', 'camiseta2', 'talla2', ...questions.map(q => q.label)];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(';')];
  for (const r of rows) {
    const ans = Object.fromEntries(db.prepare('SELECT question_id, answer FROM registration_answers WHERE pair_id = ?').all(r.id).map(a => [a.question_id, a.answer]));
    lines.push([r.id, r.code, r.category, r.status, r.created_at, r.n1, r.e1, r.t1, r.l1, r.paid1, r.s1, r.ts1,
      r.n2, r.e2, r.t2, r.l2, r.paid2, r.s2, r.ts2, ...questions.map(q => ans[q.id] || '')].map(esc).join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="inscripciones.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

// ================= PREGUNTAS DEL FORMULARIO =================
router.get('/preguntas', (req, res) => {
  const qs = db.prepare('SELECT * FROM custom_questions ORDER BY position, id').all()
    .map(q => ({ ...q, options: JSON.parse(q.options || '[]') }));
  res.renderPage('admin/preguntas', { qs });
});
router.post('/preguntas', (req, res) => {
  const b = req.body;
  const label = (b.label || '').trim();
  if (!label) return res.redirect('/admin/preguntas');
  const type = ['text', 'select', 'yesno'].includes(b.type) ? b.type : 'text';
  const options = type === 'select' ? (b.options || '').split('\n').map(s => s.trim()).filter(Boolean) : [];
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 p FROM custom_questions').get().p;
  db.prepare('INSERT INTO custom_questions(label, type, options, required, position) VALUES(?, ?, ?, ?, ?)')
    .run(label, type, JSON.stringify(options), b.required ? 1 : 0, pos);
  res.redirect('/admin/preguntas');
});
router.post('/preguntas/:id/eliminar', (req, res) => {
  db.prepare('DELETE FROM custom_questions WHERE id = ?').run(req.params.id);
  res.redirect('/admin/preguntas');
});
router.post('/preguntas/:id/toggle', (req, res) => {
  db.prepare('UPDATE custom_questions SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/preguntas');
});

// ================= PAREJAS =================
router.get('/parejas', (req, res) => {
  const rows = db.prepare(
    `SELECT p.*, p1.name n1, p2.name n2 FROM pairs p
     JOIN players p1 ON p1.id = p.player1_id JOIN players p2 ON p2.id = p.player2_id
     ORDER BY p.category, p.status, p.id`
  ).all();
  res.renderPage('admin/parejas', { rows });
});

router.get('/parejas/nueva', (req, res) => {
  res.renderPage('admin/pareja-nueva', { error: null, brackets: L.PLAYTOMIC_BRACKETS });
});

router.post('/parejas/nueva', (req, res) => {
  const b = req.body;
  const err = (msg) => res.renderPage('admin/pareja-nueva', { error: msg, brackets: L.PLAYTOMIC_BRACKETS });
  const mk = (n) => ({
    name: (b[`p${n}_name`] || '').trim(), email: (b[`p${n}_email`] || '').trim(),
    phone: (b[`p${n}_phone`] || '').trim(), level: parseFloat(b[`p${n}_level`]),
  });
  const p1 = mk(1), p2 = mk(2);
  if (!p1.name || !p2.name) return err('Faltan nombres.');
  for (const [p, n] of [[p1, 1], [p2, 2]]) if (!(p.level >= 0 && p.level <= 6)) return err(`Nivel del jugador ${n} no válido.`);
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code; do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (db.prepare('SELECT 1 FROM pairs WHERE code = ?').get(code));
  const ins = db.prepare('INSERT INTO players(name, email, phone, level, paid) VALUES(?, ?, ?, ?, ?)');
  const r1 = ins.run(p1.name, p1.email, p1.phone, p1.level, b.p1_paid ? 1 : 0);
  const r2 = ins.run(p2.name, p2.email, p2.phone, p2.level, b.p2_paid ? 1 : 0);
  const avg = Math.round(((p1.level + p2.level) / 2) * 100) / 100;
  db.prepare(`INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, level_avg, status)
              VALUES(?, ?, ?, ?, ?, ?, 'active')`)
    .run(code, L.validCategory(b.category), Number(r1.lastInsertRowid), Number(r2.lastInsertRowid),
      Number(r1.lastInsertRowid), avg);
  res.redirect('/admin/parejas');
});

router.post('/parejas/:id/codigo', (req, res) => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code; do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (db.prepare('SELECT 1 FROM pairs WHERE code = ?').get(code));
  db.prepare('UPDATE pairs SET code = ? WHERE id = ?').run(code, req.params.id);
  res.redirect('/admin/parejas');
});

router.post('/parejas/:id/retirar', (req, res) => {
  db.prepare("UPDATE pairs SET status = 'withdrawn' WHERE id = ?").run(req.params.id);
  res.redirect('/admin/parejas');
});

// ================= GRUPOS Y RONDAS =================
router.get('/grupos', (req, res) => {
  const category = L.validCategory(req.query.category);
  const round = Math.min(3, Math.max(1, parseInt(req.query.round) || 1));
  const groups = L.getGroups(db, category, round).map(g => {
    const members = L.getGroupMembers(db, g.id);
    const matches = L.getGroupMatches(db, g.id);
    const hasResults = matches.some(m => m.winner_id || m.wo_winner_id || m.unplayed);
    return { ...g, members, matchCount: matches.length, hasResults };
  });
  const prevClosed = round === 1 || getSetting(`round${round - 1}_closed`, '0') === '1';
  res.renderPage('admin/grupos', {
    category, round, groups, prevClosed,
    closed: getSetting(`round${round}_closed`, '0') === '1',
    error: req.query.error || null,
  });
});

// Generar grupos de la Ronda 1 por nivel
router.post('/grupos/generar-r1', (req, res) => {
  const category = L.validCategory(req.body.category);
  if (L.getGroups(db, category, 1).length) return res.redirect(`/admin/grupos?category=${category}&round=1&error=${encodeURIComponent('Ya existen grupos para esta ronda y categoría.')}`);
  const pairs = db.prepare(
    "SELECT id, level_avg FROM pairs WHERE category = ? AND status = 'active' ORDER BY level_avg DESC, id ASC"
  ).all(category);
  if (pairs.length < 2) return res.redirect(`/admin/grupos?category=${category}&round=1&error=${encodeURIComponent('No hay suficientes parejas activas.')}`);
  const chunks = L.chunkIntoGroups(pairs.map(p => p.id));
  const gIns = db.prepare('INSERT INTO groups(category, round_no, group_no) VALUES(?, 1, ?)');
  const mIns = db.prepare('INSERT INTO group_members(group_id, pair_id) VALUES(?, ?)');
  chunks.forEach((ids, i) => {
    const g = gIns.run(category, i + 1);
    ids.forEach(pid => mIns.run(Number(g.lastInsertRowid), pid));
  });
  res.redirect(`/admin/grupos?category=${category}&round=1`);
});

// Generar grupos de la ronda N (2 o 3) a partir de los movimientos de la anterior
router.post('/grupos/generar-siguiente', (req, res) => {
  const category = L.validCategory(req.body.category);
  const round = parseInt(req.body.round, 10);
  if (![2, 3].includes(round)) return res.redirect('/admin/grupos');
  if (getSetting(`round${round - 1}_closed`, '0') !== '1') {
    return res.redirect(`/admin/grupos?category=${category}&round=${round}&error=${encodeURIComponent('Primero hay que cerrar la ronda anterior.')}`);
  }
  if (L.getGroups(db, category, round).length) {
    return res.redirect(`/admin/grupos?category=${category}&round=${round}&error=${encodeURIComponent('Ya existen grupos para esta ronda.')}`);
  }
  const prevGroups = L.getGroups(db, category, round - 1);
  const totalGroups = prevGroups.length;
  const pairs = db.prepare("SELECT id FROM pairs WHERE category = ? AND status = 'active'").all(category);
  const withTarget = pairs.map(p => {
    const rr = db.prepare('SELECT group_no, position FROM round_results WHERE pair_id = ? AND round_no = ?').get(p.id, round - 1);
    if (!rr) return { id: p.id, target: totalGroups, pos: 99 }; // alta tardía → último grupo
    const size = L.getGroupMembers(db, prevGroups.find(g => g.group_no === rr.group_no).id).length;
    return { id: p.id, target: L.targetGroup(rr.group_no, totalGroups, rr.position, size), pos: rr.position };
  });
  withTarget.sort((a, b) => a.target - b.target || a.pos - b.pos);
  const chunks = L.chunkIntoGroups(withTarget.map(x => x.id));
  // Si el nº de grupos difiere, se mantiene el de la ronda anterior si es posible
  const gIns = db.prepare('INSERT INTO groups(category, round_no, group_no) VALUES(?, ?, ?)');
  const mIns = db.prepare('INSERT INTO group_members(group_id, pair_id) VALUES(?, ?)');
  chunks.forEach((ids, i) => {
    const g = gIns.run(category, round, i + 1);
    ids.forEach(pid => mIns.run(Number(g.lastInsertRowid), pid));
  });
  res.redirect(`/admin/grupos?category=${category}&round=${round}`);
});

// Generar / regenerar el calendario (round-robin) de un grupo
router.post('/grupos/:gid/calendario', (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.gid);
  if (!g) return res.redirect('/admin/grupos');
  const existing = L.getGroupMatches(db, g.id);
  if (existing.some(m => m.winner_id || m.wo_winner_id || m.unplayed)) {
    return res.redirect(`/admin/grupos?category=${g.category}&round=${g.round_no}&error=${encodeURIComponent('El grupo ya tiene resultados: no se puede regenerar el calendario.')}`);
  }
  db.prepare('DELETE FROM matches WHERE group_id = ?').run(g.id);
  const members = L.getGroupMembers(db, g.id).map(m => m.pair_id);
  const ins = db.prepare(`INSERT INTO matches(category, stage, round_no, group_id, pair_a_id, pair_b_id) VALUES(?, 'groups', ?, ?, ?, ?)`);
  for (const f of L.roundRobin(members)) ins.run(g.category, g.round_no, g.id, f.a, f.b);
  res.redirect(`/admin/grupos?category=${g.category}&round=${g.round_no}`);
});

// Mover una pareja de grupo (antes de que haya resultados)
router.post('/grupos/:gid/mover', (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.gid);
  const targetId = parseInt(req.body.target_group_id, 10);
  const pairId = parseInt(req.body.pair_id, 10);
  const tg = db.prepare('SELECT * FROM groups WHERE id = ?').get(targetId);
  const back = `/admin/grupos?category=${g.category}&round=${g.round_no}`;
  if (!g || !tg || tg.category !== g.category || tg.round_no !== g.round_no) return res.redirect(back);
  const played = db.prepare(
    `SELECT COUNT(*) c FROM matches WHERE group_id = ? AND (pair_a_id = ? OR pair_b_id = ?)
     AND (winner_id IS NOT NULL OR wo_winner_id IS NOT NULL OR unplayed = 1)`
  ).get(g.id, pairId, pairId).c;
  if (played) return res.redirect(back + '&error=' + encodeURIComponent('La pareja ya tiene partidos con resultado en este grupo.'));
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND pair_id = ?').run(g.id, pairId);
  db.prepare('INSERT INTO group_members(group_id, pair_id) VALUES(?, ?)').run(targetId, pairId);
  // limpiar calendarios sin resultados de ambos grupos para regenerarlos
  for (const gid of [g.id, targetId]) {
    const ms = L.getGroupMatches(db, gid);
    if (!ms.some(m => m.winner_id || m.wo_winner_id || m.unplayed)) db.prepare('DELETE FROM matches WHERE group_id = ?').run(gid);
  }
  res.redirect(back);
});

// ================= PARTIDOS =================
router.get('/partidos', (req, res) => {
  const category = L.validCategory(req.query.category);
  const stage = req.query.stage === 'po' ? 'po' : 'groups';
  let matches;
  if (stage === 'groups') {
    const round = Math.min(3, Math.max(1, parseInt(req.query.round) || 1));
    matches = db.prepare(
      `SELECT m.*, g.group_no, g.round_no FROM matches m LEFT JOIN groups g ON g.id = m.group_id
       WHERE m.stage = 'groups' AND m.category = ? AND m.round_no = ? ORDER BY g.group_no, m.id`
    ).all(category, round);
    res.renderPage('admin/partidos', { category, stage, round, matches, pairName: (id) => L.pairName(db, id) });
  } else {
    matches = db.prepare(
      `SELECT m.* FROM matches m WHERE m.stage IN ('po1','po2') AND m.category = ?
       ORDER BY m.stage, CASE m.bracket_round WHEN 'R32' THEN 0 WHEN 'R16' THEN 1 WHEN 'QF' THEN 2 WHEN 'SF' THEN 3 WHEN 'F' THEN 4 ELSE 9 END, m.bracket_slot`
    ).all(category);
    res.renderPage('admin/partidos', { category, stage, round: null, matches, pairName: (id) => L.pairName(db, id) });
  }
});

// Introducir / corregir un resultado manualmente
router.post('/partidos/:id/resultado', (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return res.redirect('/admin');
  const b = req.body;
  const num = (v) => (v === '' || v == null ? null : parseInt(v, 10));
  const winner = parseInt(b.winner_id, 10);
  if (![m.pair_a_id, m.pair_b_id].includes(winner) && !b.unplayed && !b.wo) return res.redirect('/admin/partidos');
  const wo = !!b.wo;
  const unplayed = !!b.unplayed;
  db.prepare(`UPDATE matches SET s1a=?, s1b=?, s2a=?, s2b=?, s3a=?, s3b=?, stb_a=?, stb_b=?,
              winner_id=?, wo_winner_id=?, unplayed=?, submitted_by=NULL,
              validation = CASE WHEN ? = 1 THEN 'none' ELSE 'validated' END,
              validation_deadline = NULL, notes = ? WHERE id = ?`)
    .run(num(b.s1a), num(b.s1b), num(b.s2a), num(b.s2b), num(b.s3a), num(b.s3b), num(b.stb_a), num(b.stb_b),
      unplayed ? null : winner, wo ? winner : null, unplayed ? 1 : 0, unplayed ? 1 : 0,
      (b.notes || '').trim(), m.id);
  const upd = db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id);
  advanceWinner(upd);
  res.redirect(req.body.back || '/admin/partidos');
});

// Resolver una disputa a favor del resultado subido
router.post('/partidos/:id/resolver', (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (m && m.validation === 'disputed') {
    db.prepare("UPDATE matches SET validation = 'validated' WHERE id = ?").run(m.id);
    advanceWinner(db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id));
  }
  res.redirect(req.body.back || '/admin');
});

// ================= CIERRE DE RONDAS =================
router.get('/rondas/:n/cerrar', (req, res) => {
  const n = parseInt(req.params.n, 10);
  if (![1, 2, 3].includes(n)) return res.redirect('/admin');
  const preview = [];
  for (const category of L.CATEGORY_CODES) {
    const groups = L.getGroups(db, category, n);
    const total = groups.length;
    for (const g of groups) {
      const members = L.getGroupMembers(db, g.id);
      const matches = L.getGroupMatches(db, g.id);
      const standings = L.computeStandings(members.map(x => x.pair_id), matches);
      const missing = matches.filter(mt => !mt.winner_id && !mt.wo_winner_id && mt.unplayed !== 1).length;
      preview.push({
        category, group: g,
        standings: standings.map(s => {
          const delta = L.movementDelta(g.group_no, total, s.position, members.length);
          return { ...s, delta, target: Math.min(total, Math.max(1, g.group_no + delta)), points: L.roundPoints(g.group_no, s.position) };
        }),
        missing,
      });
    }
  }
  res.renderPage('admin/cerrar-ronda', { n, preview, closed: getSetting(`round${n}_closed`, '0') === '1', pairName: (id) => L.pairName(db, id) });
});

router.post('/rondas/:n/cerrar', (req, res) => {
  const n = parseInt(req.params.n, 10);
  if (![1, 2, 3].includes(n)) return res.redirect('/admin');
  if (getSetting(`round${n}_closed`, '0') === '1') return res.redirect('/admin');
  db.exec('BEGIN');
  try {
    for (const category of L.CATEGORY_CODES) {
      const groups = L.getGroups(db, category, n);
      const total = groups.length;
      for (const g of groups) {
        const members = L.getGroupMembers(db, g.id);
        const matches = L.getGroupMatches(db, g.id);
        // Los partidos sin resultado subido cuentan como no jugados (normativa).
        db.prepare(`UPDATE matches SET unplayed = 1 WHERE group_id = ? AND winner_id IS NULL AND wo_winner_id IS NULL AND unplayed = 0`).run(g.id);
        const standings = L.computeStandings(members.map(x => x.pair_id), L.getGroupMatches(db, g.id));
        const ins = db.prepare(`INSERT INTO round_results(pair_id, category, round_no, group_no, position, round_points, movement, target_group)
                                VALUES(?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const s of standings) {
          const delta = L.movementDelta(g.group_no, total, s.position, members.length);
          const target = Math.min(total, Math.max(1, g.group_no + delta));
          ins.run(s.pairId, category, n, g.group_no, s.position, L.roundPoints(g.group_no, s.position), delta, target);
        }
      }
    }
    setSetting(`round${n}_closed`, '1');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.redirect('/admin');
});

router.post('/rondas/:n/reabrir', (req, res) => {
  const n = parseInt(req.params.n, 10);
  if ([1, 2, 3].includes(n)) {
    db.prepare('DELETE FROM round_results WHERE round_no = ?').run(n);
    setSetting(`round${n}_closed`, '0');
  }
  res.redirect('/admin');
});

// ================= PLAYOFFS =================
router.get('/playoffs', (req, res) => {
  const data = L.CATEGORY_CODES.map(category => {
    const ranking = L.getRanking(db, category);
    const split = L.splitPlayoffs(ranking.map(r => r.pair_id));
    return { category, ranking, split };
  });
  res.renderPage('admin/playoffs', {
    data, generated: getSetting('playoffs_generated', '0') === '1',
    round3closed: getSetting('round3_closed', '0') === '1',
    pairName: (id) => L.pairName(db, id),
  });
});

router.post('/playoffs/generar', (req, res) => {
  const category = L.validCategory(req.body.category);
  if (getSetting('round3_closed', '0') !== '1') return res.redirect('/admin/playoffs');
  // Regenerar solo si no hay resultados en los cuadros de esta categoría
  const withRes = db.prepare(
    `SELECT COUNT(*) c FROM matches WHERE stage IN ('po1','po2') AND category = ?
     AND (winner_id IS NOT NULL OR wo_winner_id IS NOT NULL)`
  ).get(category).c;
  if (withRes) return res.redirect('/admin/playoffs');
  db.prepare(`DELETE FROM matches WHERE stage IN ('po1','po2') AND category = ?`).run(category);

  const ranking = L.getRanking(db, category).map(r => r.pair_id);
  const { po1, po2 } = L.splitPlayoffs(ranking);
  const ins = db.prepare(`INSERT INTO matches(category, stage, bracket_round, bracket_slot, pair_a_id, pair_b_id)
                          VALUES(?, ?, ?, ?, ?, ?)`);
  const processByes = [];
  for (const [stage, ids] of [['po1', po1], ['po2', po2]]) {
    if (ids.length < 2) continue;
    for (const round of L.buildBracket(ids)) {
      for (const mt of round.matches) {
        const r = ins.run(category, stage, round.code, mt.slot, mt.a, mt.b);
        if (round.code !== 'F' || true) { /* nada */ }
        if (mt.a && !mt.b) processByes.push(Number(r.lastInsertRowid));
        else if (mt.b && !mt.a) processByes.push(Number(r.lastInsertRowid));
      }
    }
  }
  // Los byes avanzan directamente a la siguiente ronda
  for (const id of processByes) {
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    const w = m.pair_a_id || m.pair_b_id;
    db.prepare("UPDATE matches SET winner_id = ?, validation = 'auto' WHERE id = ?").run(w, id);
    advanceWinner(db.prepare('SELECT * FROM matches WHERE id = ?').get(id));
  }
  setSetting('playoffs_generated', '1');
  res.redirect('/admin/playoffs');
});

// ================= CAMBIOS DE PAREJA =================
router.get('/cambios', (req, res) => {
  const rows = db.prepare(
    `SELECT c.*, p.code, p.category, op.name AS old_name, op.level AS old_level
     FROM pair_changes c JOIN pairs p ON p.id = c.pair_id JOIN players op ON op.id = c.old_player_id
     ORDER BY c.created_at DESC`
  ).all();
  res.renderPage('admin/cambios', { rows, brackets: L.PLAYTOMIC_BRACKETS });
});

router.post('/cambios/:id/aprobar', (req, res) => {
  const c = db.prepare('SELECT * FROM pair_changes WHERE id = ?').get(req.params.id);
  if (!c || c.status !== 'pending') return res.redirect('/admin/cambios');
  const pair = db.prepare('SELECT * FROM pairs WHERE id = ?').get(c.pair_id);
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO players(name, email, phone, level) VALUES(?, ?, ?, ?)')
      .run(c.new_name, c.new_email, c.new_phone, c.new_level);
    const newId = Number(r.lastInsertRowid);
    const col = pair.player1_id === c.old_player_id ? 'player1_id' : 'player2_id';
    const old = db.prepare('SELECT level FROM players WHERE id = ?').get(pair.player1_id === c.old_player_id ? pair.player2_id : pair.player1_id);
    const avg = Math.round(((old.level + c.new_level) / 2) * 100) / 100;
    db.prepare(`UPDATE pairs SET ${col} = ?, captain_id = CASE WHEN captain_id = ? THEN ? ELSE captain_id END,
                level_avg = ?, changes_used = changes_used + 1 WHERE id = ?`)
      .run(newId, c.old_player_id, newId, avg, pair.id);
    db.prepare("UPDATE pair_changes SET status = 'approved', decided_at = datetime('now') WHERE id = ?").run(c.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.redirect('/admin/cambios');
});

router.post('/cambios/:id/rechazar', (req, res) => {
  db.prepare("UPDATE pair_changes SET status = 'rejected', decided_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(req.params.id);
  res.redirect('/admin/cambios');
});

// ================= AJUSTES =================
router.get('/ajustes', (req, res) => {
  const keys = ['club_name', 'season_name', 'phase_insc_label', 'phase_insc_ini', 'phase_insc_fin',
    'phase_r1_label', 'phase_r1_ini', 'phase_r1_fin', 'phase_r2_label', 'phase_r2_ini', 'phase_r2_fin',
    'phase_r3_label', 'phase_r3_ini', 'phase_r3_fin', 'phase_po_label', 'phase_po_ini', 'phase_po_fin',
    'inscription_price', 'shirt_price'];
  const s = Object.fromEntries(keys.map(k => [k, getSetting(k, '')]));
  res.renderPage('admin/ajustes', { s, msg: req.query.msg || null });
});

router.post('/ajustes', (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    if (k.startsWith('phase_') || ['club_name', 'season_name', 'inscription_price', 'shirt_price'].includes(k)) {
      setSetting(k, (v || '').trim());
    }
  }
  res.redirect('/admin/ajustes?msg=' + encodeURIComponent('Ajustes guardados.'));
});

router.post('/ajustes/password', (req, res) => {
  const pw = (req.body.password || '').trim();
  if (pw.length < 6) return res.redirect('/admin/ajustes?msg=' + encodeURIComponent('La contraseña debe tener al menos 6 caracteres.'));
  setSetting('admin_password_hash', bcrypt.hashSync(pw, 10));
  res.redirect('/admin/ajustes?msg=' + encodeURIComponent('Contraseña actualizada.'));
});

module.exports = router;
