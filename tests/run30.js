// Eventos: inscripción por parejas y modo mixto + emparejado manual (americanas).
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3474;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-ev/data30';
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
require('fs').rmSync(DATA, { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

function makeClient() {
  let cookie = '';
  const req = (m, p, d) => new Promise((res, rej) => {
    let b = null;
    if (d) {
      const u = new URLSearchParams();
      for (const k in d) [].concat(d[k]).forEach(v => u.append(k, v));
      b = u.toString();
    }
    const r = http.request({ port: PORT, path: p, method: m,
      headers: { ...(b ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (rs) => {
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
const pairForm = (a, b, extra = {}) => ({
  p1_name: a[0], p1_phone: a[1], p1_level: a[2] || '3', p1_gender: 'M',
  p2_name: b[0], p2_phone: b[1], p2_level: b[2] || '3', p2_gender: 'F', ...extra,
});

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), pub = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });

  // 1. Evento modo parejas
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Torneo de parejas', event_date: '2026-12-20', format: 'torneo', price: '20', max_players: '0', mode: 'pairs',
  });
  const ev = mdb('SELECT * FROM events')[0];
  ok(ev.inscription_mode === 'pairs', 'modo parejas guardado');
  let r = await pub.req('GET', '/eventos/' + ev.slug);
  ok(r.statusCode === 200 && r.text.includes('Jugador 2') && r.text.includes('Apuntar a la pareja'), 'landing con formulario de pareja');

  // 2. Inscripción de pareja: 2 personas en el directorio + 2 filas vinculadas
  r = await pub.req('POST', `/eventos/${ev.slug}/inscribir`, pairForm(['Ana', '612300001'], ['Beto', '612300002']));
  ok(r.statusCode === 302 && r.location.includes('ok=1'), 'pareja inscrita OK');
  const rows = mdb('SELECT * FROM event_inscriptions WHERE event_id = ?', ev.id);
  ok(rows.length === 2 && rows[0].pair_key !== '' && rows[0].pair_key === rows[1].pair_key, '2 filas con el mismo pair_key');
  ok(mdb('SELECT COUNT(*) c FROM club_members WHERE phone_norm IN (?, ?)', '612300001', '612300002')[0].c === 2,
    'los 2 entran en el directorio único');

  // 3. Misma persona dos veces → error
  r = await pub.req('POST', `/eventos/${ev.slug}/inscribir`, pairForm(['Ana', '612300001'], ['Ana', '612300001']));
  ok(decodeURIComponent(r.location).includes('compartir teléfono') || decodeURIComponent(r.location).includes('misma persona'), 'no vale la misma persona');

  // 4. Uno ya inscrito → error, sin duplicar
  const before = mdb('SELECT COUNT(*) c FROM event_inscriptions WHERE event_id = ?', ev.id)[0].c;
  r = await pub.req('POST', `/eventos/${ev.slug}/inscribir`, pairForm(['Ana', '612300001'], ['Carlos', '612300003']));
  ok(r.location.includes('error='), 'jugador repetido → error');
  ok(mdb('SELECT COUNT(*) c FROM event_inscriptions WHERE event_id = ?', ev.id)[0].c === before, 'no se duplica nada');

  // 5. Plazas: la pareja consume 2
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Mini', event_date: '2026-12-21', format: 'americana', price: '0', max_players: '3', mode: 'mixed',
  });
  const mex = mdb("SELECT * FROM events WHERE name = 'Mini'")[0];
  // 6. Landing mixta ofrece las dos opciones (antes de llenar plazas)
  r = await pub.req('GET', '/eventos/' + mex.slug);
  ok(r.text.includes('Voy solo/a') && r.text.includes('Vamos en pareja'), 'mixto ofrece solo/pareja');
  r = await pub.req('POST', `/eventos/${mex.slug}/inscribir`, { ...pairForm(['D1', '612300011'], ['D2', '612300012']), kind: 'pareja' });
  ok(r.location.includes('ok=1'), 'pareja en mixto OK (2 plazas)');
  r = await pub.req('POST', `/eventos/${mex.slug}/inscribir`, { ...pairForm(['E1', '612300013'], ['E2', '612300014']), kind: 'pareja' });
  ok(decodeURIComponent(r.location).includes('1 plaza'), 'con 1 plaza libre la pareja no cabe');
  r = await pub.req('POST', `/eventos/${mex.slug}/inscribir`, { kind: 'solo', p1_name: 'Suelto', p1_phone: '612300015', p1_level: '3' });
  ok(r.location.includes('ok=1'), 'individual sí cabe en la última plaza');

  // 7. Admin: emparejar dos sueltos (americana) y desemparejar
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Americana X', event_date: '2026-12-22', format: 'americana', price: '0', max_players: '0', mode: 'individual',
  });
  const amx = mdb("SELECT * FROM events WHERE name = 'Americana X'")[0];
  await pub.req('POST', `/eventos/${amx.slug}/inscribir`, { name: 'S1', phone: '612300021', level: '3' });
  await pub.req('POST', `/eventos/${amx.slug}/inscribir`, { name: 'S2', phone: '612300022', level: '3' });
  const ids = mdb('SELECT id FROM event_inscriptions WHERE event_id = ? ORDER BY id', amx.id).map(x => x.id);
  r = await admin.req('POST', `/admin/eventos/${amx.id}/emparejar`, { sel: ids });
  const paired = mdb('SELECT pair_key FROM event_inscriptions WHERE event_id = ?', amx.id);
  ok(paired[0].pair_key !== '' && paired[0].pair_key === paired[1].pair_key, 'admin empareja 2 sueltos');
  r = await admin.req('GET', '/admin/eventos/' + amx.id);
  ok(r.text.includes('🤝 S2') || r.text.includes('🤝 S1'), 'detalle muestra la pareja');
  r = await admin.req('POST', `/admin/eventos/${amx.id}/inscripcion/${ids[0]}/desemparejar`, {});
  ok(mdb("SELECT COUNT(*) c FROM event_inscriptions WHERE event_id = ? AND pair_key != ''", amx.id)[0].c === 0, 'desemparejar libera');
  // emparejar con solo 1 seleccionado → error amable
  r = await admin.req('POST', `/admin/eventos/${amx.id}/emparejar`, { sel: [ids[0]] });
  ok(decodeURIComponent(r.location).includes('exactamente 2'), 'emparejar con 1 → error');

  // 8. CSV con columna de pareja
  r = await admin.req('GET', `/admin/eventos/${ev.id}/csv`);
  ok(r.statusCode === 200 && r.text.includes('pareja') && r.text.includes('Beto'), 'CSV incluye la pareja');

  // 9. inscribePair en evento individual → rechazado
  r = await pub.req('POST', `/eventos/${amx.slug}/inscribir`, { ...pairForm(['F1', '612300031'], ['F2', '612300032']), kind: 'pareja' });
  ok(decodeURIComponent(r.location).includes('no admite'), 'evento individual rechaza parejas');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
