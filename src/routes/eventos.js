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
    fmtDate: E.fmtDate, eur: E.eur, formatName: E.formatName,
  });
});

// Inscripción
router.post('/:slug/inscribir', (req, res) => {
  const ev = E.getEvent(req.params.slug);
  if (!ev) return res.status(404).renderPage('public/404', {});
  const b = req.body;
  const back = (msg) => res.redirect(`/eventos/${ev.slug}?error=` + encodeURIComponent(msg));
  if (!(b.name || '').trim()) return back('Falta tu nombre.');
  if (!L.validSpanishMobile(b.phone)) return back('El teléfono no parece un móvil válido (9 dígitos, empieza por 6 o 7).');
  const level = parseFloat(b.level);
  if (!(level >= 0 && level <= 6)) return back('Indica tu nivel.');
  const r = E.inscribe(ev.id, {
    phone: b.phone.trim(), name: b.name.trim(), member_no: (b.member_no || '').trim(),
    email: (b.email || '').trim(), level, gender: (b.gender || '').toUpperCase(),
  });
  if (r.error) return back(r.error); // p. ej. ya inscrito: avisa sin duplicar
  res.redirect(`/eventos/${ev.slug}?ok=1&mno=` + encodeURIComponent(r.member_no));
});

module.exports = router;
