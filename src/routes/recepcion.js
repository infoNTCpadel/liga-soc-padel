// Recepción: acceso limitado a la verificación de nº de socio y al control de cobros.
// No puede entrar a /admin ni a ninguna otra sección.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSetting, getReceptionHash } = require('../db');
const L = require('../lib/league');

const router = express.Router();

function requireReception(req, res, next) {
  res.locals.section = 'recepcion';
  if (req.session.reception || req.session.admin) return next();
  if (req.path === '/login') return next();
  return res.redirect('/recepcion/login');
}
router.use(requireReception);

router.get('/login', (req, res) => {
  if (req.session.reception || req.session.admin) return res.redirect('/recepcion');
  const noPass = !getReceptionHash();
  res.renderPage('recepcion/login', {
    error: noPass ? 'Aún no hay contraseña de recepción: pídele a la organización que la configure en Ajustes.' : null,
    noPass,
  });
});
router.post('/login', (req, res) => {
  const hash = getReceptionHash();
  if (hash && bcrypt.compareSync(req.body.password || '', hash)) {
    req.session.reception = true;
    return res.redirect('/recepcion');
  }
  res.renderPage('recepcion/login', {
    error: hash ? 'Contraseña incorrecta.' : 'Aún no hay contraseña de recepción configurada.',
    noPass: !hash,
  });
});
router.post('/logout', (req, res) => {
  req.session.reception = null;
  res.redirect('/recepcion/login');
});

// Listado de jugadores pendientes de verificar (o ya verificados para revisar).
router.get('/', (req, res) => {
  const f = req.query.f === 'verificados' ? 'verificados' : 'pendientes';
  const q = (req.query.q || '').trim();
  const want = f === 'pendientes' ? 0 : 1;
  let sql = `SELECT pl.id, pl.name, pl.phone, pl.member_no, p.code, p.category, p.created_at
             FROM players pl JOIN pairs p ON pl.id = p.player1_id OR pl.id = p.player2_id
             WHERE p.status IN ('pending', 'active') AND COALESCE(pl.member_verified, 0) = ?`;
  const params = [want];
  if (q) { sql += ' AND (pl.name LIKE ? OR pl.member_no LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY p.created_at DESC';
  const rows = db.prepare(sql).all(...params);
  const pendingCount = db.prepare(
    `SELECT COUNT(*) c FROM players pl JOIN pairs p ON pl.id = p.player1_id OR pl.id = p.player2_id
     WHERE p.status IN ('pending', 'active') AND COALESCE(pl.member_verified, 0) = 0`).get().c;
  res.renderPage('recepcion/home', { rows, f, q, pendingCount });
});

router.post('/verificar', (req, res) => {
  const playerId = parseInt(req.body.player_id, 10);
  const v = req.body.verified === '1' ? 1 : 0;
  const okRow = db.prepare(
    `SELECT 1 FROM players pl JOIN pairs p ON pl.id = p.player1_id OR pl.id = p.player2_id
     WHERE pl.id = ? AND p.status IN ('pending', 'active')`).get(playerId);
  // La verificación es de la persona (su nº de socio): se propaga a todas
  // sus filas con el mismo número.
  if (okRow) L.setMemberVerified(db, playerId, v);
  const f = req.body.f === 'verificados' ? 'verificados' : 'pendientes';
  res.redirect('/recepcion?f=' + f + (req.body.q ? '&q=' + encodeURIComponent(req.body.q) : ''));
});

// ---- Cobros: una fila por persona con lo que debe pagar y el estado ----
router.get('/cobros', (req, res) => {
  const f = req.query.f === 'todos' ? 'todos' : 'pendientes';
  const q = (req.query.q || '').trim();
  const ql = q.toLowerCase();
  const rows = db.prepare(
    `SELECT pl.id, pl.name, pl.phone, pl.member_no, pl.member_verified, pl.paid, p.category
     FROM players pl JOIN pairs p ON pl.id = p.player1_id OR pl.id = p.player2_id
     WHERE p.status IN ('pending', 'active')`).all();
  const byPhone = new Map();
  for (const r of rows) {
    const ph = L.normPhone(r.phone);
    if (ph.length < 6) continue;
    if (!byPhone.has(ph)) byPhone.set(ph, { phone: r.phone, name: r.name, members: new Set(), cats: new Set(), paid: [], verified: [] });
    const g = byPhone.get(ph);
    if (r.member_no && r.member_no.trim()) g.members.add(r.member_no.trim());
    g.cats.add(r.category);
    g.paid.push(r.paid);
    g.verified.push(r.member_verified);
  }
  const eur = (v) => Number(v || 0).toFixed(2).replace('.', ',') + ' €';
  let people = [...byPhone.values()].map(g => {
    const cats = [...g.cats];
    return {
      phone: g.phone,
      name: g.name,
      members: [...g.members].join(', ') || '—',
      verified: g.verified.length > 0 && g.verified.every(v => v),
      cats: cats.map(c => L.catName(c)).join(' + '),
      expected: eur(L.priceForModalities(getSetting, cats.length)),
      paid: g.paid.length > 0 && g.paid.every(v => v),
    };
  });
  if (ql) people = people.filter(p => p.name.toLowerCase().includes(ql) || p.phone.includes(q));
  people.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const pendingCount = people.filter(p => !p.paid).length;
  if (f === 'pendientes') people = people.filter(p => !p.paid);
  res.renderPage('recepcion/cobros', { people, f, q, pendingCount });
});

router.post('/pago', (req, res) => {
  const paid = req.body.paid === '1' ? 1 : 0;
  // El pago es por persona: se aplica a todas sus parejas (mismo teléfono).
  const ids = L.personPlayerIds(db, req.body.phone || '');
  if (ids.length) {
    db.prepare(`UPDATE players SET paid = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(paid, ...ids);
  }
  const f = req.body.f === 'todos' ? 'todos' : 'pendientes';
  res.redirect('/recepcion/cobros?f=' + f + (req.body.q ? '&q=' + encodeURIComponent(req.body.q) : ''));
});

module.exports = router;
