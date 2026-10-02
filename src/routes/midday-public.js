// MEDIODÍA PADEL — rutas públicas (Fase A: landing, inscripción, acceso).
// Opera SOLO sobre midday.db. Las lecturas a meta.db / temporada activa son
// de solo lectura (sugerencia de nivel) y nunca escriben allí.
const express = require('express');
const router = express.Router();
const { middayDb, middayGet, metaDb, getActiveSeasonId, seasonDb } = require('../db');
const M = require('../lib/midday');
const D = require('../lib/midday-draw');
const L = require('../lib/league');

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
  const slotLabel = (m) => D.matchSlotLabel(m, sl);
  const draw = D.drawForTournament(middayDb, tid);
  const published = !!(draw && draw.status === 'published');
  const myMatches = published ? D.pairMatches(middayDb, draw.id, pair.id) : [];
  const toValidate = myMatches.filter(m =>
    m.validation === 'pending' && m.submitted_by && m.submitted_by !== pair.id);
  const rivalName = (m) => m.pair1_id === pair.id ? `${m.n2a} / ${m.n2b}` : `${m.n1a} / ${m.n1b}`;
  const rivalPhones = (m) => m.pair1_id === pair.id ? [m.ph2a, m.ph2b] : [m.ph1a, m.ph1b];
  res.renderPage('midday/mis-partidos', {
    pair,
    tournament: M.getTournament(middayDb, tid),
    slots: sl,
    slotSummary: M.fmtSlotPrefs(pair.slotPrefs, sl),
    weekdaysOff: M.fmtWeekdaysOff(pair.weekdaysOff),
    deadline: fmtDate(middayGet('inscription_deadline', '', tid)),
    myMatches,
    toValidate,
    rivalName,
    rivalPhones,
    drawPublished: published,
    fmtMatchDate: D.fmtMatchDate,
    slotLabel,
    formatScore: D.formatScore,
    matchWinnerId: D.matchWinnerId,
    error: req.query.error || null,
    ok: req.query.ok || null,
  });
});

// ---- Subir resultado (cualquiera de las dos parejas; la otra valida en 24 h) ----
router.post('/resultado/:id', requirePair, (req, res) => {
  const pair = res.locals.middayPair;
  const b = req.body;
  const r = D.submitResult(middayDb, Number(req.params.id), pair.id, {
    s1a: D.parseScore(b.s1a), s1b: D.parseScore(b.s1b),
    s2a: D.parseScore(b.s2a), s2b: D.parseScore(b.s2b),
    mode: b.set3mode === 'stb' ? 'stb' : 'none',
    s3a: D.parseScore(b.s3a), s3b: D.parseScore(b.s3b),
    wo: !!b.wo, notes: b.notes,
  });
  res.redirect('/mediodia/mis-partidos?' + (r.ok ? 'ok=1' : 'error=' + encodeURIComponent(r.error)));
});

router.post('/validar/:id', requirePair, (req, res) => {
  const pair = res.locals.middayPair;
  const r = D.validateResult(middayDb, Number(req.params.id), pair.id);
  res.redirect('/mediodia/mis-partidos?' + (r.ok ? 'ok=1' : 'error=' + encodeURIComponent(r.error)));
});

router.post('/disputar/:id', requirePair, (req, res) => {
  const pair = res.locals.middayPair;
  const r = D.disputeResult(middayDb, Number(req.params.id), pair.id);
  res.redirect('/mediodia/mis-partidos?' + (r.ok ? 'ok=1' : 'error=' + encodeURIComponent(r.error)));
});

// ---- Mis datos: la pareja puede corregir sus datos ----
router.get('/datos', requirePair, (req, res) => {
  const pair = res.locals.middayPair;
  const tid = pair.tournament_id;
  const draw = D.drawForTournament(middayDb, tid);
  const canEditSport = !(draw && draw.status === 'published'); // niveles y disponibilidad, solo antes de publicar
  res.renderPage('midday/datos', {
    pair, slots: slots(tid), weekdays: M.WEEKDAYS, canEditSport,
    levelOpts1: levelOptions(pair.level1), levelOpts2: levelOptions(pair.level2),
    error: null, ok: req.query.ok === '1', form: null,
  });
});

router.post('/datos', requirePair, (req, res) => {
  const pair = res.locals.middayPair;
  const tid = pair.tournament_id;
  const b = req.body || {};
  const t = (v) => String(v || '').trim();
  const draw = D.drawForTournament(middayDb, tid);
  const canEditSport = !(draw && draw.status === 'published');
  const again = (error) => res.renderPage('midday/datos', {
    pair: M.getPair(middayDb, pair.id), slots: slots(tid), weekdays: M.WEEKDAYS, canEditSport,
    levelOpts1: levelOptions(b.p1_level), levelOpts2: levelOptions(b.p2_level),
    error, ok: false, form: b,
  });
  const errors = [];
  const name1 = t(b.p1_name), name2 = t(b.p2_name);
  const email1 = t(b.p1_email), email2 = t(b.p2_email);
  const ph1 = t(b.p1_phone).replace(/[\s.-]/g, ''), ph2 = t(b.p2_phone).replace(/[\s.-]/g, '');
  if (!name1 || !name2) errors.push('Faltan los nombres de los jugadores.');
  if (email1 && !M.validEmail(email1)) errors.push('Jugador 1: el email no es válido.');
  if (email2 && !M.validEmail(email2)) errors.push('Jugador 2: el email no es válido.');
  if (!L.validSpanishMobile(ph1)) errors.push('Jugador 1: el móvil no es válido (9 dígitos, empieza por 6 o 7).');
  if (!L.validSpanishMobile(ph2)) errors.push('Jugador 2: el móvil no es válido (9 dígitos, empieza por 6 o 7).');
  if (ph1 === ph2) errors.push('Los dos jugadores no pueden tener el mismo móvil.');
  // Evitar duplicar otra pareja de la edición (mismos dos móviles).
  const dup = middayDb.prepare(
    `SELECT id FROM midday_pairs WHERE tournament_id = ? AND id != ?
     AND ((player1_phone = ? AND player2_phone = ?) OR (player1_phone = ? AND player2_phone = ?))`)
    .get(tid, pair.id, ph1, ph2, ph2, ph1);
  if (dup) errors.push('Ya hay otra pareja inscrita con esos móviles en esta edición.');

  let level1 = pair.level1, level2 = pair.level2, slotPrefs = pair.slot_prefs,
      weekdaysOff = pair.weekdays_off, blackoutDates = pair.blackout_dates, notes = pair.notes;
  if (canEditSport) {
    if (!M.validLevel(b.p1_level)) errors.push('Jugador 1: el nivel debe estar entre 1 y 7 (en pasos de 0,25).');
    if (!M.validLevel(b.p2_level)) errors.push('Jugador 2: el nivel debe estar entre 1 y 7 (en pasos de 0,25).');
    level1 = Math.round(Number(b.p1_level) * 4) / 4;
    level2 = Math.round(Number(b.p2_level) * 4) / 4;
    const sl = slots(tid);
    const prefs = {};
    for (const s of sl) prefs[s.id] = M.SLOT_VALUES.includes(b[`slot_${s.id}`]) ? b[`slot_${s.id}`] : 'ok';
    if (sl.length && !Object.values(prefs).some(v => v !== 'no'))
      errors.push('Tenéis que poder jugar en al menos una franja horaria.');
    const off = M.WEEKDAY_IDS.filter(id => b[`off_${id}`]);
    const { dates, error: bErr } = M.parseBlackout(b.blackout);
    if (bErr) errors.push(bErr);
    slotPrefs = JSON.stringify(prefs);
    weekdaysOff = JSON.stringify(off);
    blackoutDates = JSON.stringify(dates);
    notes = t(b.notes);
  }
  if (errors.length) return again(errors.join(' '));
  const levelAvg = Math.round(((level1 + level2) / 2) * 100) / 100;
  middayDb.prepare(`UPDATE midday_pairs SET player1_name = ?, player1_email = ?, player1_phone = ?,
    player2_name = ?, player2_email = ?, player2_phone = ?,
    level1 = ?, level2 = ?, level_avg = ?, slot_prefs = ?, weekdays_off = ?, blackout_dates = ?, notes = ?
    WHERE id = ?`).run(name1, email1, ph1, name2, email2, ph2,
    level1, level2, levelAvg, slotPrefs, weekdaysOff, blackoutDates, notes, pair.id);
  res.redirect('/mediodia/datos?ok=1');
});

module.exports = router;
