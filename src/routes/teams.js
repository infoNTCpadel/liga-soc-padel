// Equipos Federados KNB — rutas públicas.
// La inscripción EXIGE ser socio: nº de socio + móvil deben coincidir con la
// misma ficha del directorio único (club_members). No se crea ninguna ficha.
const express = require('express');
const router = express.Router();
const T = require('../lib/teams');
const B = require('../lib/bookings');
const L = require('../lib/league');

router.use((req, res, next) => { res.locals.sub = 'equipos'; next(); });

// Reconocimiento por teléfono + nº de socio (misma regla que Eventos):
// solo si AMBOS coinciden con la misma ficha se devuelven los datos para
// autorrellenar el formulario. Con límite por IP (anti-sondeo).
const lookupHits = new Map();
router.get('/api/reconocer', (req, res) => {
  const ip = req.ip || 'sin-ip';
  const now = Date.now();
  const hits = (lookupHits.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= 30) return res.status(429).json({ found: false, error: 'Demasiadas consultas seguidas. Espera un minuto.' });
  hits.push(now);
  lookupHits.set(ip, hits);
  const phone = String(req.query.phone || '');
  if (!L.validSpanishMobile(phone)) return res.json({ found: false });
  const m = B.getMemberByPhone(phone);
  if (!m || !m.active) return res.json({ found: false });
  if (!T.memberNoMatches(m, req.query.member_no)) return res.json({ found: false });
  res.json({
    found: true,
    name: m.name || '',
    level: m.level == null ? null : Number(m.level),
    gender: m.gender || '',
    socio: true,
  });
});

// Índice: equipos activos agrupados por modalidad + estado de inscripción.
router.get('/', (req, res) => {
  const teams = T.listTeams(true);
  const settings = T.getSettings();
  const byModality = {};
  for (const t of teams) {
    (byModality[t.modality] = byModality[t.modality] || []).push({ ...t, assigned: T.countAssigned(t.id) });
  }
  res.renderPage('teams/index', {
    byModality, settings, open: T.inscriptionOpen(), eur: T.eur, fmtDate: T.fmtDate,
    modalityName: T.modalityName, sexName: T.sexName,
  });
});

// Formulario de inscripción
router.get('/inscripcion', (req, res) => {
  const settings = T.getSettings();
  const teams = T.listTeams(true);
  let form = null;
  if (req.session.teamForm) { form = req.session.teamForm.values; delete req.session.teamForm; }
  res.renderPage('teams/inscripcion', {
    settings, teams, form, open: T.inscriptionOpen(),
    ok: req.query.ok === '1', waitlist: req.query.lista === '1',
    error: req.query.error || null,
    eur: T.eur, fmtDate: T.fmtDate, modalityName: T.modalityName,
    licenceModes: T.LICENCE_MODES, feeModes: T.FEE_MODES,
  });
});

router.post('/inscripcion', (req, res) => {
  const b = req.body;
  const FORM_KEYS = ['name', 'member_no', 'phone', 'email', 'modality', 'team_id', 'second_team_id',
    'level', 'licence_mode', 'fee_mode', 'comments', 'consent'];
  const back = (msg) => {
    req.session.teamForm = { values: Object.fromEntries(FORM_KEYS.filter(k => b[k] !== undefined).map(k => [k, b[k]])) };
    res.redirect('/equipos/inscripcion?error=' + encodeURIComponent(msg));
  };
  const r = T.register({
    name: b.name, member_no: b.member_no, phone: b.phone, email: b.email,
    modality: b.modality, team_id: b.team_id || null, second_team_id: b.second_team_id || null,
    level: b.level, licence_mode: b.licence_mode, fee_mode: b.fee_mode,
    comments: b.comments, consent: b.consent,
  });
  if (r.error) return back(r.error);
  res.redirect('/equipos/inscripcion?ok=1' + (r.waitlist ? '&lista=1' : ''));
});

// Ficha de un equipo: capitanes + plantilla de asignados (nombre + apellido).
router.get('/:slug', (req, res) => {
  const team = T.getTeamBySlug(req.params.slug);
  if (!team || !team.active) return res.status(404).renderPage('public/404', {});
  const captains = T.listCaptains(team.id);
  const players = T.roster(team.id);
  const settings = T.getSettings();
  res.renderPage('teams/equipo', {
    team, captains, players, settings, open: T.inscriptionOpen(),
    modalityName: T.modalityName, sexName: T.sexName,
  });
});

module.exports = router;
