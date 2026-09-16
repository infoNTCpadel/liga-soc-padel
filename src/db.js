// Base de datos SQLite (node:sqlite, sin dependencias nativas).
//
// Arquitectura de temporadas:
// - `meta.db`: lista de temporadas (una activa) + ajustes globales
//   (p. ej. la contraseña de la organización).
// - `season-<id>.db`: todos los datos de cada temporada (parejas, grupos,
//   partidos, ajustes propios como precios o fechas...).
// El objeto `db` exportado es un proxy que siempre apunta a la BD de la
// temporada activa, así que el resto del código no cambia.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- meta.db
const meta = new DatabaseSync(path.join(DATA_DIR, 'meta.db'));
meta.exec(`CREATE TABLE IF NOT EXISTS seasons(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
meta.exec('CREATE TABLE IF NOT EXISTS meta_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');

function metaGet(key, fallback = null) {
  const r = meta.prepare('SELECT value FROM meta_settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
function metaSet(key, value) {
  meta.prepare('INSERT INTO meta_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// ------------------------------------------------- esquema de temporada
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',      -- text | select | yesno
  options TEXT NOT NULL DEFAULT '[]',     -- JSON array (para select)
  required INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  level REAL NOT NULL DEFAULT 2.5,
  gender TEXT NOT NULL DEFAULT 'M',
  shirt INTEGER NOT NULL DEFAULT 0,       -- 1 = quiere camiseta
  shirt_size TEXT NOT NULL DEFAULT '',
  paid INTEGER NOT NULL DEFAULT 0,        -- 1 = ha pagado en el club
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,              -- código de acceso de la pareja
  category TEXT NOT NULL,                 -- M | F | X (categoría de juego)
  player1_id INTEGER NOT NULL REFERENCES players(id),
  player2_id INTEGER NOT NULL REFERENCES players(id),
  captain_id INTEGER NOT NULL REFERENCES players(id),
  level_avg REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | rejected | withdrawn
  changes_used INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS registration_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES custom_questions(id) ON DELETE CASCADE,
  answer TEXT NOT NULL DEFAULT '',
  UNIQUE(pair_id, question_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,                 -- M | F | X
  round_no INTEGER NOT NULL,              -- 1, 2, 3
  group_no INTEGER NOT NULL,              -- 1..N
  UNIQUE(category, round_no, group_no)
);

CREATE TABLE IF NOT EXISTS group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  UNIQUE(group_id, pair_id)
);

-- Resultado consolidado de una pareja en una ronda (se rellena al cerrar la ronda)
CREATE TABLE IF NOT EXISTS round_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  group_no INTEGER NOT NULL,
  position INTEGER NOT NULL,
  round_points INTEGER NOT NULL,
  movement INTEGER NOT NULL DEFAULT 0,   -- delta de grupos (+2,+1,0,-1,-2)
  target_group INTEGER NOT NULL,
  UNIQUE(pair_id, round_no)
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,                 -- M | F | X
  stage TEXT NOT NULL DEFAULT 'groups',   -- groups | po1 | po2
  round_no INTEGER,                       -- 1..3 cuando stage='groups'
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  bracket_round TEXT,                     -- R32 | R16 | QF | SF | F (playoffs)
  bracket_slot INTEGER,                   -- posición dentro de la ronda del cuadro
  pair_a_id INTEGER REFERENCES pairs(id) ON DELETE SET NULL,
  pair_b_id INTEGER REFERENCES pairs(id) ON DELETE SET NULL,
  s1a INTEGER, s1b INTEGER,
  s2a INTEGER, s2b INTEGER,
  s3a INTEGER, s3b INTEGER,               -- tercer set pactado (cuenta como STB)
  stb_a INTEGER, stb_b INTEGER,           -- súper tie-break
  winner_id INTEGER REFERENCES pairs(id) ON DELETE SET NULL,
  wo_winner_id INTEGER REFERENCES pairs(id) ON DELETE SET NULL, -- ganador por W.O.
  unplayed INTEGER NOT NULL DEFAULT 0,   -- partido no jugado
  outside_club INTEGER NOT NULL DEFAULT 0,
  submitted_by INTEGER REFERENCES pairs(id) ON DELETE SET NULL,
  submitted_at TEXT,
  validation TEXT NOT NULL DEFAULT 'none', -- none | pending | validated | disputed | auto
  validation_deadline TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pair_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  old_player_id INTEGER NOT NULL REFERENCES players(id),
  new_name TEXT NOT NULL,
  new_email TEXT NOT NULL DEFAULT '',
  new_phone TEXT NOT NULL DEFAULT '',
  new_level REAL NOT NULL,
  new_gender TEXT NOT NULL DEFAULT 'M',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_matches_stage ON matches(stage, category, round_no, group_id);
CREATE INDEX IF NOT EXISTS idx_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_results_pair ON round_results(pair_id);
`;

// Valores por defecto de cada temporada
const DEFAULTS = {
  club_name: 'Master Padel League',
  season_name: 'Temporada 2026/27',
  phase_insc_ini: '2026-08-24', phase_insc_fin: '2026-10-02', phase_insc_label: 'Inscripciones',
  phase_r1_ini: '2026-10-05',  phase_r1_fin: '2026-11-01',  phase_r1_label: 'Ronda 1 · Fase de Grupos',
  phase_r2_ini: '2026-11-02',  phase_r2_fin: '2026-11-29',  phase_r2_label: 'Ronda 2 · Fase de Grupos',
  phase_r3_ini: '2026-11-30',  phase_r3_fin: '2026-12-27',  phase_r3_label: 'Ronda 3 · Fase de Grupos',
  phase_po_ini: '2026-12-28',  phase_po_fin: '2027-01-31',  phase_po_label: 'Playoffs del Club',
  round1_closed: '0', round2_closed: '0', round3_closed: '0',
  playoffs_generated: '0',
  inscription_price: '19.95', shirt_price: '14.95',
};

function seasonPath(id) {
  return path.join(DATA_DIR, `season-${id}.db`);
}

const openDbs = new Map();
function seasonDb(id) {
  if (!openDbs.has(id)) {
    const sdb = new DatabaseSync(seasonPath(id));
    sdb.exec('PRAGMA journal_mode = WAL;');
    sdb.exec('PRAGMA foreign_keys = ON;');
    sdb.exec(SCHEMA);
    openDbs.set(id, sdb);
  }
  return openDbs.get(id);
}

function seedSeason(id, name) {
  const sdb = seasonDb(id);
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const val = k === 'season_name' ? name : v;
    if (!sdb.prepare('SELECT 1 FROM settings WHERE key = ?').get(k)) {
      sdb.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run(k, val);
    }
  }
}

// ---- gestión de temporadas (meta.db) ----
function listSeasons() {
  return meta.prepare('SELECT * FROM seasons ORDER BY id').all();
}
function getActiveSeasonId() {
  const r = meta.prepare('SELECT id FROM seasons WHERE active = 1').get();
  if (r) return r.id;
  const f = meta.prepare('SELECT id FROM seasons ORDER BY id LIMIT 1').get();
  if (f) { activateSeason(f.id); return f.id; }
  const id = createSeason('Temporada 2026/27');
  activateSeason(id);
  return id;
}
function getActiveSeason() {
  return meta.prepare('SELECT * FROM seasons WHERE id = ?').get(getActiveSeasonId());
}
function createSeason(name) {
  const r = meta.prepare('INSERT INTO seasons(name, active) VALUES(?, 0)').run(name);
  const id = Number(r.lastInsertRowid);
  seedSeason(id, name);
  return id;
}
function activateSeason(id) {
  if (!meta.prepare('SELECT 1 FROM seasons WHERE id = ?').get(id)) return false;
  meta.exec('UPDATE seasons SET active = 0');
  meta.prepare('UPDATE seasons SET active = 1 WHERE id = ?').run(id);
  return true;
}
function renameSeason(id, name) {
  meta.prepare('UPDATE seasons SET name = ? WHERE id = ?').run(name, id);
}
function deleteSeason(id) {
  if (id === getActiveSeasonId()) return false;
  if (!meta.prepare('SELECT 1 FROM seasons WHERE id = ?').get(id)) return false;
  if (openDbs.has(id)) { openDbs.get(id).close(); openDbs.delete(id); }
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    const f = seasonPath(id) + ext;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  meta.prepare('DELETE FROM seasons WHERE id = ?').run(id);
  return true;
}

// ---- migración desde la versión de una sola BD (liga.db) ----
(function migrateLegacy() {
  if (meta.prepare('SELECT COUNT(*) c FROM seasons').get().c > 0) return;
  const legacy = path.join(DATA_DIR, 'liga.db');
  if (fs.existsSync(legacy)) {
    const ldb = new DatabaseSync(legacy);
    ldb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const sname = ldb.prepare("SELECT value FROM settings WHERE key = 'season_name'").get();
    const hash = ldb.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get();
    ldb.close();
    const name = sname ? sname.value : 'Temporada 2026/27';
    const r = meta.prepare('INSERT INTO seasons(name, active) VALUES(?, 1)').run(name);
    const id = Number(r.lastInsertRowid);
    fs.renameSync(legacy, seasonPath(id));
    for (const ext of ['-wal', '-shm', '-journal']) {
      const f = legacy + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (hash) metaSet('admin_password_hash', hash.value);
    const migrated = seasonDb(id);
    migrated.prepare("DELETE FROM settings WHERE key = 'admin_password_hash'").run();
  } else {
    const id = createSeason('Temporada 2026/27');
    activateSeason(id);
  }
})();

// ---- proxy: `db` siempre apunta a la temporada activa ----
const db = new Proxy({}, {
  get(_t, prop) {
    const sdb = seasonDb(getActiveSeasonId());
    const v = sdb[prop];
    return typeof v === 'function' ? v.bind(sdb) : v;
  },
});

// ---- settings de la temporada activa ----
function getSetting(key, fallback = null) {
  const row = seasonDb(getActiveSeasonId()).prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  seasonDb(getActiveSeasonId())
    .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// ---- contraseña de la organización (global, en meta.db) ----
function getAdminHash() { return metaGet('admin_password_hash'); }
function setAdminHash(h) { metaSet('admin_password_hash', h); }

module.exports = {
  db, getSetting, setSetting, getAdminHash, setAdminHash,
  listSeasons, getActiveSeason, getActiveSeasonId,
  createSeason, activateSeason, renameSeason, deleteSeason,
  seasonDb,
};
