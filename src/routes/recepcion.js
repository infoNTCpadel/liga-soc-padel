// Recepción: acceso limitado solo a la verificación de nº de socio.
// No puede entrar a /admin ni a ninguna otra sección.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getReceptionHash } = require('../db');

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
  if (okRow) db.prepare('UPDATE players SET member_verified = ? WHERE id = ?').run(v, playerId);
  const f = req.body.f === 'verificados' ? 'verificados' : 'pendientes';
  res.redirect('/recepcion?f=' + f + (req.body.q ? '&q=' + encodeURIComponent(req.body.q) : ''));
});

module.exports = router;
