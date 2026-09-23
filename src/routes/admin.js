// Panel de organización: inscripciones, pagos, grupos, rondas, resultados,
// playoffs, cambios de pareja y ajustes.
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { db, getSetting, setSetting, getAdminHash, setAdminHash, getReceptionHash, setReceptionHash,
  listSeasons, getActiveSeason, activateSeason, createSeason, renameSeason, deleteSeason } = require('../db');
const L = require('../lib/league');
const { advanceWinner } = require('./pair');

function requireAdmin(req, res, next) {
  res.locals.section = 'admin';
  if (!getAdminHash()) {
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
  if (getAdminHash()) return res.redirect('/admin/login');
  res.renderPage('admin/setup', { error: null });
});
router.post('/setup', (req, res) => {
  if (getAdminHash()) return res.redirect('/admin/login');
  const pw = (req.body.password || '').trim();
  if (pw.length < 6) return res.renderPage('admin/setup', { error: 'La contraseña debe tener al menos 6 caracteres.' });
  setAdminHash(bcrypt.hashSync(pw, 10));
  req.session.admin = true;
  res.redirect('/admin');
});
router.get('/login', (req, res) => {
  if (!getAdminHash()) return res.redirect('/admin/setup');
  res.renderPage('admin/login', { error: null });
});
router.post('/login', (req, res) => {
  const hash = getAdminHash();
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
  let sql = `SELECT p.*, p1.name n1, p1.phone t1, p1.paid paid1, p1.gender g1, p1.member_verified mv1,
             p2.name n2, p2.phone t2, p2.paid paid2, p2.gender g2, p2.member_verified mv2
             FROM pairs p JOIN players p1 ON p1.id = p.player1_id JOIN players p2 ON p2.id = p.player2_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND p.status = ?'; params.push(status); }
  if (paid === '0') { sql += ' AND (p1.paid = 0 OR p2.paid = 0)'; }
  if (paid === '1') { sql += ' AND p1.paid = 1 AND p2.paid = 1'; }
  if (q) { sql += ' AND (p1.name LIKE ? OR p2.name LIKE ? OR p.code LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY p.created_at DESC';
  const rows = db.prepare(sql).all(...params);
  // Posibles duplicados: mismo nombre o teléfono en 2+ parejas de la MISMA
  // categoría (entre categorías distintas es legítimo: hasta 2 modalidades).
  const dupes = new Set(), multi = new Set(), xwarn = new Set();
  const seen = {};
  for (const pl of db.prepare(`SELECT pl.name, pl.phone, p.id AS pair_id, p.category FROM players pl
      JOIN pairs p ON p.player1_id = pl.id OR p.player2_id = pl.id
      WHERE p.status IN ('pending','active')`).all()) {
    const keys = [];
    const nm = (pl.name || '').trim().toLowerCase();
    if (nm) keys.push('n:' + nm);
    const ph = L.normPhone(pl.phone);
    if (ph.length >= 6) keys.push('t:' + ph);
    for (const k of keys) {
      const prev = seen[k];
      if (prev && prev.pair_id !== pl.pair_id) {
        if (prev.category === pl.category) { dupes.add(prev.pair_id); dupes.add(pl.pair_id); }
        else { multi.add(prev.pair_id); multi.add(pl.pair_id); }
      } else if (!prev) seen[k] = { pair_id: pl.pair_id, category: pl.category };
    }
  }
  for (const r of rows) {
    if (r.category === 'X' && !((r.g1 === 'M' && r.g2 === 'F') || (r.g1 === 'F' && r.g2 === 'M'))) xwarn.add(r.id);
    if (r.category === 'M' && (r.g1 === 'F' || r.g2 === 'F')) xwarn.add(r.id);
    if (r.category === 'F' && (r.g1 === 'M' || r.g2 === 'M')) xwarn.add(r.id);
  }
  const unverified = new Set(rows.filter(r => !r.mv1 || !r.mv2).map(r => r.id));
  res.renderPage('admin/inscripciones', { rows, status, paid, q,
    dupes: [...dupes], multi: [...multi], xwarn: [...xwarn], unverified: [...unverified] });
});

router.get('/inscripciones/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM pairs WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('No existe.');
  const players = db.prepare('SELECT * FROM players WHERE id IN (?, ?)').all(p.player1_id, p.player2_id);
  const answers = db.prepare(
    `SELECT q.label, a.answer FROM registration_answers a JOIN custom_questions q ON q.id = a.question_id WHERE a.pair_id = ?`
  ).all(p.id);
  // Precio esperado por jugador según sus modalidades totales en la temporada
  const eur = (v) => Number(v || 0).toFixed(2).replace('.', ',');
  const priceInfo = players.map(pl => {
    const cats = L.personCategories(db, pl.phone);
    const expected = L.priceForModalities(getSetting, cats.length);
    return { id: pl.id, cats: cats.map(c => L.catName(c).toLowerCase()), expected: eur(expected) };
  });
  res.renderPage('admin/inscripcion-detalle', { p, players, answers, priceInfo });
});

router.post('/inscripciones/:id/estado', (req, res) => {
  const st = req.body.status;
  if (!['pending', 'active', 'rejected'].includes(st)) return res.redirect('/admin/inscripciones');
  if (st === 'active') {
    const p = db.prepare('SELECT * FROM pairs WHERE id = ?').get(req.params.id);
    if (p) {
      const unv = db.prepare('SELECT COUNT(*) c FROM players WHERE id IN (?, ?) AND COALESCE(member_verified, 0) = 0')
        .get(p.player1_id, p.player2_id).c;
      if (unv > 0) {
        return res.redirect('/admin/inscripciones/' + req.params.id + '?err=' +
          encodeURIComponent('No se puede activar: hay jugadores con el nº de socio sin verificar.'));
      }
    }
  }
  db.prepare('UPDATE pairs SET status = ? WHERE id = ?').run(st, req.params.id);
  res.redirect('/admin/inscripciones/' + req.params.id);
});

// Verificación del nº de socio (también la usa recepción desde su página).
router.post('/inscripciones/:id/socio', (req, res) => {
  const playerId = parseInt(req.body.player_id, 10);
  const p = db.prepare('SELECT * FROM pairs WHERE id = ?').get(req.params.id);
  if (p && [p.player1_id, p.player2_id].includes(playerId)) {
    if (req.body.action === 'save') {
      const mn = (req.body.member_no || '').trim();
      const known = new Set(
        db.prepare('SELECT member_no FROM players WHERE member_verified = 1 AND id != ?').all(playerId)
          .map(r => L.memberNoKey(r.member_no))
      );
      const v = mn && known.has(L.memberNoKey(mn)) ? 1 : 0;
      db.prepare('UPDATE players SET member_no = ?, member_verified = ? WHERE id = ?').run(mn, v, playerId);
    } else {
      // La verificación es de la persona: se propaga a sus demás filas con el mismo nº.
      const cur = db.prepare('SELECT member_verified FROM players WHERE id = ?').get(playerId).member_verified;
      L.setMemberVerified(db, playerId, cur ? 0 : 1);
    }
  }
  res.redirect('/admin/inscripciones/' + req.params.id);
});

router.post('/inscripciones/:id/pago', (req, res) => {
  const playerId = parseInt(req.body.player_id, 10);
  const paid = req.body.paid === '1' ? 1 : 0;
  const p = db.prepare('SELECT * FROM pairs WHERE id = ?').get(req.params.id);
  if (p && [p.player1_id, p.player2_id].includes(playerId)) {
    // El pago es por persona, no por pareja: se propaga a todas las parejas
    // (pendientes o activas) de quien tenga ese mismo teléfono.
    const me = db.prepare('SELECT phone FROM players WHERE id = ?').get(playerId);
    const ids = L.personPlayerIds(db, me ? me.phone : '');
    const targets = ids.length ? ids : [playerId];
    db.exec('BEGIN');
    try {
      const u = db.prepare('UPDATE players SET paid = ? WHERE id = ?');
      for (const id of targets) u.run(paid, id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error('pago', e);
    }
  }
  res.redirect('/admin/inscripciones/' + req.params.id);
});

router.post('/inscripciones/:id/nivel', (req, res) => {
  const playerId = parseInt(req.body.player_id, 10);
  const level = parseFloat(String(req.body.level || '').replace(',', '.'));
  const p = db.prepare('SELECT * FROM pairs WHERE id = ?').get(req.params.id);
  if (p && [p.player1_id, p.player2_id].includes(playerId) && level >= 0 && level <= 6) {
    // El nivel es del jugador: se corrige en todas sus parejas (mismo teléfono)
    // y se recalcula el nivel medio de cada una.
    const me = db.prepare('SELECT phone FROM players WHERE id = ?').get(playerId);
    const ids = L.personPlayerIds(db, me ? me.phone : '');
    const targets = ids.length ? ids : [playerId];
    db.exec('BEGIN');
    try {
      const u = db.prepare('UPDATE players SET level = ? WHERE id = ?');
      for (const id of targets) u.run(level, id);
      const pairOf = db.prepare(
        `SELECT DISTINCT pa.id, pa.player1_id, pa.player2_id FROM pairs pa
         WHERE pa.status IN ('pending', 'active') AND (pa.player1_id = ? OR pa.player2_id = ?)`);
      const lv = db.prepare('SELECT level FROM players WHERE id = ?');
      const setAvg = db.prepare('UPDATE pairs SET level_avg = ? WHERE id = ?');
      const seen = new Set();
      for (const id of targets) {
        for (const pr of pairOf.all(id, id)) {
          if (seen.has(pr.id)) continue;
          seen.add(pr.id);
          const avg = Math.round(((lv.get(pr.player1_id).level + lv.get(pr.player2_id).level) / 2) * 100) / 100;
          setAvg.run(avg, pr.id);
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error('nivel', e); }
  }
  res.redirect('/admin/inscripciones/' + req.params.id);
});

router.get('/inscripciones.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT p.id, p.code, p.category, p.status, p.created_at,
            p1.name n1, p1.email e1, p1.phone t1, p1.level l1, p1.paid paid1, p1.shirt s1, p1.shirt_size ts1,
            p1.member_no m1, p1.member_verified mv1,
            p2.name n2, p2.email e2, p2.phone t2, p2.level l2, p2.paid paid2, p2.shirt s2, p2.shirt_size ts2,
            p2.member_no m2, p2.member_verified mv2
     FROM pairs p JOIN players p1 ON p1.id = p.player1_id JOIN players p2 ON p2.id = p.player2_id
     ORDER BY p.id`
  ).all();
  const questions = db.prepare('SELECT id, label FROM custom_questions ORDER BY position, id').all();
  const head = ['id', 'codigo', 'categoria', 'estado', 'fecha', 'jugador1', 'email1', 'tlf1', 'nivel1', 'pagado1', 'socio1', 'socio_verificado1', 'precio_esperado1', 'camiseta1', 'talla1',
    'jugador2', 'email2', 'tlf2', 'nivel2', 'pagado2', 'socio2', 'socio_verificado2', 'precio_esperado2', 'camiseta2', 'talla2', ...questions.map(q => q.label)];
  // Evita inyección de fórmulas al abrir el CSV en Excel: las celdas que
  // empiezan por = + - @ se prefijan con una comilla simple.
  const csvSafe = (v) => {
    const s = String(v ?? '');
    return /^[=+\-@]/.test(s) ? `'${s}` : s;
  };
  const esc = (v) => `"${csvSafe(v).replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(';')];
  // El precio de cada persona aparece solo en su primera pareja del CSV: en las
  // siguientes líneas sale 0,00 para que no parezca que hay que pagarlo dos veces.
  const seenPhones = new Set();
  const expPrice = (r, side) => {
    if (r.status === 'rejected') return '0,00';
    const phone = side === 1 ? r.t1 : r.t2;
    const ph = L.normPhone(phone);
    if (seenPhones.has(ph)) return '0,00';
    seenPhones.add(ph);
    return L.priceForModalities(getSetting, L.personCategories(db, phone).length).toFixed(2).replace('.', ',');
  };
  for (const r of rows) {
    const ans = Object.fromEntries(db.prepare('SELECT question_id, answer FROM registration_answers WHERE pair_id = ?').all(r.id).map(a => [a.question_id, a.answer]));
    lines.push([r.id, r.code, r.category, r.status, r.created_at, r.n1, r.e1, r.t1, r.l1, r.paid1, r.m1, r.mv1 ? 'sí' : 'no', expPrice(r, 1), r.s1, r.ts1,
      r.n2, r.e2, r.t2, r.l2, r.paid2, r.m2, r.mv2 ? 'sí' : 'no', expPrice(r, 2), r.s2, r.ts2, ...questions.map(q => ans[q.id] || '')].map(esc).join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="inscripciones.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

const csvSafe = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};
const csvEsc = (v) => `"${csvSafe(v).replace(/"/g, '""')}"`;

// Exportar parejas (respeta el filtro de categoría)
router.get('/export/parejas', (req, res) => {
  const category = L.CATEGORY_CODES.includes(req.query.category) ? req.query.category : 'all';
  const params = [];
  let sql = `SELECT p.code, p.category, p.status, p.level_avg,
                    p1.name n1, p1.phone t1, p1.email e1, p2.name n2, p2.phone t2, p2.email e2
             FROM pairs p JOIN players p1 ON p1.id = p.player1_id JOIN players p2 ON p2.id = p.player2_id`;
  if (category !== 'all') { sql += ' WHERE p.category = ?'; params.push(category); }
  sql += ' ORDER BY p.level_avg DESC, p.category, p.id';
  const rows = db.prepare(sql).all(...params);
  const lines = [['codigo', 'categoria', 'estado', 'nivel_medio', 'jugador1', 'telefono1', 'email1',
    'jugador2', 'telefono2', 'email2'].map(csvEsc).join(';')];
  for (const r of rows) lines.push([r.code, r.category, r.status, r.level_avg, r.n1, r.t1, r.e1, r.n2, r.t2, r.e2].map(csvEsc).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="parejas${category === 'all' ? '' : '-' + category}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

// Exportar clasificación de una ronda y categoría
router.get('/export/clasificacion', (req, res) => {
  const category = L.validCategory(req.query.category);
  const round = Math.min(3, Math.max(1, parseInt(req.query.round) || 1));
  const lines = [['categoria', 'ronda', 'grupo', 'posicion', 'pareja', 'puntos', 'partidos',
    'ganados', 'perdidos', 'sets_favor', 'sets_contra', 'juegos_favor', 'juegos_contra'].map(csvEsc).join(';')];
  for (const g of L.getGroups(db, category, round)) {
    const members = L.getGroupMembers(db, g.id);
    const matches = L.getGroupMatches(db, g.id);
    for (const s of L.computeStandings(members.map(x => x.pair_id), matches)) {
      lines.push([category, round, g.group_no, s.position, L.pairName(db, s.pairId), s.pts, s.pj, s.pg, s.pp,
        s.setsW, s.setsL, s.gamesW, s.gamesL].map(csvEsc).join(';'));
    }
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="clasificacion-${category}-r${round}.csv"`);
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
  db.prepare("DELETE FROM custom_questions WHERE id = ? AND sys_key = ''").run(req.params.id);
  res.redirect('/admin/preguntas');
});
router.post('/preguntas/:id/toggle', (req, res) => {
  db.prepare('UPDATE custom_questions SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/preguntas');
});

// ================= PAREJAS =================
router.get('/parejas', (req, res) => {
  const category = L.CATEGORY_CODES.includes(req.query.category) ? req.query.category : 'all';
  const params = [];
  let sql = `SELECT p.*, p1.name n1, p2.name n2 FROM pairs p
     JOIN players p1 ON p1.id = p.player1_id JOIN players p2 ON p2.id = p.player2_id`;
  if (category !== 'all') { sql += ' WHERE p.category = ?'; params.push(category); }
  sql += ' ORDER BY p.level_avg DESC, p.category, p.status, p.id';
  const rows = db.prepare(sql).all(...params);
  res.renderPage('admin/parejas', { rows, category });
});

router.get('/parejas/nueva', (req, res) => {
  res.renderPage('admin/pareja-nueva', { error: null, brackets: L.PLAYTOMIC_BRACKETS });
});

router.post('/parejas/nueva', (req, res) => {
  const b = req.body;
  const err = (msg) => res.renderPage('admin/pareja-nueva', { error: msg, brackets: L.PLAYTOMIC_BRACKETS });
  const category = L.validCategory(b.category);
  const mk = (n) => ({
    name: (b[`p${n}_name`] || '').trim(), email: (b[`p${n}_email`] || '').trim(),
    phone: (b[`p${n}_phone`] || '').trim(), level: parseFloat(b[`p${n}_level`]),
    gender: (b[`p${n}_gender`] || '').toUpperCase(),
    member_no: (b[`p${n}_member`] || '').trim(),
  });
  const p1 = mk(1), p2 = mk(2);
  if (!p1.name || !p2.name) return err('Faltan nombres.');
  if (!p1.phone || !p2.phone) return err('El teléfono es obligatorio (identifica al jugador entre modalidades).');
  if (!p1.member_no || !p2.member_no) return err('El nº de socio del club es obligatorio (solo pueden jugar los socios).');
  if (!L.validSpanishMobile(p1.phone) || !L.validSpanishMobile(p2.phone))
    return err('Algún teléfono no parece un móvil válido (9 dígitos, empieza por 6 o 7): revísalo por favor.');
  if (L.normPhone(p1.phone) === L.normPhone(p2.phone)) return err('Los dos jugadores no pueden tener el mismo teléfono.');
  for (const [p, n] of [[p1, 1], [p2, 2]]) {
    if (!(p.level >= 0 && p.level <= 6)) return err(`Nivel del jugador ${n} no válido.`);
    if (!['M', 'F'].includes(p.gender)) return err(`Indica el sexo del jugador ${n}.`);
    const existing = L.personCategories(db, p.phone);
    if (existing.includes(category)) return err(`${p.name} ya está inscrito en ${L.catName(category).toLowerCase()}: no puede inscribirse dos veces en la misma modalidad.`);
    const allCats = [...new Set([...existing, category])];
    if (allCats.length > 2) return err(`${p.name} ya está inscrito en dos modalidades.`);
    if (!L.validModalityCombo(allCats)) return err(`${p.name} no puede combinar las modalidades masculina y femenina: solo se permite masculina + mixta o femenina + mixta.`);
  }
  if (category === 'X' && p1.gender === p2.gender) return err('En la categoría mixta la pareja debe estar formada por un hombre y una mujer.');
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code; do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (db.prepare('SELECT 1 FROM pairs WHERE code = ?').get(code));
  // Si el nº de socio ya está verificado, se hereda; si no, la pareja queda
  // pendiente hasta que recepción lo verifique.
  const verifiedMembers = new Set(
    db.prepare('SELECT member_no FROM players WHERE member_verified = 1').all()
      .map(r => L.memberNoKey(r.member_no))
  );
  const v1 = verifiedMembers.has(L.memberNoKey(p1.member_no)) ? 1 : 0;
  const v2 = verifiedMembers.has(L.memberNoKey(p2.member_no)) ? 1 : 0;
  const status = (v1 && v2) ? 'active' : 'pending';
  const ins = db.prepare('INSERT INTO players(name, email, phone, level, gender, paid, member_no, member_verified) VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
  const r1 = ins.run(p1.name, p1.email, p1.phone, p1.level, p1.gender, b.p1_paid ? 1 : 0, p1.member_no, v1);
  const r2 = ins.run(p2.name, p2.email, p2.phone, p2.level, p2.gender, b.p2_paid ? 1 : 0, p2.member_no, v2);
  const avg = Math.round(((p1.level + p2.level) / 2) * 100) / 100;
  db.prepare(`INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, level_avg, status)
              VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run(code, category, Number(r1.lastInsertRowid), Number(r2.lastInsertRowid),
      Number(r1.lastInsertRowid), avg, status);
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

// Eliminar los grupos de una ronda/categoría para volver a generarlos (sin resultados)
router.post('/grupos/reiniciar', (req, res) => {
  const category = L.validCategory(req.body.category);
  const round = Math.min(3, Math.max(1, parseInt(req.body.round) || 1));
  const back = `/admin/grupos?category=${category}&round=${round}`;
  if (getSetting(`round${round}_closed`, '0') === '1') {
    return res.redirect(back + '&error=' + encodeURIComponent('La ronda está cerrada: no se pueden eliminar sus grupos.'));
  }
  const gids = L.getGroups(db, category, round).map(g => g.id);
  if (gids.length) {
    const ph = gids.map(() => '?').join(',');
    const played = db.prepare(
      `SELECT COUNT(*) c FROM matches WHERE group_id IN (${ph}) AND (winner_id IS NOT NULL OR wo_winner_id IS NOT NULL OR unplayed = 1)`
    ).get(...gids).c;
    if (played) {
      return res.redirect(back + '&error=' + encodeURIComponent('Ya hay partidos con resultado: no se pueden eliminar los grupos.'));
    }
    db.prepare(`DELETE FROM matches WHERE group_id IN (${ph})`).run(...gids);
    db.prepare(`DELETE FROM group_members WHERE group_id IN (${ph})`).run(...gids);
    db.prepare(`DELETE FROM groups WHERE id IN (${ph})`).run(...gids);
  }
  res.redirect(back);
});

// ================= PARTIDOS =================
router.get('/partidos', (req, res) => {
  const category = L.validCategory(req.query.category);
  const stage = req.query.stage === 'po' ? 'po' : 'groups';
  const courts = db.prepare('SELECT * FROM courts WHERE active = 1 ORDER BY name').all();
  const common = { category, stage, courts, error: req.query.error || null, pairName: (id) => L.pairName(db, id) };
  let matches, blocks = [], block = 'all';
  if (stage === 'groups') {
    const round = Math.min(3, Math.max(1, parseInt(req.query.round) || 1));
    matches = db.prepare(
      `SELECT m.*, g.group_no, g.round_no, c.name AS court_name, pa.availability AS avail_a, pb.availability AS avail_b
       FROM matches m
       LEFT JOIN groups g ON g.id = m.group_id LEFT JOIN courts c ON c.id = m.court_id
       LEFT JOIN pairs pa ON pa.id = m.pair_a_id LEFT JOIN pairs pb ON pb.id = m.pair_b_id
       WHERE m.stage = 'groups' AND m.category = ? AND m.round_no = ? ORDER BY g.group_no, m.id`
    ).all(category, round);
    const unscheduled = matches.filter(m => !m.court_id || !m.scheduled_at).length;
    res.renderPage('admin/partidos', { ...common, round, matches, blocks, block, unscheduled });
  } else {
    blocks = db.prepare(`SELECT DISTINCT stage FROM matches WHERE stage LIKE 'po%' AND category = ? ORDER BY stage`)
      .all(category).map(r => r.stage);
    if (blocks.includes(req.query.block)) block = req.query.block;
    const params = [category];
    let sql = `SELECT m.*, c.name AS court_name, pa.availability AS avail_a, pb.availability AS avail_b
       FROM matches m LEFT JOIN courts c ON c.id = m.court_id
       LEFT JOIN pairs pa ON pa.id = m.pair_a_id LEFT JOIN pairs pb ON pb.id = m.pair_b_id
       WHERE m.stage LIKE 'po%' AND m.category = ?`;
    if (block !== 'all') { sql += ' AND m.stage = ?'; params.push(block); }
    sql += ` ORDER BY m.stage, CASE m.bracket_round WHEN 'R32' THEN 0 WHEN 'R16' THEN 1 WHEN 'QF' THEN 2 WHEN 'SF' THEN 3 WHEN 'F' THEN 4 ELSE 9 END, m.bracket_slot`;
    matches = db.prepare(sql).all(...params);
    const unscheduled = matches.filter(m => !m.court_id || !m.scheduled_at).length;
    res.renderPage('admin/partidos', { ...common, round: null, matches, blocks, block, unscheduled });
  }
});

// Introducir / corregir un resultado manualmente
router.post('/partidos/:id/resultado', (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return res.redirect('/admin');
  if (L.matchStageClosed(getSetting, m)) {
    return res.redirect((req.body.back || '/admin/partidos') + '&error=' + encodeURIComponent('La fase está cerrada: reábrela para corregir resultados.'));
  }
  const b = req.body;
  const num = (v) => (v === '' || v == null ? null : parseInt(v, 10));
  const winner = parseInt(b.winner_id, 10);
  if (![m.pair_a_id, m.pair_b_id].includes(winner) && !b.unplayed && !b.wo) return res.redirect('/admin/partidos');
  const wo = !!b.wo;
  const unplayed = !!b.unplayed;
  db.prepare(`UPDATE matches SET s1a=?, s1b=?, s2a=?, s2b=?, stb_a=?, stb_b=?,
              winner_id=?, wo_winner_id=?, unplayed=?, submitted_by=NULL,
              validation = CASE WHEN ? = 1 THEN 'none' ELSE 'validated' END,
              validation_deadline = NULL, notes = ? WHERE id = ?`)
    .run(num(b.s1a), num(b.s1b), num(b.s2a), num(b.s2b), num(b.stb_a), num(b.stb_b),
      unplayed ? null : winner, wo ? winner : null, unplayed ? 1 : 0, unplayed ? 1 : 0,
      (b.notes || '').trim(), m.id);
  const upd = db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id);
  advanceWinner(upd);
  res.redirect(req.body.back || '/admin/partidos');
});

// Resolver una disputa a favor del resultado subido
router.post('/partidos/:id/resolver', (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  const back = req.body.back || '/admin';
  if (m && L.matchStageClosed(getSetting, m)) {
    return res.redirect(back + '&error=' + encodeURIComponent('La fase está cerrada: reábrela para resolver disputas.'));
  }
  if (m && m.validation === 'disputed') {
    db.prepare("UPDATE matches SET validation = 'validated' WHERE id = ?").run(m.id);
    advanceWinner(db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id));
  }
  res.redirect(back);
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
          return { ...s, delta, target: Math.min(total, Math.max(1, g.group_no - delta)), points: L.roundPoints(g.group_no, s.position) };
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
          const target = Math.min(total, Math.max(1, g.group_no - delta));
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
// Categorías del playoff: grupos de 16 del ranking (ver splitPlayoffCategories).
// Las exclusiones se aplican ANTES de dividir en bloques: las parejas
// excluidas salen del ranking y las siguientes ascienden de categoría.
function playoffStages(category) {
  const ranking = L.getRanking(db, category).map(r => r.pair_id);
  const excluded = excludedPairs(category);
  const playing = ranking.filter(id => !excluded.has(id));
  const { cats, unused } = L.splitPlayoffCategories(playing);
  return {
    stages: cats.map((ids, i) => ({ stage: `po${i + 1}`, ids })),
    unused,
    excluded: ranking.filter(id => excluded.has(id)),
  };
}
function excludedPairs(category) {
  return new Set(
    db.prepare('SELECT pair_id FROM playoff_excluded WHERE category = ?').all(category).map(r => r.pair_id)
  );
}
// Orden de sembrado: el guardado manualmente o, por defecto, el ranking
// (ya sin las parejas excluidas).
function playoffOrder(category, stage) {
  const st = playoffStages(category).stages.find(s => s.stage === stage);
  const base = st ? st.ids : [];
  const saved = db.prepare('SELECT pair_id FROM playoff_seeding WHERE category = ? AND stage = ? ORDER BY pos')
    .all(category, stage).map(r => r.pair_id);
  if (!saved.length) return base;
  const inBase = new Set(base);
  const ordered = saved.filter(id => inBase.has(id));
  for (const id of base) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}
function playoffHasResults(category) {
  return db.prepare(
    `SELECT COUNT(*) c FROM matches WHERE stage LIKE 'po%' AND category = ?
     AND (winner_id IS NOT NULL OR wo_winner_id IS NOT NULL)`
  ).get(category).c > 0;
}
// ¿Hay resultados "reales" (no byes automáticos) en este cuadro?
function playoffHasRealResults(category, stage) {
  return db.prepare(
    `SELECT COUNT(*) c FROM matches WHERE stage = ? AND category = ?
     AND (unplayed = 1 OR wo_winner_id IS NOT NULL OR validation IN ('pending', 'disputed', 'validated'))`
  ).get(stage, category).c > 0;
}
// Los byes solo existen en la primera ronda: avanzan solos a la siguiente.
// (Un cruce de rondas posteriores con un lado vacío está esperando rival, no es bye.)
function cascadeByes(category, stage) {
  const first = db.prepare(`
    SELECT bracket_round br FROM matches WHERE category = ? AND stage = ?
    ORDER BY ${ROUND_ORDER_CASE} LIMIT 1
  `).get(category, stage);
  if (!first) return;
  const ms = db.prepare(
    `SELECT * FROM matches WHERE category = ? AND stage = ? AND bracket_round = ?
     AND winner_id IS NULL AND wo_winner_id IS NULL AND unplayed = 0
     AND ((pair_a_id IS NOT NULL AND pair_b_id IS NULL) OR (pair_a_id IS NULL AND pair_b_id IS NOT NULL))`
  ).all(category, stage, first.br);
  for (const m of ms) {
    const w = m.pair_a_id || m.pair_b_id;
    db.prepare("UPDATE matches SET winner_id = ?, validation = 'auto' WHERE id = ?").run(w, m.id);
    const next = L.BRACKET_NEXT[m.bracket_round];
    if (next) {
      const slot = Math.floor(m.bracket_slot / 2);
      const col = m.bracket_slot % 2 === 0 ? 'pair_a_id' : 'pair_b_id';
      const nm = db.prepare(
        'SELECT * FROM matches WHERE stage = ? AND category = ? AND bracket_round = ? AND bracket_slot = ?'
      ).get(stage, category, next, slot);
      if (nm && !nm[col]) db.prepare(`UPDATE matches SET ${col} = ? WHERE id = ?`).run(w, nm.id);
    }
  }
}
const ROUND_ORDER_CASE = `CASE bracket_round WHEN 'R32' THEN 0 WHEN 'R16' THEN 1 WHEN 'QF' THEN 2 WHEN 'SF' THEN 3 WHEN 'F' THEN 4 ELSE 9 END`;
function firstRoundMatches(category, stage) {
  const ms = db.prepare(
    `SELECT * FROM matches WHERE category = ? AND stage = ? ORDER BY ${ROUND_ORDER_CASE}, bracket_slot`
  ).all(category, stage);
  if (!ms.length) return [];
  const firstCode = ms[0].bracket_round;
  return ms.filter(m => m.bracket_round === firstCode);
}

router.get('/playoffs', (req, res) => {
  const data = L.CATEGORY_CODES.map(category => {
    const pg = playoffStages(category);
    const sd = pg.stages.map(({ stage, ids }) => {
      const order = playoffOrder(category, stage);
      const size = L.nextPowerOfTwo(Math.max(order.length, 2));
      const seeds = Math.min(size >= 16 ? 4 : 2, order.length);
      return {
        stage, ordinal: L.playoffOrdinal(stage), ids: order,
        seeds, hasRealResults: playoffHasRealResults(category, stage),
        firstRound: firstRoundMatches(category, stage),
      };
    });
    return {
      category, stages: sd, unused: pg.unused, excluded: pg.excluded,
      generated: getSetting('playoffs_generated', '0') === '1',
      round3closed: getSetting('round3_closed', '0') === '1',
      hasResults: playoffHasResults(category),
      pairName: (id) => L.pairName(db, id),
    };
  });
  res.renderPage('admin/playoffs', { data, error: req.query.error || null, ok: req.query.ok || null,
    playoffsClosed: getSetting('playoffs_closed', '0') === '1' });
});
function savePlayoffOrder(category, stage, ids) {
  const del = db.prepare('DELETE FROM playoff_seeding WHERE category = ? AND stage = ?');
  const ins = db.prepare('INSERT INTO playoff_seeding(category, stage, pair_id, pos) VALUES(?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    del.run(category, stage);
    ids.forEach((id, i) => ins.run(category, stage, id, i));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Mover una pareja en el orden de sembrado (antes de generar el cuadro)
router.post('/playoffs/orden', (req, res) => {
  const category = L.validCategory(req.body.category);
  const stage = /^po\d+$/.test(req.body.stage) ? req.body.stage : 'po1';
  const pairId = parseInt(req.body.pair_id, 10);
  const dir = req.body.dir === 'down' ? 1 : -1;
  const ids = playoffOrder(category, stage);
  const i = ids.indexOf(pairId);
  const j = i + dir;
  if (i >= 0 && j >= 0 && j < ids.length) {
    [ids[i], ids[j]] = [ids[j], ids[i]];
    savePlayoffOrder(category, stage, ids);
  }
  res.redirect('/admin/playoffs');
});

// Cerrar / reabrir los playoffs (bloquea la entrada de resultados)
router.post('/playoffs/cierre', (req, res) => {
  const closed = getSetting('playoffs_closed', '0') === '1';
  setSetting('playoffs_closed', closed ? '0' : '1');
  res.redirect('/admin/playoffs?ok=' + encodeURIComponent(closed ? 'Playoffs reabiertos.' : 'Playoffs cerrados: ya no se admiten resultados.'));
});

// Marcar una pareja como "no juega el playoff" (antes de generar)
router.post('/playoffs/excluir', (req, res) => {
  const category = L.validCategory(req.body.category);
  const pairId = parseInt(req.body.pair_id, 10);
  if (playoffHasResults(category)) return res.redirect('/admin/playoffs');
  const has = db.prepare('SELECT 1 FROM playoff_excluded WHERE category = ? AND pair_id = ?').get(category, pairId);
  if (has) db.prepare('DELETE FROM playoff_excluded WHERE category = ? AND pair_id = ?').run(category, pairId);
  else db.prepare('INSERT INTO playoff_excluded(category, pair_id) VALUES(?, ?)').run(category, pairId);
  res.redirect('/admin/playoffs');
});

router.post('/playoffs/generar', (req, res) => {
  const category = L.validCategory(req.body.category);
  if (getSetting('round3_closed', '0') !== '1') return res.redirect('/admin/playoffs');
  // Regenerar solo si no hay resultados en los cuadros de esta categoría
  if (playoffHasResults(category)) return res.redirect('/admin/playoffs');
  db.prepare(`DELETE FROM matches WHERE stage LIKE 'po%' AND category = ?`).run(category);

  const ins = db.prepare(`INSERT INTO matches(category, stage, bracket_round, bracket_slot, pair_a_id, pair_b_id, seed_a, seed_b)
                          VALUES(?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const { stage } of playoffStages(category).stages) {
    const playing = playoffOrder(category, stage);
    if (playing.length < 2) continue;
    const draw34 = L.drawSeeds34();
    const rounds = L.buildBracket(playing, draw34);
    rounds.forEach((round, ri) => {
      for (const mt of round.matches) {
        ins.run(category, stage, round.code, mt.slot, mt.a, mt.b,
          ri === 0 ? mt.seedA : null, ri === 0 ? mt.seedB : null);
      }
    });
    cascadeByes(category, stage);
  }
  setSetting('playoffs_generated', '1');
  res.redirect('/admin/playoffs');
});

// Intercambiar parejas dentro del cuadro ya generado (solo 1ª ronda y sin resultados reales)
router.post('/playoffs/intercambiar', (req, res) => {
  const category = L.validCategory(req.body.category);
  const stage = req.body.stage;
  const back = '/admin/playoffs';
  const err = (msg) => res.redirect(back + '?error=' + encodeURIComponent(msg));
  if (!/^po\d+$/.test(stage || '')) return res.redirect(back);
  if (playoffHasRealResults(category, stage)) return err('No se puede intercambiar: el cuadro ya tiene resultados.');
  const first = firstRoundMatches(category, stage);
  if (!first.length) return res.redirect(back);

  const current = [];
  for (const m of first) { current.push(m.pair_a_id); current.push(m.pair_b_id); }
  const next = [];
  const updates = [];
  for (const m of first) {
    const na = req.body[`a_${m.id}`] ? parseInt(req.body[`a_${m.id}`], 10) : null;
    const nb = req.body[`b_${m.id}`] ? parseInt(req.body[`b_${m.id}`], 10) : null;
    next.push(na); next.push(nb);
    updates.push({ id: m.id, na, nb });
  }
  // Debe ser una reordenación de las mismas parejas (sin duplicados ni intrusos)
  const playing = new Set(playoffOrder(category, stage));
  const norm = (arr) => arr.filter(x => x != null).sort((x, y) => x - y).join(',');
  if (norm(current) !== norm(next)) return err('El intercambio debe mantener las mismas parejas, sin duplicar.');
  if (next.some(x => x != null && !playing.has(x))) return err('Hay parejas no válidas en el intercambio.');

  // Las etiquetas de cabeza de serie viajan con la pareja, no se quedan a NULL.
  const seedOf = {};
  for (const m of first) {
    if (m.pair_a_id != null) seedOf[m.pair_a_id] = m.seed_a;
    if (m.pair_b_id != null) seedOf[m.pair_b_id] = m.seed_b;
  }
  const clearResult = `s1a=NULL, s1b=NULL, s2a=NULL, s2b=NULL, s3a=NULL, s3b=NULL, stb_a=NULL, stb_b=NULL,
    winner_id=NULL, wo_winner_id=NULL, unplayed=0, submitted_by=NULL, submitted_at=NULL,
    validation='none', validation_deadline=NULL, notes=''`;
  db.exec('BEGIN');
  try {
    const up1 = db.prepare(`UPDATE matches SET pair_a_id = ?, pair_b_id = ?, seed_a = ?, seed_b = ?, ${clearResult} WHERE id = ?`);
    for (const u of updates) up1.run(u.na, u.nb,
      u.na != null ? (seedOf[u.na] ?? null) : null,
      u.nb != null ? (seedOf[u.nb] ?? null) : null, u.id);
    // Vaciar las rondas siguientes (solo podían tener avances automáticos de byes)
    db.prepare(`UPDATE matches SET pair_a_id = NULL, pair_b_id = NULL, seed_a = NULL, seed_b = NULL, ${clearResult}
                WHERE category = ? AND stage = ? AND bracket_round != ?`)
      .run(category, stage, first[0].bracket_round);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return err('No se pudo aplicar el intercambio.');
  }
  cascadeByes(category, stage);
  res.redirect(back + '?ok=' + encodeURIComponent('Cuadro actualizado.'));
});


// ================= TEMPORADAS =================
router.get('/temporadas', (req, res) => {
  res.renderPage('admin/temporadas', { seasons: listSeasons(), active: getActiveSeason() });
});
router.post('/temporadas/crear', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) createSeason(name);
  res.redirect('/admin/temporadas');
});
router.post('/temporadas/:id/activar', (req, res) => {
  activateSeason(Number(req.params.id));
  res.redirect('/admin/temporadas');
});
router.post('/temporadas/:id/renombrar', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) renameSeason(Number(req.params.id), name);
  res.redirect('/admin/temporadas');
});
router.post('/temporadas/:id/eliminar', (req, res) => {
  deleteSeason(Number(req.params.id));
  res.redirect('/admin/temporadas');
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
    const verifiedMembers = new Set(
      db.prepare('SELECT member_no FROM players WHERE member_verified = 1').all()
        .map(r => L.memberNoKey(r.member_no))
    );
    const mv = verifiedMembers.has(L.memberNoKey(c.new_member_no)) ? 1 : 0;
    const r = db.prepare('INSERT INTO players(name, email, phone, level, gender, member_no, member_verified) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(c.new_name, c.new_email, c.new_phone, c.new_level, c.new_gender || 'M', c.new_member_no || '', mv);
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

// ================= PISTAS =================
function listCourts() {
  return db.prepare('SELECT * FROM courts ORDER BY active DESC, name').all();
}
router.get('/pistas', (req, res) => {
  res.renderPage('admin/pistas', {
    courts: listCourts(),
    duration: getSetting('match_duration_min', '90'),
    error: req.query.error || null, ok: req.query.ok || null,
  });
});
router.post('/pistas/crear', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin/pistas?error=' + encodeURIComponent('Ponle un nombre a la pista.'));
  db.prepare('INSERT INTO courts(name) VALUES(?)').run(name);
  res.redirect('/admin/pistas?ok=' + encodeURIComponent('Pista creada.'));
});
router.post('/pistas/:id/toggle', (req, res) => {
  db.prepare('UPDATE courts SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/pistas');
});
router.post('/pistas/:id/eliminar', (req, res) => {
  db.prepare('DELETE FROM courts WHERE id = ?').run(req.params.id);
  res.redirect('/admin/pistas');
});
router.post('/pistas/duracion', (req, res) => {
  const d = Math.min(240, Math.max(30, parseInt(req.body.duration) || 90));
  setSetting('match_duration_min', String(d));
  res.redirect('/admin/pistas?ok=' + encodeURIComponent('Duración guardada.'));
});

// Asignar pista + día + hora a un partido (con control de solapes)
router.post('/partidos/:id/horario', (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return res.redirect('/admin');
  const back = req.body.back || '/admin/partidos';
  const err = (msg) => res.redirect(back + (back.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(msg));
  const courtId = req.body.court_id ? parseInt(req.body.court_id, 10) : null;
  const day = (req.body.day || '').trim(), time = (req.body.time || '').trim();
  if (!courtId && !day && !time) {
    db.prepare('UPDATE matches SET court_id = NULL, scheduled_at = NULL WHERE id = ?').run(m.id);
    return res.redirect(back);
  }
  if (!courtId || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time))
    return err('Para programar un partido hacen falta pista, día y hora.');
  const court = db.prepare("SELECT * FROM courts WHERE id = ? AND active = 1").get(courtId);
  if (!court) return err('La pista no existe o está desactivada.');
  const start = `${day}T${time}`;
  const dur = parseInt(getSetting('match_duration_min', '90'), 10) || 90;
  // ¿Se solapa con otro partido de la misma pista?
  const clash = db.prepare(
    `SELECT m2.id FROM matches m2
     WHERE m2.court_id = ? AND m2.id != ? AND m2.unplayed = 0 AND m2.scheduled_at IS NOT NULL
       AND substr(m2.scheduled_at, 1, 10) = ?
       AND datetime(m2.scheduled_at) < datetime(?, '+' || ? || ' minutes')
       AND datetime(m2.scheduled_at, '+' || ? || ' minutes') > datetime(?)
     LIMIT 1`
  ).get(courtId, m.id, day, start, dur, dur, start);
  if (clash) return err(`Esa pista ya está ocupada en ese tramo (partido #${clash.id}). Elige otra pista u otra hora.`);
  db.prepare('UPDATE matches SET court_id = ?, scheduled_at = ? WHERE id = ?').run(courtId, start, m.id);
  res.redirect(back);
});

// ================= CUADRANTE =================
router.get('/cuadrante', (req, res) => {
  const today = new Date();
  const def = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '') ? req.query.fecha : def;
  const courts = db.prepare('SELECT * FROM courts WHERE active = 1 ORDER BY name').all();
  const dur = parseInt(getSetting('match_duration_min', '90'), 10) || 90;
  const matches = db.prepare(
    `SELECT m.*, c.name AS court_name, g.group_no, g.round_no AS gr FROM matches m
     LEFT JOIN courts c ON c.id = m.court_id LEFT JOIN groups g ON g.id = m.group_id
     WHERE m.court_id IS NOT NULL AND m.scheduled_at IS NOT NULL AND substr(m.scheduled_at, 1, 10) = ? AND m.unplayed = 0
     ORDER BY m.court_id, m.scheduled_at`
  ).all(day);
  // Rejilla: franjas de 30 min de 08:00 a 23:00
  const slots = [];
  for (let h = 8; h < 23; h++) { slots.push(`${String(h).padStart(2, '0')}:00`); slots.push(`${String(h).padStart(2, '0')}:30`); }
  const grid = courts.map(c => {
    const ms = matches.filter(x => x.court_id === c.id);
    const cells = new Array(slots.length).fill(null);
    const skip = new Array(slots.length).fill(false);
    for (const mt of ms) {
      const t = mt.scheduled_at.slice(11, 16);
      let i0 = slots.indexOf(t);
      if (i0 < 0) { // redondea al slot anterior
        i0 = slots.findIndex(s => s > t) - 1;
        if (i0 < 0) i0 = 0;
      }
      const span = Math.max(1, Math.ceil(dur / 30));
      if (cells[i0]) mt.clash = true; else { cells[i0] = { m: mt, span }; for (let k = 1; k < span && i0 + k < slots.length; k++) skip[i0 + k] = true; }
    }
    return { court: c, cells, skip };
  });
  const unscheduled = db.prepare(
    `SELECT COUNT(*) c FROM matches WHERE (court_id IS NULL OR scheduled_at IS NULL) AND unplayed = 0 AND winner_id IS NULL AND wo_winner_id IS NULL`
  ).get().c;
  res.renderPage('admin/cuadrante', { day, courts, slots, grid, unscheduled, pairName: (id) => L.pairName(db, id) });
});

// ================= AJUSTES =================
router.get('/ajustes', (req, res) => {
  const keys = ['club_name', 'season_name', 'phase_insc_label', 'phase_insc_ini', 'phase_insc_fin',
    'phase_r1_label', 'phase_r1_ini', 'phase_r1_fin', 'phase_r2_label', 'phase_r2_ini', 'phase_r2_fin',
    'phase_r3_label', 'phase_r3_ini', 'phase_r3_fin', 'phase_po_label', 'phase_po_ini', 'phase_po_fin',
    'inscription_price', 'inscription_price_2', 'shirt_price', 'registration_closed'];
  const s = Object.fromEntries(keys.map(k => [k, getSetting(k, '')]));
  res.renderPage('admin/ajustes', { s, msg: req.query.msg || null, receptionSet: !!getReceptionHash() });
});

router.post('/ajustes', (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    if (k.startsWith('phase_') || ['club_name', 'season_name', 'inscription_price', 'inscription_price_2', 'shirt_price'].includes(k)) {
      setSetting(k, (v || '').trim());
    }
  }
  // Checkbox: solo llega cuando está marcado
  setSetting('registration_closed', req.body.registration_closed ? '1' : '0');
  res.redirect('/admin/ajustes?msg=' + encodeURIComponent('Ajustes guardados.'));
});

router.post('/ajustes/password', (req, res) => {
  const pw = (req.body.password || '').trim();
  if (pw.length < 6) return res.redirect('/admin/ajustes?msg=' + encodeURIComponent('La contraseña debe tener al menos 6 caracteres.'));
  setAdminHash(bcrypt.hashSync(pw, 10));
  res.redirect('/admin/ajustes?msg=' + encodeURIComponent('Contraseña actualizada.'));
});

router.post('/ajustes/recepcion-password', (req, res) => {
  const pw = (req.body.password || '').trim();
  if (pw.length < 6) return res.redirect('/admin/ajustes?msg=' + encodeURIComponent('La contraseña debe tener al menos 6 caracteres.'));
  setReceptionHash(bcrypt.hashSync(pw, 10));
  res.redirect('/admin/ajustes?msg=' + encodeURIComponent('Acceso de recepción configurado: entra en /recepcion.'));
});

module.exports = router;
