// Eventos: reconocimiento por teléfono (autorrelleno real desde el directorio).
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3485;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-ev/data36';
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
require('fs').rmSync(DATA, { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

function makeClient() {
  let cookie = '';
  const req = (m, p, d) => new Promise((res, rej) => {
    let b = null; const h = {};
    if (d) {
      const u = new URLSearchParams();
      for (const k in d) [].concat(d[k]).forEach(v => u.append(k, v));
      b = u.toString(); h['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ port: PORT, path: p, method: m, headers: h }, (rs) => {
      let t = ''; rs.on('data', c => t += c); rs.on('end', () => {
        const sc = rs.headers['set-cookie']; if (sc && sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
        res({ statusCode: rs.statusCode, location: rs.headers.location || '', text: t });
      });
    });
    r.on('error', rej); if (b) r.write(b); r.end();
  });
  return { req };
}
const { DatabaseSync } = require('node:sqlite');
const mdb = (sql, ...p) => { const d = new DatabaseSync(DATA + '/meta.db'); try { return d.prepare(sql).all(...p); } finally { d.close(); } };

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), pub = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });

  // Evento A: una socia se inscribe con todos sus datos (entra en el directorio)
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Evento A', event_date: '2026-12-20', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta',
  });
  const evA = mdb("SELECT * FROM events WHERE name = 'Evento A'")[0];
  let r = await pub.req('POST', `/eventos/${evA.slug}/inscribir`, {
    name: 'Conocida Uno', phone: '612345678', level: '2.95', gender: 'F', member_no: 'S200', email: 'conocida@x.es',
  });
  ok((r.location || '').includes('ok=1'), 'alta inicial completa');

  // 1. La API de reconocimiento la encuentra con lo justo (sin email ni nº)
  r = await pub.req('GET', '/eventos/api/reconocer?phone=612345678&member_no=S200');
  const j = JSON.parse(r.text);
  ok(j.found === true && j.name === 'Conocida Uno' && j.level === 3 && j.gender === 'F' && j.socio === true,
    'reconocer devuelve nombre/nivel/sexo/socio: ' + r.text);
  ok(!('email' in j) && !('member_no' in j), 'la API NO expone email ni nº de socio');

  // 2. Teléfono desconocido / inválido → found false
  r = await pub.req('GET', '/eventos/api/reconocer?phone=699999999');
  ok(JSON.parse(r.text).found === false, 'desconocido → found false');
  r = await pub.req('GET', '/eventos/api/reconocer?phone=123');
  ok(JSON.parse(r.text).found === false, 'inválido → found false');

  // 3. Evento B: inscribirse SOLO con el teléfono (sin nombre ni nivel) funciona
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Evento B', event_date: '2026-12-21', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta',
  });
  const evB = mdb("SELECT * FROM events WHERE name = 'Evento B'")[0];
  r = await pub.req('POST', `/eventos/${evB.slug}/inscribir`, { phone: '612345678', member_no: 'S200' });
  ok((r.location || '').includes('ok=1'), 'inscripción solo con teléfono: ' + r.location);
  const insc = mdb('SELECT * FROM event_inscriptions WHERE event_id = ?', evB.id)[0];
  ok(insc && insc.name === 'Conocida Uno' && insc.level === 3, 'nombre y nivel tomados de su ficha');

  // 4. Teléfono desconocido sin datos → error, no se crea nada
  r = await pub.req('POST', `/eventos/${evB.slug}/inscribir`, { phone: '699999998' });
  ok((r.location || '').includes('error='), 'desconocido sin datos → error');
  ok(mdb('SELECT COUNT(*) c FROM event_inscriptions WHERE event_id = ?', evB.id)[0].c === 1, 'sin inscripción fantasma');

  // 5. En parejas: el jugador 2 también se autorrellena solo con su teléfono
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Evento C', event_date: '2026-12-22', format: 'torneo', price: '0', max_players: '0', mode: 'pairs', status: 'abierta',
  });
  const evC = mdb("SELECT * FROM events WHERE name = 'Evento C'")[0];
  r = await pub.req('POST', `/eventos/${evC.slug}/inscribir`, {
    p1_name: 'Nuevo Uno', p1_phone: '612345679', p1_level: '1.95',
    p2_phone: '612345678', p2_member_no: 'S200',
  });
  ok((r.location || '').includes('ok=1'), 'pareja con p2 solo-teléfono: ' + r.location);
  const par = mdb('SELECT * FROM event_inscriptions WHERE event_id = ? ORDER BY id', evC.id);
  ok(par.length === 2 && par[1].name === 'Conocida Uno' && par[1].level === 3, 'p2 autorrellenado desde el directorio');

  // 6. La landing trae el botón de reconocimiento y el texto nuevo
  r = await pub.req('GET', `/eventos/${evB.slug}`);
  ok(r.text.includes('rec-btn') && r.text.includes('Reconocerme'), 'landing con botón Reconocerme');
  ok(r.text.includes('api/reconocer'), 'landing con el JS de reconocimiento');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
