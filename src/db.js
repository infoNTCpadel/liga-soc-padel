// Base de datos SQLite (node:sqlite, sin dependencias nativas).
// Toda la persistencia de la liga vive aquí.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'liga.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

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
  gender TEXT NOT NULL DEFAULT 'M',       -- M | F
  shirt INTEGER NOT NULL DEFAULT 0,       -- 1 = quiere camiseta
  shirt_size TEXT NOT NULL DEFAULT '',
  paid INTEGER NOT NULL DEFAULT 0,        -- 1 = ha pagado en el club
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,              -- código de acceso de la pareja
  category TEXT NOT NULL,                 -- M | F (categoría de juego)
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
  category TEXT NOT NULL,                 -- M | F
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
  category TEXT NOT NULL,                 -- M | F
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

db.exec(SCHEMA);

// ---- settings helpers ----
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// Valores por defecto de la temporada (normativa 2026/27)
const DEFAULTS = {
  club_name: 'Master Padel League',
  season_name: 'Temporada 2026/27',
  phase_insc_ini: '2026-08-24', phase_insc_fin: '2026-10-02', phase_insc_label: 'Inscripciones',
  phase_r1_ini: '2026-10-05',  phase_r1_fin: '2026-11-01',  phase_r1_label: 'Ronda 1 · Fase de Grupos',
  phase_r2_ini: '2026-11-02',  phase_r2_fin: '2026-11-29',  phase_r2_label: 'Ronda 2 · Fase de Grupos',
  phase_r3_ini: '2026-11-30',  phase_r3_fin: '2026-12-27',  phase_r3_label: 'Ronda 3 · Fase de Grupos',
  phase_po_ini: '2026-12-28',  phase_po_fin: '2027-01-31',  phase_po_label: 'Playoffs del Club',
  phase_mf_label: 'Master Final', phase_mf_dates: '22 – 23 de mayo',
  round1_closed: '0', round2_closed: '0', round3_closed: '0',
  playoffs_generated: '0',
  inscription_price: '19.95', shirt_price: '14.95',
};
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (getSetting(k) === null) setSetting(k, v);
}

module.exports = { db, getSetting, setSetting };
