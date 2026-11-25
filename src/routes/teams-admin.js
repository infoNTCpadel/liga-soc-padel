// Equipos Federados KNB — administración (misma sesión que /admin).
// Reparto solo por Mathius: asignar/cambiar de equipo, estados, licencia y
// cuota. Los equipos y los ajustes de temporada son configurables aquí.
const express = require('express');
const router = express.Router();
const { getAdminHash } = require('../db');
const L = require('../lib/league');
const T = require('../lib/teams');

function requireAdmin(req, res, next) {
  res.locals.section = 'admin';
  if (!getAdminHash()) return res.redirect('/admin/setup');
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}
router.use(requireAdmin);

// Euros escritos en el formulario → céntimos
function toCents(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : null;
}
const back = (res, msg) => res.redirect('/admin/equipos?error=' + encodeURIComponent(msg));

// ---- Lista de inscritos ----
router.get('/', (req, res) => {
  const f = req.query.f || 'todos';
  const q = (req.query.q || '').trim();
  const modality = req.query.modality || '';
  const team = req.query.team ? Number(req.query.team) : '';
  const regs = T.listRegistrations({ f, q, modality, team });
  res.renderPage('teams-admin/lista', {
    regs, f, q, modality, team, teams: T.listTeams(false), settings: T.getSettings(),
    counts: T.counts(), open: T.inscriptionOpen(),
    statusName: T.statusName, eur: T.eur, fmtDate: T.fmtDate,
    modalityName: T.modalityName, licenceModes: T.LICENCE_MODES, feeModes: T.FEE_MODES,
    error: req.query.error || null,
    wa: (r) => r.phone ? L.waLink(r.phone, `Hola ${r.name}, te escribimos del club sobre los equipos federados.`) : null,
  });
});

// ---- Reparto y estados (una inscripción) ----
router.post('/inscripcion/:id/asignar', (req, res) => {
  const r = T.assign(req.params.id, req.body.team_id || null, req.body.second_team_id || null);
  if (r.error) return back(res, r.error);
  res.redirect('/admin/equipos');
});
router.post('/inscripcion/:id/estado', (req, res) => {
  const r = T.setStatus(req.params.id, req.body.status);
  if (r.error) return back(res, r.error);
  res.redirect('/admin/equipos');
});
router.post('/inscripcion/:id/licencia', (req, res) => {
  T.setLicence(req.params.id, req.body.done === '1');
  res.redirect('/admin/equipos');
});
router.post('/inscripcion/:id/cuota', (req, res) => {
  T.setFeePaid(req.params.id, req.body.paid === '1');
  res.redirect('/admin/equipos');
});
router.post('/inscripcion/:id/eliminar', (req, res) => {
  T.removeRegistration(req.params.id);
  res.redirect('/admin/equipos');
});

// ---- Exportar CSV ----
router.get('/csv', (req, res) => {
  const regs = T.listRegistrations({
    f: req.query.f || 'todos', q: (req.query.q || '').trim(),
    modality: req.query.modality || '', team: req.query.team ? Number(req.query.team) : '',
  });
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = ['nombre;telefono;email;n_socio;modalidad;equipo_deseado;segundo_equipo;equipo_asignado;segundo_asignado;nivel;licencia_via;licencia_tramitada;cuota_via;cuota_pagada;cuota_importe;estado;inscrito_el']
    .concat(regs.map(r => [
      r.name, r.phone, r.email, r.member_no, T.modalityName(r.modality),
      r.teamName, r.secondTeamName, r.assignedName, r.assignedSecondName,
      r.level == null ? '' : r.level,
      T.LICENCE_MODES[r.licence_mode] || r.licence_mode, r.licence_done ? 'sí' : 'no',
      T.FEE_MODES[r.fee_mode] || r.fee_mode, r.fee_paid ? 'sí' : 'no',
      (r.feeDue / 100).toFixed(2).replace('.', ','), T.statusName(r.status),
      (r.created_at || '').slice(0, 16).replace('T', ' '),
    ].map(q).join(';')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="equipos-federados.csv"');
  res.send('﻿' + csv);
});

// ---- Equipos (CRUD + capitanes) ----
router.get('/equipos', (req, res) => {
  const teams = T.listTeams(false).map(t => ({
    ...t, captains: T.listCaptains(t.id), assigned: T.countAssigned(t.id),
  }));
  res.renderPage('teams-admin/equipos', {
    teams, modalityName: T.modalityName, sexName: T.sexName, error: req.query.error || null,
  });
});
router.post('/equipos/nuevo', (req, res) => {
  if (!(req.body.name || '').trim()) return res.redirect('/admin/equipos/equipos?error=' + encodeURIComponent('Falta el nombre del equipo.'));
  const r = T.createTeam({
    name: req.body.name, modality: req.body.modality, sex: req.body.sex,
    category: req.body.category, fcp_group: req.body.fcp_group, slug: (req.body.slug || '').trim() || undefined,
  });
  if (r.error) return res.redirect('/admin/equipos/equipos?error=' + encodeURIComponent(r.error));
  res.redirect('/admin/equipos/equipos');
});
router.post('/equipos/:id/editar', (req, res) => {
  const r = T.updateTeam(req.params.id, {
    name: req.body.name, modality: req.body.modality, sex: req.body.sex,
    category: req.body.category, fcp_group: req.body.fcp_group, slug: (req.body.slug || '').trim(),
  });
  if (r.error) return res.redirect('/admin/equipos/equipos?error=' + encodeURIComponent(r.error));
  res.redirect('/admin/equipos/equipos');
});
router.post('/equipos/:id/activar', (req, res) => {
  T.setTeamActive(req.params.id, req.body.active === '1');
  res.redirect('/admin/equipos/equipos');
});
router.post('/equipos/:id/eliminar', (req, res) => {
  const r = T.deleteTeam(req.params.id);
  if (r.error) return res.redirect('/admin/equipos/equipos?error=' + encodeURIComponent(r.error));
  res.redirect('/admin/equipos/equipos');
});
router.post('/equipos/:id/capitanes', (req, res) => {
  const r = T.addCaptain(req.params.id, req.body.member_no, req.body.role);
  if (r.error) return res.redirect('/admin/equipos/equipos?error=' + encodeURIComponent(r.error));
  res.redirect('/admin/equipos/equipos');
});
router.post('/equipos/:id/capitanes/quitar', (req, res) => {
  T.removeCaptain(req.params.id, req.body.member_no);
  res.redirect('/admin/equipos/equipos');
});

// ---- Ajustes de temporada ----
router.get('/ajustes', (req, res) => {
  res.renderPage('teams-admin/ajustes', {
    settings: T.getSettings(), eur: T.eur, error: req.query.error || null,
  });
});
router.post('/ajustes', (req, res) => {
  const b = req.body;
  const feeOne = toCents(b.fee_one), feeTwo = toCents(b.fee_two), licence = toCents(b.licence_price);
  if (feeOne == null || feeTwo == null || licence == null) {
    return res.renderPage('teams-admin/ajustes', {
      settings: T.getSettings(), eur: T.eur, error: 'Revisa los importes (cuotas y licencia).',
    });
  }
  T.setSetting('season', (b.season || '').trim() || '2027');
  T.setSetting('inscription_open', b.inscription_open === '1' ? '1' : '0');
  T.setSetting('open_date', (b.open_date || '').trim());
  T.setSetting('close_date', (b.close_date || '').trim());
  T.setSetting('fee_one_cents', feeOne);
  T.setSetting('fee_two_cents', feeTwo);
  T.setSetting('licence_price_cents', licence);
  T.setSetting('pay_deadline', (b.pay_deadline || '').trim());
  res.redirect('/admin/equipos/ajustes');
});

module.exports = router;
