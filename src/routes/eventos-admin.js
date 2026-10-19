// Eventos del club — administración (misma sesión que /admin).
const express = require('express');
const router = express.Router();
const { getSetting, getAdminHash } = require('../db');
const L = require('../lib/league');
const E = require('../lib/events');

function requireAdmin(req, res, next) {
  res.locals.section = 'admin';
  if (!getAdminHash()) return res.redirect('/admin/setup');
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}
router.use(requireAdmin);

// Listado
router.get('/', (req, res) => {
  const events = E.listEvents().map(ev => ({ ...ev, inscritos: E.countInscriptions(ev.id) }));
  res.renderPage('eventos-admin/lista', { events });
});

// Nuevo evento
router.get('/nuevo', (req, res) => {
  res.renderPage('eventos-admin/nuevo', { error: null, formats: E.FORMATS });
});
router.post('/nuevo', (req, res) => {
  const b = req.body;
  if (!(b.name || '').trim() || !b.event_date) {
    return res.renderPage('eventos-admin/nuevo', { error: 'Faltan el nombre o la fecha.', formats: E.FORMATS });
  }
  const ev = E.createEvent({
    name: b.name, description: b.description, event_date: b.event_date, event_time: b.event_time,
    format: b.format, price_cents: Math.round(parseFloat(b.price || '0') * 100), max_players: b.max_players,
  });
  res.redirect('/admin/eventos/' + ev.id);
});

// Detalle + inscritos
router.get('/:id', (req, res) => {
  const ev = E.getEventById(req.params.id);
  if (!ev) return res.redirect('/admin/eventos');
  const inscritos = E.listInscriptions(ev.id).map(r => ({
    ...r,
    wa: r.phone ? L.waLink(r.phone, `Hola ${r.name}, te escribimos del ${getSetting('club_name', 'club')}: estás inscrito/a en "${ev.name}" (${E.fmtDate(ev.event_date)}${ev.event_time ? ' ' + ev.event_time : ''}). ¡Nos vemos allí! 🎾`) : null,
  }));
  res.renderPage('eventos-admin/detalle', {
    ev, inscritos, left: E.spotsLeft(ev), formats: E.FORMATS, error: req.query.error || null,
  });
});

// Editar
router.post('/:id/editar', (req, res) => {
  const b = req.body;
  E.updateEvent(req.params.id, {
    name: b.name, description: b.description, event_date: b.event_date, event_time: b.event_time,
    format: b.format, price_cents: Math.round(parseFloat(b.price || '0') * 100), max_players: b.max_players,
  });
  res.redirect('/admin/eventos/' + req.params.id);
});

// Abrir / cerrar inscripciones / eliminar
router.post('/:id/abrir', (req, res) => { E.setEventOpen(req.params.id, true); res.redirect('/admin/eventos/' + req.params.id); });
router.post('/:id/cerrar', (req, res) => { E.setEventOpen(req.params.id, false); res.redirect('/admin/eventos/' + req.params.id); });
router.post('/:id/eliminar', (req, res) => { E.deleteEvent(req.params.id); res.redirect('/admin/eventos'); });

// Cobro / baja de un inscrito
router.post('/:id/inscripcion/:iid/pagado', (req, res) => {
  E.setPaid(req.params.iid, req.body.paid !== '0');
  res.redirect('/admin/eventos/' + req.params.id);
});
router.post('/:id/inscripcion/:iid/eliminar', (req, res) => {
  E.removeInscription(req.params.iid);
  res.redirect('/admin/eventos/' + req.params.id);
});

// Exportar CSV
router.get('/:id/csv', (req, res) => {
  const ev = E.getEventById(req.params.id);
  if (!ev) return res.redirect('/admin/eventos');
  const rows = E.listInscriptions(ev.id);
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = ['nombre;telefono;email;nivel;n_socio;pagado;inscrito_el']
    .concat(rows.map(r => [r.name, r.phone, (r.member && r.member.email) || '', r.level == null ? '' : r.level,
      r.member_no, r.paid ? 'sí' : 'no', (r.created_at || '').slice(0, 16).replace('T', ' ')].map(q).join(';')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="evento-${ev.slug}.csv"`);
  res.send('﻿' + csv);
});

module.exports = router;
