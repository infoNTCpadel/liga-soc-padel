// Eventos: estados (abierta/en juego/cerrada/finalizada/oculta) y sin nº de socio en la confirmación.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3475;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-ev/data31';
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

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), pub = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });

  // 1. Nuevo evento → estado abierta por defecto
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Evento A', event_date: '2026-12-20', format: 'americana', price: '0', max_players: '0', mode: 'individual',
  });
  const evA = mdb("SELECT * FROM events WHERE name = 'Evento A'")[0];
  ok(evA.status === 'abierta', 'estado por defecto: abierta');

  // 2. La confirmación NO muestra el nº de socio
  let r = await pub.req('POST', `/eventos/${evA.slug}/inscribir`, { name: 'Sin Numero', phone: '612400001', level: '3' });
  ok(r.location.includes('ok=1'), 'inscripción OK');
  r = await pub.req('GET', `/eventos/${evA.slug}?ok=1`);
  ok(!r.text.includes('NV-') && !r.text.includes('nº de socio'), 'confirmación sin nº de socio');

  // 3. En juego: se ve pero sin formulario; no admite inscripciones
  await admin.req('POST', `/admin/eventos/${evA.id}/estado`, { status: 'en_juego' });
  r = await pub.req('GET', '/eventos/' + evA.slug);
  ok(r.text.includes('En juego') && !r.text.includes('Apuntarme</h3>'), 'landing en juego sin formulario');
  r = await pub.req('POST', `/eventos/${evA.slug}/inscribir`, { name: 'X', phone: '612400002', level: '3' });
  ok(decodeURIComponent(r.location).includes('no están abiertas'), 'en juego no admite inscribir');
  r = await pub.req('GET', '/eventos');
  ok(r.text.includes('Evento A') && r.text.includes('En juego'), 'índice muestra en juego');

  // 4. Finalizada: mensaje y pasa a Anteriores
  await admin.req('POST', `/admin/eventos/${evA.id}/estado`, { status: 'finalizada' });
  r = await pub.req('GET', '/eventos/' + evA.slug);
  ok(r.text.includes('Finalizado'), 'landing de finalizada');
  r = await pub.req('GET', '/eventos');
  ok(r.text.includes('Anteriores') && r.text.includes('Evento A'), 'finalizada en Anteriores');

  // 5. Oculta: 404 y fuera del índice (también el POST)
  await admin.req('POST', `/admin/eventos/${evA.id}/estado`, { status: 'oculta' });
  r = await pub.req('GET', '/eventos/' + evA.slug);
  ok(r.statusCode === 404, 'oculta → 404');
  r = await pub.req('POST', `/eventos/${evA.slug}/inscribir`, { name: 'X', phone: '612400003', level: '3' });
  ok(r.statusCode === 404, 'POST en oculta → 404');
  r = await pub.req('GET', '/eventos');
  ok(!r.text.includes('Evento A'), 'oculta fuera del índice');

  // 6. El admin sí ve los ocultos
  r = await admin.req('GET', '/admin/eventos');
  ok(r.text.includes('Evento A') && r.text.includes('No visible'), 'admin ve el oculto con su estado');
  r = await admin.req('GET', '/admin/eventos/' + evA.id);
  ok(r.statusCode === 200 && r.text.includes('No visible'), 'detalle del admin accesible');

  // 7. Estado inválido → se sanea a abierta
  await admin.req('POST', `/admin/eventos/${evA.id}/estado`, { status: 'invento' });
  ok(mdb("SELECT status FROM events WHERE name = 'Evento A'")[0].status === 'abierta', 'estado inválido se sanea');

  // 8. Crear ya oculto desde el formulario
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Evento B', event_date: '2026-12-21', format: 'quedada', price: '0', max_players: '0', mode: 'individual', status: 'oculta',
  });
  const evB = mdb("SELECT * FROM events WHERE name = 'Evento B'")[0];
  ok(evB.status === 'oculta', 'se puede crear oculto');
  r = await pub.req('GET', '/eventos/' + evB.slug);
  ok(r.statusCode === 404, 'el creado oculto no se ve');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
