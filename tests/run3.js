// Regresión v9e: nivel del admin + precio único en CSV, con el flujo de socio.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3463;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: '/tmp/test-v9e/datareg' };
require('fs').rmSync('/tmp/test-v9e/datareg', { recursive: true, force: true });
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };
let cookie = '';
const req = (m, p, d) => new Promise((res, rej) => {
  const b = d ? new URLSearchParams(d).toString() : null;
  const r = http.request({ port: PORT, path: p, method: m,
    headers: { ...(b ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (rs) => {
    let t = ''; rs.on('data', c => t += c); rs.on('end', () => {
      const sc = rs.headers['set-cookie']; if (sc && sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
      res({ statusCode: rs.statusCode, text: t });
    });
  });
  r.on('error', rej); if (b) r.write(b); r.end();
});
const dbq = (sql, ...p) => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync('/tmp/test-v9e/datareg/season-1.db'); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  await req('POST', '/admin/setup', { password: 'admin12345' });
  const P = (n, name, phone, gender, member) => ({ [`a_p${n}_name`]: name, [`a_p${n}_phone`]: phone, [`a_p${n}_gender`]: gender, [`a_p${n}_level`]: '3', [`a_p${n}_member`]: member });
  // Juan en M y en X
  await req('POST', '/inscripcion', { modality: 'M', ...P(1, 'Juan', '612000001', 'M', '1001'), ...P(2, 'Pedro', '612000002', 'M', '1002') });
  await req('POST', '/inscripcion', { modality: 'X', ...P(1, 'Juan', '612000001', 'M', '1001'), ...P(2, 'Ana', '612000003', 'F', '1003') });
  // verificar todos y activar
  for (const nm of ['Juan', 'Pedro', 'Ana']) {
    const id = dbq('SELECT id FROM players WHERE name=? ORDER BY id', nm).map(r => r.id);
    for (const i of id) await req('POST', '/admin/inscripciones/1/socio', { player_id: String(i), action: 'toggle' });
  }
  // propagación de nivel: cambiar el de Juan en la pareja 1 a 4
  const juanM = dbq("SELECT id FROM players WHERE name='Juan' ORDER BY id")[0].id;
  await req('POST', '/admin/inscripciones/1/nivel', { player_id: String(juanM), level: '4' });
  const jx = dbq("SELECT level FROM players WHERE name='Juan' ORDER BY id").map(r => r.level);
  ok(jx[0] === 4 && jx[1] === 4, 'nivel propagado a las dos parejas de Juan');
  const avgs = dbq('SELECT level_avg FROM pairs ORDER BY id').map(r => r.level_avg);
  ok(avgs[0] === 3.5 && avgs[1] === 3.5, 'niveles medios recalculados (3,5)');
  // CSV: precio único 25,00 en la primera aparición de Juan
  const r = await req('GET', '/admin/inscripciones.csv');
  const lines = r.text.split('\n');
  ok(lines[0].includes('precio_esperado1') && lines[0].includes('socio1'), 'csv cabecera ok');
  ok(lines[1].includes('"25,00"') && lines[2].includes('"0,00"'), 'precio único 25,00 / 0,00 en CSV');
  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO:', e.message); srv.kill(); process.exit(1); });
