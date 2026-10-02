// MEDIODÍA PADEL — rutas públicas (Fase A: landing, inscripción, acceso).
// Opera SOLO sobre midday.db. Las lecturas a meta.db / temporada activa son
// de solo lectura (sugerencia de nivel) y nunca escriben allí.
const express = require('express');
const router = express.Router();
const { middayDb, middayGet, metaDb, getActiveSeasonId, seasonDb } = require('../db');
const M = require('../lib/midday');

router.use((req, res, next) => {
  res.locals.section = 'midday';
  res.locals.clubName = middayGet('comp_name', 'MEDIODÍA PADEL');
  res.locals.seasonName = 'Liga de mediodía';
  res.locals.middayPairId = req.session.middayPairId || null;
  next();
});

function slots() { return M.parseSlots(middayGet('slots', '[]')); }
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function inscriptionOpen() {
  if (middayGet('inscription_open', '1') !== '1') return false;
  const deadline = middayGet('inscription_deadline', '');
  if (!deadline) return true;
  return new Date().toISOString().slice(0, 10) <= deadline;
}

// ---- Portada ----
router.get('/', (req, res) => {
  const counts = {
    approved: middayDb.prepare("SELECT COUNT(*) c FROM midday_pairs WHERE status = 'approved'").get().c,
    pending: middayDb.prepare("SELECT COUNT(*) c FROM midday_pairs WHERE status = 'pending'").get().c,
  };
  res.renderPage('midday/landing', {
    counts,
    open: inscriptionOpen(),
    deadline: fmtDate(middayGet('inscription_deadline', '')),
    slots: slots(),
    courts: middayGet('courts_midday', '4'),
  });
});

// ---- Sugerencia de nivel (solo lectura; no devuelve nombres) ----
router.get('/api/nivel-sugerido', (req, res) => {
  const s = M.suggestLevel(metaDb, seasonDb(getActiveSeasonId()), req.query.email, req.query.phone);
  res.json(s || {});
});

// ---- Inscripción ----
function levelOptions(selected) {
  const opts = [];
  for (let v = 1; v <= 7.0001; v += 0.25) {
    const n = Math.round(v * 100) / 100;
    opts.push({ value: n, label: String(n).replace('.', ','), selected: Number(selected) === n });
  }
  return opts;
}

router.get('/inscripcion', (req, res) => {
  res.renderPage('midday/inscripcion', {
    open: inscriptionOpen(),
    deadline: fmtDate(middayGet('inscription_deadline', '')),
    slots: slots(),
    weekdays: M.WEEKDAYS,
    form: {},
    levelOpts1: levelOptions(null),
    levelOpts2: levelOptions(null),
    errors: [],
    sub: 'inscripcion',
  });
});

router.post('/inscripcion', (req, res) => {
  const b = req.body || {};
  const again = (errors) => res.renderPage('midday/inscripcion', {
    open: true, deadline: fmtDate(middayGet('inscription_deadline', '')),
    slots: slots(), weekdays: M.WEEKDAYS, form: b,
    levelOpts1: levelOptions(b.p1_level), levelOpts2: levelOptions(b.p2_level),
    errors,
    sub: 'inscripcion',
  });
  if (!inscriptionOpen()) return again(['La inscripción está cerrada.']);

  const sl = slots();
  const v = M.validateInscription(b, sl);
  if (!v.ok) return again(v.errors);

  const ph1 = v.data.player1_phone, ph2 = v.data.player2_phone;
  if (M.pairExists(middayDb, ph1, ph2))
    return again(['Esta pareja ya está inscrita (mismos móviles). Si es un error, contacta con el club.']);

  let created;
  try {
    created = M.createPair(middayDb, v.data);
  } catch (e) {
    console.error('midday inscripción', e);
    return again(['Ha ocurrido un error al guardar la inscripción. Inténtalo de nuevo.']);
  }
  const pair = M.getPair(middayDb, created.id);
  res.renderPage('midday/inscripcion-ok', { pair, slots: sl });
});

// ---- Acceso de parejas ----
function requirePair(req, res, next) {
  const pair = req.session.middayPairId ? M.getPair(middayDb, req.session.middayPairId) : null;
  if (!pair) return res.redirect('/mediodia/acceso');
  res.locals.middayPair = pair;
  next();
}

router.get('/acceso', (req, res) => {
  if (req.session.middayPairId) return res.redirect('/mediodia/mis-partidos');
  res.renderPage('midday/acceso', { error: null });
});

router.post('/acceso', (req, res) => {
  const pair = M.getPairByCode(middayDb, req.body.code);
  if (!pair || pair.status === 'rejected')
    return res.renderPage('midday/acceso', { error: 'Código no válido.' });
  req.session.middayPairId = pair.id;
  res.redirect('/mediodia/mis-partidos');
});

router.get('/salir', (req, res) => {
  req.session.middayPairId = null;
  res.redirect('/mediodia');
});

// ---- Mis partidos (Fase A: preferencias + aviso de calendario) ----
router.get('/mis-partidos', requirePair, (req, res) => {
  const pair = res.locals.middayPair;
  res.renderPage('midday/mis-partidos', {
    pair,
    slots: slots(),
    slotSummary: M.fmtSlotPrefs(pair.slotPrefs, slots()),
    weekdaysOff: M.fmtWeekdaysOff(pair.weekdaysOff),
    deadline: fmtDate(middayGet('inscription_deadline', '')),
  });
});

module.exports = router;
