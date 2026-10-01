// Crea una temporada de PRUEBA con parejas inventadas.
// Uso: node src/seed-test-season.js "Nombre de la temporada" [nM] [nF] [nX]
// Por defecto: 100 masculinas, 40 femeninas, 36 mixtas.
// La temporada se crea INACTIVA: actívala desde /admin/temporadas para probarla.
const { createSeason, seasonDb, getActiveSeason } = require('./db');

const MN = ['Alejandro','Pablo','Javier','Carlos','Diego','Hugo','Adrián','Sergio','David','Iván','Miguel','Raúl','Óscar','Rubén','Daniel','Andrés','Fernando','Jorge','Alberto','Víctor','Mario','Álvaro','Gonzalo','Nacho','Marcos','Iker','Unai','Pol','Marc','Joan','Quim','Oriol','Nil','Jan','Arnau','Roger','Xavi','Toni','Miquel','Jordi','Pau','Guillem','Enric','Lluc','Mateo','Leo','Thiago','Dylan','Eric','Joel'];
const FN = ['Lucía','Marta','Carmen','Laura','Sara','Elena','Paula','Ana','María','Claudia','Sofía','Irene','Nerea','Andrea','Carla','Júlia','Laia','Núria','Anna','Mireia','Cristina','Mónica','Silvia','Eva','Raquel','Nuria','Alicia','Beatriz','Patricia','Sandra','Marina','Aitana','Valeria','Daniela','Emma','Olivia','Alba','Noa','Iria','Uxía','Abril','Jana','Aina','Ona','Martina','Gala','Vega','Lola','Candela','Jimena'];
const SURN = ['García','Martínez','López','Sánchez','Pérez','Gómez','Fernández','Ruiz','Díaz','Moreno','Muñoz','Álvarez','Romero','Alonso','Gutiérrez','Navarro','Torres','Domingo','Vidal','Ramos','Blanco','Serrano','Molina','Morales','Ortega','Delgado','Castillo','Ortiz','Rubio','Marín','Sanz','Iglesias','Medina','Garrido','Cortés','Guerrero','Hernández','Flores','Prieto','Ferrer','Vicens','Costa','Roca','Puig','Solé','Batlle','Casas','Font','Serra','Miró','Vila','Rovira','Bosch','Sala','Martí','Pons','Soler','Mas','Vives'];
const SIZES = ['XS','S','M','L','XL','XXL'];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');

const usedPhones = new Set();
function genPhone() {
  let p;
  do { p = '6' + String(Math.floor(rnd(10000000, 99999999))); } while (usedPhones.has(p));
  usedPhones.add(p);
  return p;
}
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode(used) {
  let code;
  do { code = Array.from({ length: 6 }, () => pick(CODE_CHARS.split(''))).join(''); } while (used.has(code));
  used.add(code);
  return code;
}

function genPlayer(gender, minL, maxL, idx) {
  const first = gender === 'M' ? pick(MN) : pick(FN);
  const name = `${first} ${pick(SURN)} ${pick(SURN)}`;
  const level = Math.round(rnd(minL, maxL) * 10) / 10;
  const shirt = Math.random() < 0.5 ? 1 : 0;
  return {
    name,
    email: `${norm(first)}.${norm(pick(SURN))}${idx % 97}@prueba.local`,
    phone: genPhone(),
    level,
    gender,
    shirt,
    shirt_size: shirt ? pick(SIZES) : '',
    paid: Math.random() < 0.65 ? 1 : 0,
  };
}

function seedCategory(sdb, usedCodes, category, n, g1, g2, minL, maxL) {
  const insP = sdb.prepare('INSERT INTO players(name, email, phone, level, gender, shirt, shirt_size, paid, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insPair = sdb.prepare('INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, level_avg, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const p1 = genPlayer(g1, minL, maxL, idx++);
    const p2 = genPlayer(g2, minL, maxL, idx++);
    const day = String(1 + Math.floor(rnd(0, 28))).padStart(2, '0');
    const created = `2026-09-${day} ${String(Math.floor(rnd(8, 22))).padStart(2, '0')}:${String(Math.floor(rnd(0, 60))).padStart(2, '0')}:00`;
    const r1 = insP.run(p1.name, p1.email, p1.phone, p1.level, p1.gender, p1.shirt, p1.shirt_size, p1.paid, created);
    const r2 = insP.run(p2.name, p2.email, p2.phone, p2.level, p2.gender, p2.shirt, p2.shirt_size, p2.paid, created);
    const avg = Math.round(((p1.level + p2.level) / 2) * 100) / 100;
    insPair.run(genCode(usedCodes), category,
      Number(r1.lastInsertRowid), Number(r2.lastInsertRowid),
      Math.random() < 0.5 ? Number(r1.lastInsertRowid) : Number(r2.lastInsertRowid),
      avg, 'active', created);
  }
}

function main() {
  const name = (process.argv[2] || '').trim();
  if (!name) {
    console.error('Uso: node src/seed-test-season.js "Nombre de la temporada" [nM] [nF] [nX]');
    process.exit(1);
  }
  const nM = Number(process.argv[3] || 100);
  const nF = Number(process.argv[4] || 40);
  const nX = Number(process.argv[5] || 36);

  const id = createSeason(name);
  const sdb = seasonDb(id);
  const usedCodes = new Set();
  sdb.exec('BEGIN');
  try {
    seedCategory(sdb, usedCodes, 'M', nM, 'M', 'M', 2.0, 5.2);
    seedCategory(sdb, usedCodes, 'F', nF, 'F', 'F', 1.8, 4.8);
    seedCategory(sdb, usedCodes, 'X', nX, 'F', 'M', 2.0, 5.0);
    sdb.exec('COMMIT');
  } catch (e) {
    sdb.exec('ROLLBACK');
    throw e;
  }

  const counts = sdb.prepare('SELECT category, COUNT(*) c FROM pairs GROUP BY category').all();
  console.log(`Temporada de prueba creada: id=${id} "${name}" (INACTIVA)`);
  for (const c of counts) console.log(`  ${c.category}: ${c.c} parejas`);
  console.log(`Total parejas: ${counts.reduce((a, c) => a + c.c, 0)}`);
  const act = getActiveSeason();
  console.log(`Temporada activa actual: "${act.name}" (id=${act.id}) — la prueba NO la ha cambiado.`);
  console.log('Para probarla: entra en /admin → Temporadas → Activar.');
}

if (require.main === module) main();
