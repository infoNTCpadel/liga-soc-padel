// Servidor principal de la app de gestión de liga.
const express = require('express');
const session = require('express-session');
const path = require('path');
const ejs = require('ejs');
const { db, getSetting, getActiveSeason } = require('./db');
const { autoValidateExpired } = require('./lib/league');
const L = require('./lib/league');

const app = express();
const PORT = process.env.PORT || 3000;

// Cabeceras básicas de seguridad.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'liga-padel-secret-cambiar-en-produccion',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }, // 30 días
}));

// Validación automática de resultados pendientes (>24h) en cada petición.
app.use((req, res, next) => {
  try { autoValidateExpired(db); } catch (e) { console.error('autoValidate:', e.message); }
  next();
});

// Datos comunes para las vistas.
app.use((req, res, next) => {
  res.locals.clubName = getSetting('club_name', 'Master Padel League');
  res.locals.seasonName = getSetting('season_name', 'Temporada 2026/27');
  res.locals.activeSeason = getActiveSeason();
  res.locals.isAdmin = !!req.session.admin;
  res.locals.pairId = req.session.pairId || null;
  res.locals.section = 'public';
  res.locals.query = req.query;
  // Helpers globales para las vistas
  res.locals.pairName = (id) => (id ? L.pairName(db, id) : '—');
  res.locals.slotStr = (m) => (m ? L.formatSlot(m.scheduled_at, m.court_name) : '');
  res.locals.scoreStr = (m) => {
    if (!m) return '';
    if (m.unplayed) return 'No jugado';
    if (m.wo_winner_id) return 'W.O.';
    if (m.s1a == null || m.s1b == null) return 'Pendiente';
    let s = `${m.s1a}–${m.s1b} · ${m.s2a}–${m.s2b}`;
    if (m.s3a != null && m.s3b != null) s += ` · ${m.s3a}–${m.s3b} (3er set)`;
    else if (m.stb_a != null && m.stb_b != null) s += ` · ${m.stb_a}–${m.stb_b} (STB)`;
    return s;
  };
  res.locals.valBadge = (m) => {
    if (!m || m.unplayed || m.wo_winner_id) return '';
    switch (m.validation) {
      case 'pending': return 'pendiente';
      case 'disputed': return 'disputado';
      case 'validated': return 'validado';
      case 'auto': return 'auto';
      default: return '';
    }
  };
  res.locals.moveStr = (d) => {
    if (d >= 2) return 'Sube 2 grupos';
    if (d === 1) return 'Sube 1 grupo';
    if (d === 0) return 'Se mantiene';
    if (d === -1) return 'Baja 1 grupo';
    return 'Baja 2 grupos';
  };
  res.locals.bracketName = (code) => L.BRACKET_NAME_BY_CODE[code] || code || '';
  res.locals.playoffOrdinal = (stage) => L.playoffOrdinal(stage);
  res.locals.CATEGORIES = L.CATEGORIES;
  res.locals.catName = L.catName;
  next();
});

// Helper: renderiza una vista dentro del layout.
const VIEWS = path.join(__dirname, 'views');
function res_render(res, view, data = {}) {
  const full = { ...res.locals, ...data };
  ejs.renderFile(path.join(VIEWS, view + '.ejs'), full, (err, body) => {
    if (err) {
      console.error('render', view, err);
      return res.status(500).send('Error al mostrar la página.');
    }
    if (data.layout === false) return res.send(body);
    ejs.renderFile(path.join(VIEWS, 'layout.ejs'), { ...full, body }, (err2, html) => {
      if (err2) {
        console.error('layout', err2);
        return res.status(500).send('Error al mostrar la página.');
      }
      res.send(html);
    });
  });
};

app.use((req, res, next) => { res.renderPage = (v, d) => res_render(res, v, d); next(); });

app.use('/', require('./routes/public'));
app.use('/pareja', require('./routes/pair'));
app.use('/admin', require('./routes/admin'));
app.use('/recepcion', require('./routes/recepcion'));

// 404
app.use((req, res) => res.status(404).renderPage('public/404', {}));

app.listen(PORT, () => {
  console.log(`Liga padel escuchando en http://localhost:${PORT}`);
});
