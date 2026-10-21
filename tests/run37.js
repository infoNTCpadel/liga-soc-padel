// Eventos: la capa extra de seguridad del reconocimiento (móvil + nº de socio).
// Sin la pareja correcta no se revela ni se autorrellena nada; NV-* no vale.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3487;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-ev/data37';
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

  // Evento A: entran una socia (S200) y un invitado sin nº (quedará NV-)
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Evento A', event_date: '2026-12-20', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta',
  });
  const evA = mdb("SELECT * FROM events WHERE name = 'Evento A'")[0];
  await pub.req('POST', `/eventos/${evA.slug}/inscribir`, {
    name: 'Socia Uno', phone: '612345678', level: '2.95', gender: 'F', member_no: 'S200',
  });
  await pub.req('POST', `/eventos/${evA.slug}/inscribir`, {
    name: 'Invitado Uno', phone: '612345679', level: '1.95', gender: 'M',
  });
  const invitado = mdb("SELECT * FROM club_members WHERE phone = '612345679'")[0];
  ok(invitado && invitado.member_no.startsWith('NV-'), 'invitado con nº interno NV-');

  // --- API de reconocimiento ---
  // 1. Solo teléfono (sin nº) → nada
  let r = await pub.req('GET', '/eventos/api/reconocer?phone=612345678');
  ok(JSON.parse(r.text).found === false, 'sin nº de socio → found false');
  // 2. Nº equivocado → nada
  r = await pub.req('GET', '/eventos/api/reconocer?phone=612345678&member_no=S999');
  ok(JSON.parse(r.text).found === false, 'nº equivocado → found false');
  // 3. Nº de OTRA persona → nada (no vale mezclar fichas)
  r = await pub.req('GET', '/eventos/api/reconocer?phone=612345679&member_no=S200');
  ok(JSON.parse(r.text).found === false, 'nº de otra ficha → found false');
  // 4. El nº NV- del invitado NO abre la puerta (se deduce del teléfono)
  r = await pub.req('GET', `/eventos/api/reconocer?phone=612345679&member_no=${invitado.member_no}`);
  ok(JSON.parse(r.text).found === false, 'nº NV-* → found false');
  // 5. Pareja correcta (aunque sea en minúsculas) → datos
  r = await pub.req('GET', '/eventos/api/reconocer?phone=612345678&member_no=s200');
  const j = JSON.parse(r.text);
  ok(j.found === true && j.name === 'Socia Uno' && j.socio === true, 'pareja correcta → reconocido');

  // --- Autorrelleno del servidor al inscribir ---
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Evento B', event_date: '2026-12-21', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta',
  });
  const evB = mdb("SELECT * FROM events WHERE name = 'Evento B'")[0];
  // 6. Teléfono conocido + nº MALO + sin nombre/nivel → error, no se inscribe
  r = await pub.req('POST', `/eventos/${evB.slug}/inscribir`, { phone: '612345678', member_no: 'S999' });
  ok((r.location || '').includes('error='), 'nº malo sin datos → error: ' + r.location);
  ok(mdb('SELECT COUNT(*) c FROM event_inscriptions WHERE event_id = ?', evB.id)[0].c === 0, 'no se creó la inscripción');
  // 7. Teléfono conocido SIN nº + sin nombre/nivel → error también
  r = await pub.req('POST', `/eventos/${evB.slug}/inscribir`, { phone: '612345678' });
  ok((r.location || '').includes('error='), 'sin nº sin datos → error');
  // 8. Pareja correcta + sin nombre/nivel → se inscribe con los datos de la ficha
  r = await pub.req('POST', `/eventos/${evB.slug}/inscribir`, { phone: '612345678', member_no: 'S200' });
  ok((r.location || '').includes('ok=1'), 'pareja correcta → inscrito');
  const insc = mdb('SELECT * FROM event_inscriptions WHERE event_id = ?', evB.id)[0];
  ok(insc && insc.name === 'Socia Uno', 'nombre tomado de la ficha');
  // 9. El camino manual sigue abierto: datos completos con nº malo SÍ inscribe
  //    (la capa protege el atajo, no bloquea el formulario de siempre)
  r = await pub.req('POST', `/eventos/${evB.slug}/inscribir`, {
    name: 'Invitado Uno', phone: '612345679', level: '1.95', member_no: 'LOQUESEA',
  });
  ok((r.location || '').includes('ok=1') || (r.location || '').includes('ya está inscrito'),
    'formulario manual completo sigue funcionando: ' + r.location);

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
