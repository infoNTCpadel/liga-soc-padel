// Eventos del club — administración (misma sesión que /admin).
const express = require('express');
const router = express.Router();
const { getSetting, getAdminHash } = require('../db');
const L = require('../lib/league');
const E = require('../lib/events');
const U = require('../lib/upload');

function requireAdmin(req, res, next) {
  res.locals.section = 'admin';
  if (!getAdminHash()) return res.redirect('/admin/setup');
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}
router.use(requireAdmin);

// Los formularios de eventos usan multipart (cartel); si no, urlencoded normal.
async function formData(req) {
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('multipart/form-data')) {
    const mp = await U.parseMultipart(req);
    return { fields: mp.fields, file: mp.file };
  }
  return { fields: req.body, file: null };
}

// Listado
router.get('/', (req, res) => {
  const events = E.listEvents().map(ev => ({ ...ev, inscritos: E.countInscriptions(ev.id) }));
  res.renderPage('eventos-admin/lista', { events, statusName: E.statusName });
});

// Euros escritos en el formulario → céntimos (vacío → null = sin segundo precio)
function toCents(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : null;
}

// Nuevo evento
router.get('/nuevo', (req, res) => {
  res.renderPage('eventos-admin/nuevo', { error: null, formats: E.FORMATS, modes: E.MODES, statuses: E.STATUSES });
});
router.post('/nuevo', async (req, res) => {
  let fields, file;
  try {
    ({ fields, file } = await formData(req));
  } catch (e) {
    return res.renderPage('eventos-admin/nuevo', { error: e.message, formats: E.FORMATS, modes: E.MODES, statuses: E.STATUSES });
  }
  const b = fields;
  const imgErr = U.validImage(file);
  if (!(b.name || '').trim() || !b.event_date) {
    return res.renderPage('eventos-admin/nuevo', { error: 'Faltan el nombre o la fecha.', formats: E.FORMATS, modes: E.MODES, statuses: E.STATUSES });
  }
  if (imgErr) {
    return res.renderPage('eventos-admin/nuevo', { error: imgErr, formats: E.FORMATS, modes: E.MODES, statuses: E.STATUSES });
  }
  const slugWanted = (b.slug || '').trim();
  if (slugWanted) {
    const sErr = E.validateSlug(slugWanted, null);
    if (sErr) return res.renderPage('eventos-admin/nuevo', { error: sErr, formats: E.FORMATS, modes: E.MODES, statuses: E.STATUSES });
  }
  const ev = E.createEvent({
    name: b.name, description: b.description, event_date: b.event_date, event_time: b.event_time,
    format: b.format, price_cents: toCents(b.price) || 0, price_nonmember_cents: toCents(b.price_nonmember),
    max_players: b.max_players, mode: b.mode, status: b.status, slug: slugWanted || undefined,
  });
  if (file && file.data && file.data.length) E.setPoster(ev.id, U.savePoster(ev.id, file));
  res.redirect('/admin/eventos/' + ev.id);
});

// Detalle + inscritos
router.get('/:id', (req, res) => {
  const ev = E.getEventById(req.params.id);
  if (!ev) return res.redirect('/admin/eventos');
  const inscritos = E.inscriptionsWithPairs(ev.id).map(r => ({
    ...r,
    priceInfo: E.inscPrice(ev, r),
    wa: r.phone ? L.waLink(r.phone, `Hola ${r.name}, te escribimos del ${getSetting('club_name', 'club')}: estás inscrito/a en "${ev.name}" (${E.fmtDate(ev.event_date)}${ev.event_time ? ' ' + ev.event_time : ''}). ¡Nos vemos allí! 🎾`) : null,
  }));
  const parejas = inscritos.filter(r => r.partner && r.id < r.partner.id).length;
  const cobrado = inscritos.filter(r => r.paid).reduce((s, r) => s + r.priceInfo.cents, 0);
  const pendiente = inscritos.filter(r => !r.paid).reduce((s, r) => s + r.priceInfo.cents, 0);
  res.renderPage('eventos-admin/detalle', {
    ev, inscritos, parejas, cobrado, pendiente, left: E.spotsLeft(ev), formats: E.FORMATS, modes: E.MODES,
    statuses: E.STATUSES, modeName: E.modeName, statusName: E.statusName, eur: E.eur,
    hasDualPrice: E.hasDualPrice(ev), error: req.query.error || null,
  });
});

// Editar
router.post('/:id/editar', async (req, res) => {
  let fields, file;
  try {
    ({ fields, file } = await formData(req));
  } catch (e) {
    return res.redirect('/admin/eventos/' + req.params.id + '?error=' + encodeURIComponent(e.message));
  }
  const b = fields;
  const imgErr = U.validImage(file);
  if (imgErr) {
    return res.redirect('/admin/eventos/' + req.params.id + '?error=' + encodeURIComponent(imgErr));
  }
  const slugWanted = (b.slug || '').trim();
  if (slugWanted) {
    const sErr = E.validateSlug(slugWanted, req.params.id);
    if (sErr) {
      return res.redirect('/admin/eventos/' + req.params.id + '?error=' + encodeURIComponent(sErr));
    }
  }
  E.updateEvent(req.params.id, {
    name: b.name, description: b.description, event_date: b.event_date, event_time: b.event_time,
    format: b.format, price_cents: toCents(b.price) || 0, price_nonmember_cents: toCents(b.price_nonmember),
    max_players: b.max_players, mode: b.mode, status: b.status, slug: slugWanted || undefined,
  });
  if (file && file.data && file.data.length) E.setPoster(req.params.id, U.savePoster(req.params.id, file));
  res.redirect('/admin/eventos/' + req.params.id);
});

// Quitar cartel
router.post('/:id/poster/quitar', (req, res) => {
  U.removePoster(req.params.id);
  E.setPoster(req.params.id, '');
  res.redirect('/admin/eventos/' + req.params.id);
});

// Cambiar estado
router.post('/:id/estado', (req, res) => {
  E.setStatus(req.params.id, req.body.status);
  res.redirect('/admin/eventos/' + req.params.id);
});
// Eliminar evento
router.post('/:id/eliminar', (req, res) => { E.deleteEvent(req.params.id); res.redirect('/admin/eventos'); });

// Cobro / baja de un inscrito
router.post('/:id/inscripcion/:iid/pagado', (req, res) => {
  E.setPaid(req.params.iid, req.body.paid !== '0');
  res.redirect('/admin/eventos/' + req.params.id);
});
// Corregir tipo del inscrito: socio ↔ no socio (recalcula su precio)
router.post('/:id/inscripcion/:iid/tipo', (req, res) => {
  E.setInscriptionMemberType(req.params.id, req.params.iid, req.body.member === '1');
  res.redirect('/admin/eventos/' + req.params.id);
});
router.post('/:id/inscripcion/:iid/eliminar', (req, res) => {
  E.removeInscription(req.params.iid);
  res.redirect('/admin/eventos/' + req.params.id);
});

// Emparejar dos inscritos sueltos (americanas) / desemparejar
router.post('/:id/emparejar', (req, res) => {
  const sel = [].concat(req.body.sel || []).map(Number).filter(Number.isFinite);
  const ok = sel.length === 2 && E.pairUp(req.params.id, sel[0], sel[1]);
  res.redirect('/admin/eventos/' + req.params.id + (ok ? '' : '?error=' + encodeURIComponent('Selecciona exactamente 2 inscritos sin pareja.')));
});
router.post('/:id/inscripcion/:iid/desemparejar', (req, res) => {
  E.unpair(req.params.iid);
  res.redirect('/admin/eventos/' + req.params.id);
});

// Exportar CSV
router.get('/:id/csv', (req, res) => {
  const ev = E.getEventById(req.params.id);
  if (!ev) return res.redirect('/admin/eventos');
  const rows = E.inscriptionsWithPairs(ev.id);
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = ['nombre;telefono;email;nivel;n_socio;tipo;precio;pareja;pagado;inscrito_el']
    .concat(rows.map(r => {
      const pi = E.inscPrice(ev, r);
      return [r.name, r.phone, (r.member && r.member.email) || '', r.level == null ? '' : r.level,
        r.member_no, pi.is_member ? 'Socio' : 'No socio', (pi.cents / 100).toFixed(2).replace('.', ','),
        r.partner ? r.partner.name : '', r.paid ? 'sí' : 'no', (r.created_at || '').slice(0, 16).replace('T', ' ')].map(q).join(';');
    }))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="evento-${ev.slug}.csv"`);
  res.send('﻿' + csv);
});

module.exports = router;
