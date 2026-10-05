// Aviso por email a la pareja rival al subir un resultado pendiente de validar.
// Sin BREVO_API_KEY/MAIL_FROM no se intenta ningún envío (skipped).
const DATA = '/tmp/test-notify/data26';
process.env.DATA_DIR = DATA;
delete process.env.BREVO_API_KEY;
delete process.env.MAIL_FROM;
require('fs').rmSync(DATA, { recursive: true, force: true });

const { db } = require('../src/db');
const { sendEmail, mailConfigured, esc } = require('../src/lib/email');
const N = require('../src/lib/result-notify');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

(async () => {
// ---- email.js ----
let r = await sendEmail('a@x.es', 's', '<p>h</p>');
ok(r.skipped === true, 'sendEmail sin clave → skipped (no hace fetch)');
ok(mailConfigured() === false, 'mailConfigured() false sin variables');

ok(esc('<b>A&B</b>') === '&lt;b&gt;A&amp;B&lt;/b&gt;', 'esc() escapa HTML');
ok(esc(null) === '', 'esc(null) → cadena vacía');

// ---- datos de prueba ----
const mkPlayer = (name, email) =>
  db.prepare('INSERT INTO players(name, email, phone) VALUES(?, ?, ?)').run(name, email, '600000000').lastInsertRowid;
const p1 = mkPlayer('Ana Subidora', 'ana@x.es');
const p2 = mkPlayer('Beto Subidor', '');                       // sin email
const p3 = mkPlayer('Carla Rival', 'carla@x.es');
const p4 = mkPlayer('Dani Rival', 'dani@x.es');
const mkPair = (code, a, b) =>
  db.prepare("INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, status) VALUES(?, 'M', ?, ?, ?, 'active')")
    .run(code, a, b, a).lastInsertRowid;
const pairA = mkPair('CODEA', p1, p2);   // quien sube el resultado
const pairB = mkPair('CODEB', p3, p4);   // rival
const gid = db.prepare("INSERT INTO groups(category, round_no, group_no) VALUES('M', 1, 2)").run().lastInsertRowid;
const mkMatch = (extra = {}) => {
  const base = { category: 'M', stage: 'groups', round_no: 1, group_id: gid, pair_a_id: pairA, pair_b_id: pairB,
    s1a: 6, s1b: 4, s2a: 3, s2b: 6, stb_a: 10, stb_b: 8,
    winner_id: pairA, submitted_by: pairA, validation: 'pending' };
  const m = { ...base, ...extra };
  const cols = Object.keys(m).join(',');
  const vals = Object.values(m);
  return db.prepare(`INSERT INTO matches(${cols}) VALUES(${vals.map(() => '?').join(',')})`).run(...vals).lastInsertRowid;
};

// ---- formatScore ----
const gm = (id) => db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
const mid1 = mkMatch();
ok(N.formatScore(gm(mid1)) === '6-4, 3-6, súper tie-break 10-8', 'formatScore con STB');
const mid2 = mkMatch({ s1a: 6, s1b: 2, s2a: 6, s2b: 3, stb_a: null, stb_b: null });
ok(N.formatScore(gm(mid2)) === '6-2, 6-3', 'formatScore dos sets');
const mid3 = mkMatch({ wo_winner_id: pairA });
ok(N.formatScore(gm(mid3)) === 'W.O.', 'formatScore W.O.');

// ---- matchContext ----
ok(N.matchContext(db, gm(mid1)) === 'Masculina · Ronda 1 · Grupo 2', 'contexto de grupos');
const midPo = mkMatch({ stage: 'po1', round_no: null, group_id: null });
ok(N.matchContext(db, gm(midPo)) === 'Masculina · Playoff 1ª', 'contexto de playoff');

// ---- validationEmailData ----
const d = N.validationEmailData(db, mid1, 'https://kanbe.padelvalles.com', 'Kanbe');
ok(d !== null, 'hay datos de email');
ok(JSON.stringify(d.recipients) === JSON.stringify(['carla@x.es', 'dani@x.es']),
  'destinatarios = los dos jugadores de la rival (la que sube, excluida)');
ok(!d.recipients.includes('ana@x.es'), 'la remitente no se avisa a sí misma');
ok(d.subject.includes('Kanbe'), 'asunto con nombre del club');
ok(d.html.includes('6-4, 3-6, súper tie-break 10-8'), 'html con el marcador');
ok(d.html.includes('Ana Subidora / Beto Subidor'), 'html con la pareja que sube');
ok(d.html.includes('https://kanbe.padelvalles.com/acceso'), 'html con enlace a /acceso');
ok(d.html.includes('24 horas'), 'html avisa de la validación automática');

const dWo = N.validationEmailData(db, mid3, 'https://kanbe.padelvalles.com/', 'Kanbe');
ok(dWo && dWo.html.includes('W.O.'), 'W.O. mencionado en el html');

// rival sin emails → null
db.prepare('UPDATE players SET email = ? WHERE id IN (?, ?)').run('', p3, p4);
ok(N.validationEmailData(db, mid1, 'https://x.es', 'Kanbe') === null, 'sin emails en la rival → null (no se avisa)');
db.prepare('UPDATE players SET email = ? WHERE id = ?').run('carla@x.es', p3);

// emails duplicados se unifican
db.prepare('UPDATE players SET email = ? WHERE id = ?').run('carla@x.es', p4);
const dDup = N.validationEmailData(db, mid1, 'https://x.es', 'Kanbe');
ok(dDup && dDup.recipients.length === 1, 'email duplicado → un solo destinatario');
db.prepare('UPDATE players SET email = ? WHERE id = ?').run('dani@x.es', p4);

// no pendiente → null
const mid4 = mkMatch({ validation: 'validated' });
ok(N.validationEmailData(db, mid4, 'https://x.es', 'Kanbe') === null, 'ya validado → null');

// ---- notifyRivalValidation nunca lanza y no envía sin clave ----
const n1 = await N.notifyRivalValidation(db, mid1, 'https://kanbe.padelvalles.com', 'Kanbe');
ok(n1.ok === true && n1.results.every(x => x.skipped), 'notify sin clave → ok con skipped, sin fetch');
const n2 = await N.notifyRivalValidation(db, 99999, 'https://x.es', 'Kanbe');
ok(n2.skipped === true, 'partido inexistente → skipped');
const n3 = await N.notifyRivalValidation(db, mid4, 'https://x.es', 'Kanbe');
ok(n3.skipped === true, 'no pendiente → skipped');

// ---- la ruta existe y el módulo carga ----
require('../src/routes/pair.js');
ok(true, 'pair.js carga con el hook de notificación');

console.log(`\n${pass} OK, ${fail} fallos`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e); process.exit(1); });
