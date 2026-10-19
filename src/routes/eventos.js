// Eventos del club (quedadas, americanas): landing pública + inscripciones.
// Las personas van al DIRECTORIO ÚNICO (club_members): sin duplicados.
const express = require('express');
const router = express.Router();
const L = require('../lib/league');
const E = require('../lib/events');

router.use((req, res, next) => { res.locals.sub = 'eventos'; next(); });

const levelOptions = L.PLAYTOMIC_BRACKETS.map(b => ({
  name: b.name, value: Math.round(((b.min + b.max) / 2) * 100) / 100,
}));

// Índice de eventos
router.get('/', (req, res) => {
  const { upcoming, past } = E.publicEvents();
  const withCounts = (list) => list.map(ev => ({ ...ev, inscritos: E.countInscriptions(ev.id), left: E.spotsLeft(ev) }));
  res.renderPage('eventos/index', {
    upcoming: withCounts(upcoming), past: withCounts(past),
    fmtDate: E.fmtDate, eur: E.eur, formatName: E.formatName, statusName: E.statusName,
  });
});

// Landing de un evento + formulario
router.get('/:slug', (req, res) => {
  const ev = E.getEvent(req.params.slug);
  if (!ev || ev.status === 'oculta') return res.status(404).renderPage('public/404', {});
  const inscritos = E.countInscriptions(ev.id);
  // Si la inscripción anterior falló, se repuebla el formulario con lo que había escrito
  let form = null;
  if (req.session.eventForm && req.session.eventForm.slug === req.params.slug) {
    form = req.session.eventForm.values;
    delete req.session.eventForm;
  }
  res.renderPage('eventos/evento', {
    ev, inscritos, left: E.spotsLeft(ev), levelOptions, form,
    ok: req.query.ok === '1', error: req.query.error || null,
    fmtDate: E.fmtDate, eur: E.eur, formatName: E.formatName, modeName: E.modeName, statusName: E.statusName,
  });
});

function validPlayer(b, pfx) {
  const name = (b[pfx + '_name'] || '').trim();
  const phone = (b[pfx + '_phone'] || '').trim();
  const level = parseFloat(b[pfx + '_level']);
  if (!name) return { error: 'Falta el nombre de un jugador.' };
  if (!L.validSpanishMobile(phone)) return { error: 'Un teléfono no parece un móvil válido (9 dígitos, empieza por 6 o 7).' };
  if (!(level >= 0 && level <= 6)) return { error: 'Indica el nivel de los dos jugadores.' };
  return {
    player: {
      name, phone, level,
      member_no: (b[pfx + '_member_no'] || '').trim(),
      email: (b[pfx + '_email'] || '').trim(),
      gender: (b[pfx + '_gender'] || '').toUpperCase(),
    },
  };
}

// Inscripción
router.post('/:slug/inscribir', (req, res) => {
  const ev = E.getEvent(req.params.slug);
  if (!ev || ev.status === 'oculta') return res.status(404).renderPage('public/404', {});
  const b = req.body;
  // Guarda lo escrito para repoblar el formulario si hay un error de validación
  const FORM_KEYS = ['kind', 'name', 'phone', 'level', 'gender', 'member_no', 'email',
    'p1_name', 'p1_phone', 'p1_level', 'p1_gender', 'p1_member_no', 'p1_email',
    'p2_name', 'p2_phone', 'p2_level', 'p2_gender', 'p2_member_no', 'p2_email'];
  const back = (msg) => {
    req.session.eventForm = {
      slug: ev.slug,
      values: Object.fromEntries(FORM_KEYS.filter(k => b[k] !== undefined).map(k => [k, b[k]])),
    };
    res.redirect(`/eventos/${ev.slug}?error=` + encodeURIComponent(msg));
  };
  const wantPair = (ev.inscription_mode === 'pairs') || (ev.inscription_mode === 'mixed' && b.kind === 'pareja');
  if (wantPair) {
    const r1 = validPlayer(b, 'p1'), r2 = validPlayer(b, 'p2');
    if (r1.error) return back(r1.error);
    if (r2.error) return back(r2.error);
    const r = E.inscribePair(ev.id, { p1: r1.player, p2: r2.player });
    if (r.error) return back(r.error);
    return res.redirect(`/eventos/${ev.slug}?ok=1`);
  }
  if (ev.inscription_mode === 'individual' && (b.p1_name || b.p2_name)) {
    return back('Este evento no admite inscripción por parejas.');
  }
  // En modo mixto el jugador suelto viene como p1_*
  const pfx = ev.inscription_mode === 'mixed' ? 'p1_' : '';
  const name = (b[pfx + 'name'] || '').trim(), phone = (b[pfx + 'phone'] || '').trim();
  const level = parseFloat(b[pfx + 'level']);
  if (!name) return back('Falta tu nombre.');
  if (!L.validSpanishMobile(phone)) return back('El teléfono no parece un móvil válido (9 dígitos, empieza por 6 o 7).');
  if (!(level >= 0 && level <= 6)) return back('Indica tu nivel.');
  const r = E.inscribe(ev.id, {
    phone, name, member_no: (b[pfx + 'member_no'] || '').trim(),
    email: (b[pfx + 'email'] || '').trim(), level, gender: (b[pfx + 'gender'] || '').toUpperCase(),
  });
  if (r.error) return back(r.error); // p. ej. ya inscrito: avisa sin duplicar
  res.redirect(`/eventos/${ev.slug}?ok=1`);
});

module.exports = router;
