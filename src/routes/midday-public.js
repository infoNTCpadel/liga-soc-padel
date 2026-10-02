// MEDIODÍA PADEL — rutas públicas (Fase A: landing, inscripción, acceso).
// Opera SOLO sobre midday.db. Las lecturas a meta.db / temporada activa son
// de solo lectura (sugerencia de nivel) y nunca escriben allí.
const express = require('express');
const router = express.Router();
const { middayDb, middayGet, metaDb, getActiveSeasonId, seasonDb } = require('../db');
const M = require('../lib/midday');
const D = require('../lib/midday-draw');

router.use((req, res, next) => {
  res.locals.section = 'midday';
  res.locals.clubName = middayGet('comp_name', 'MEDIODÍA PADEL');
  res.locals.seasonName = 'Liga de mediodía';
  res.locals.middayPairId = req.session.middayPairId || null;
  next();
});

function slots(tid) { return M.parseSlots(middayGet('slots', '[]', tid)); }
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function currentTid() {
  const t = M.currentTournament(middayDb);
  return t ? t.id : null;
}
function inscriptionOpen(tid) {
  if (tid == null) return false;
  if (middayGet('inscription_open', '1', tid) !== '1') return false;
  const deadline = middayGet('inscription_deadline', '', tid);
  if (!deadline) return true;
  return new Date().toISOString().slice(0, 10) <= deadline;
}

// ---- Portada ----
router.get('/', (req, res) => {
  const tid = currentTid();
  const t = tid ? M.getTournament(middayDb, tid) : null;
  const counts = tid ? {
    approved: middayDb.prepare("SELECT COUNT(*) c FROM midday_pairs WHERE tournament_id = ? AND status = 'approved'").get(tid).c,
    pending: middayDb.prepare("SELECT COUNT(*) c FROM midday_pairs WHERE tournament_id = ? AND status = 'pending'").get(tid).c,
  } : { approved: 0, pending: 0 };
  const draw = tid ? D.drawForTournament(middayDb, tid) : null;
  res.renderPage('midday/landing', {
    tournament: t,
    counts,
    open: inscriptionOpen(tid),
    deadline: fmtDate(middayGet('inscription_deadline', '', tid)),
    slots: slots(tid),
    courts: middayGet('courts_midday', '4', tid),
    drawPublished: !!(draw && draw.status === 'published'),
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
  const tid = currentTid();
  const open = inscriptionOpen(tid);
  res.renderPage('midday/inscripcion', {
    open,
    noTournament: tid == null,
    deadline: fmtDate(middayGet('inscription_deadline', '', tid)),
    slots: slots(tid),
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
  const tid = currentTid();
  const again = (errors) => res.renderPage('midday/inscripcion', {
    open: inscriptionOpen(tid), noTournament: tid == null,
    deadline: fmtDate(middayGet('inscription_deadline', '', tid)),
    slots: slots(tid), weekdays: M.WEEKDAYS, form: b,
    levelOpts1: levelOptions(b.p1_level), levelOpts2: levelOptions(b.p2_level),
    errors,
    sub: 'inscripcion',
  });
  if (tid == null) return again(['Ahora mismo no hay ninguna edición abierta. Vuelve pronto.']);
  if (!inscriptionOpen(tid)) return again(['La inscripción está cerrada.']);

  const sl = slots(tid);
  const v = M.validateInscription(b, sl);
  if (!v.ok) return again(v.errors);

  const ph1 = v.data.player1_phone, ph2 = v.data.player2_phone;
  if (M.pairExists(middayDb, ph1, ph2, tid))
    return again(['Esta pareja ya está inscrita en esta edición (mismos móviles). Si es un error, contacta con el club.']);

  let created;
  try {
    created = M.createPair(middayDb, { ...v.data, tournament_id: tid });
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

// ---- Mis partidos ----
router.get('/mis-partidos', requirePair, (req, res) => {
  const pair = res.locals.middayPair;
  const tid = pair.tournament_id;
  const sl = slots(tid);
  const slotLabel = (id) => { const s = sl.find(x => x.id === id); return s ? s.label : (id || '—'); };
  const draw = D.drawForTournament(middayDb, tid);
  const published = !!(draw && draw.status === 'published');
  const myMatches = published ? D.pairMatches(middayDb, draw.id, pair.id) : [];
  res.renderPage('midday/mis-partidos', {
    pair,
    tournament: M.getTournament(middayDb, tid),
    slots: sl,
    slotSummary: M.fmtSlotPrefs(pair.slotPrefs, sl),
    weekdaysOff: M.fmtWeekdaysOff(pair.weekdaysOff),
    deadline: fmtDate(middayGet('inscription_deadline', '', tid)),
    myMatches,
    drawPublished: published,
    fmtMatchDate: D.fmtMatchDate,
    slotLabel,
  });
});

module.exports = router;
