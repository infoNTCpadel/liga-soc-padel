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
  const upcoming = E.upcomingEvents().map(ev => ({ ...ev, inscritos: E.countInscriptions(ev.id), left: E.spotsLeft(ev) }));
  const past = E.listEvents().filter(e => !upcoming.some(u => u.id === e.id)).slice(0, 6)
    .map(ev => ({ ...ev, inscritos: E.countInscriptions(ev.id) }));
  res.renderPage('eventos/index', { upcoming, past, fmtDate: E.fmtDate, eur: E.eur, formatName: E.formatName });
});

// Landing de un evento + formulario
router.get('/:slug', (req, res) => {
  const ev = E.getEvent(req.params.slug);
  if (!ev) return res.status(404).renderPage('public/404', {});
  const inscritos = E.countInscriptions(ev.id);
  res.renderPage('eventos/evento', {
    ev, inscritos, left: E.spotsLeft(ev), levelOptions,
    ok: req.query.ok === '1', memberNo: req.query.mno || null, error: req.query.error || null,
    fmtDate: E.fmtDate, eur: E.eur, formatName: E.formatName, modeName: E.modeName,
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
  if (!ev) return res.status(404).renderPage('public/404', {});
  const b = req.body;
  const back = (msg) => res.redirect(`/eventos/${ev.slug}?error=` + encodeURIComponent(msg));
  const wantPair = (ev.inscription_mode === 'pairs') || (ev.inscription_mode === 'mixed' && b.kind === 'pareja');
  if (wantPair) {
    const r1 = validPlayer(b, 'p1'), r2 = validPlayer(b, 'p2');
    if (r1.error) return back(r1.error);
    if (r2.error) return back(r2.error);
    const r = E.inscribePair(ev.id, { p1: r1.player, p2: r2.player });
    if (r.error) return back(r.error);
    return res.redirect(`/eventos/${ev.slug}?ok=1&mno=` + encodeURIComponent(r.member_nos.join(',')));
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
  res.redirect(`/eventos/${ev.slug}?ok=1&mno=` + encodeURIComponent(r.member_no));
});

module.exports = router;
