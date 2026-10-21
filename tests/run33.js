// Eventos: slug editable con redirección + doble precio socios / no socios.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3479;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-ev/data33';
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

  // --- SLUG ---
  // 1. Crear con slug personalizado
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Americana Halloween', event_date: '2026-10-31', format: 'americana',
    price: '10', price_nonmember: '15', max_players: '0', mode: 'individual', status: 'abierta',
    slug: 'americana-hallowen-31-octubre',
  });
  let ev = mdb("SELECT * FROM events WHERE name = 'Americana Halloween'")[0];
  ok(ev.slug === 'americana-hallowen-31-octubre', 'slug personalizado al crear');
  ok(ev.price_cents === 1000 && ev.price_nonmember_cents === 1500, 'doble precio guardado');

  // 2. Slug duplicado → error amable, sin crear
  let r = await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Copia', event_date: '2026-11-01', format: 'americana', price: '5',
    max_players: '0', mode: 'individual', status: 'abierta', slug: 'americana-hallowen-31-octubre',
  });
  ok(r.statusCode === 200 && r.text.includes('ya la usa otro evento'), 'slug duplicado rechazado');
  ok(mdb("SELECT COUNT(*) c FROM events WHERE name = 'Copia'")[0].c === 0, 'no se creó el duplicado');

  // 3. Renombrar el slug (corregir la errata) desde editar
  r = await admin.req('POST', `/admin/eventos/${ev.id}/editar`, {
    name: 'Americana Halloween', event_date: '2026-10-31', event_time: '', format: 'americana',
    price: '10', price_nonmember: '15', max_players: '0', mode: 'individual', status: 'abierta',
    slug: 'americana-halloween-31-octubre',
  });
  ok(r.statusCode === 302, 'editar con slug nuevo ok');
  ev = mdb('SELECT * FROM events WHERE id = ?', ev.id)[0];
  ok(ev.slug === 'americana-halloween-31-octubre', 'slug renombrado en BD');

  // 4. El slug viejo redirige al nuevo
  r = await pub.req('GET', '/eventos/americana-hallowen-31-octubre');
  ok(r.statusCode === 301 && r.location === '/eventos/americana-halloween-31-octubre', 'slug viejo → 301 al nuevo');
  r = await pub.req('GET', '/eventos/americana-halloween-31-octubre');
  ok(r.statusCode === 200 && r.text.includes('Americana Halloween'), 'landing con slug nuevo');

  // 5. Inscribirse usando el slug viejo también funciona (redirige internamente)
  r = await pub.req('POST', '/eventos/americana-hallowen-31-octubre/inscribir', {
    name: 'Visitante Uno', phone: '612345678', level: '2.95',
  });
  ok((r.location || '').includes('ok=1'), 'inscripción vía slug viejo ok: ' + r.location);

  // --- DOBLE PRECIO ---
  // 6. No socio (sin nº, teléfono nuevo → NV-) paga precio de no socio
  let insc = mdb('SELECT * FROM event_inscriptions WHERE event_id = ?', ev.id);
  ok(insc.length === 1 && insc[0].is_member === 0 && insc[0].price_cents === 1500,
    'no socio → 15 € congelados: ' + JSON.stringify(insc[0] && { m: insc[0].is_member, p: insc[0].price_cents }));

  // 7. Socio (con nº de socio real) paga precio de socio
  r = await pub.req('POST', '/eventos/americana-halloween-31-octubre/inscribir', {
    name: 'Socio Uno', phone: '612345679', level: '2.95', member_no: 'S100',
  });
  ok((r.location || '').includes('ok=1'), 'inscripción socio ok');
  insc = mdb('SELECT * FROM event_inscriptions WHERE event_id = ? ORDER BY id', ev.id);
  const socio = insc.find(x => x.member_no === 'S100');
  ok(socio && socio.is_member === 1 && socio.price_cents === 1000, 'socio → 10 € congelados');

  // 8. La landing muestra ambos precios
  r = await pub.req('GET', '/eventos/americana-halloween-31-octubre');
  ok(r.text.includes('Socios') && r.text.includes('10,00 €') && r.text.includes('15,00 €'), 'landing muestra doble precio');
  r = await pub.req('GET', '/eventos');
  ok(r.text.includes('Socios') && r.text.includes('No socios'), 'índice muestra doble precio');

  // 9. El admin ve precios y totales; puede corregir el tipo
  r = await admin.req('GET', `/admin/eventos/${ev.id}`);
  ok(r.text.includes('15,00 €') && r.text.includes('10,00 €') && r.text.includes('No socio') && r.text.includes('Pendiente'), 'detalle admin: precios y pendiente');
  const noSocio = insc.find(x => x.is_member === 0);
  r = await admin.req('POST', `/admin/eventos/${ev.id}/inscripcion/${noSocio.id}/tipo`, { member: '1' });
  const corregido = mdb('SELECT * FROM event_inscriptions WHERE id = ?', noSocio.id)[0];
  ok(corregido.is_member === 1 && corregido.price_cents === 1000, 'corrección a socio → precio de socio');

  // 10. CSV incluye tipo y precio
  r = await admin.req('GET', `/admin/eventos/${ev.id}/csv`);
  ok(r.text.includes('tipo') && r.text.includes('Socio') && r.text.includes('10,00'), 'CSV con tipo y precio');

  // 11. Precio único: sin price_nonmember todo el mundo paga lo mismo
  await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Quedada Unica', event_date: '2026-11-05', format: 'quedada',
    price: '8', max_players: '0', mode: 'individual', status: 'abierta',
  });
  const ev2 = mdb("SELECT * FROM events WHERE name = 'Quedada Unica'")[0];
  ok(ev2.price_nonmember_cents === null, 'sin segundo precio → NULL');
  await pub.req('POST', `/eventos/${ev2.slug}/inscribir`, { name: 'Otro Mas', phone: '612345680', level: '1.95' });
  const i2 = mdb('SELECT * FROM event_inscriptions WHERE event_id = ?', ev2.id)[0];
  ok(i2 && i2.price_cents === 800, 'precio único aplicado a no socio');
  r = await pub.req('GET', `/eventos/${ev2.slug}`);
  ok(!r.text.includes('No socios'), 'landing de precio único no menciona no socios');

  // 12. Quitar el segundo precio al editar vuelve a precio único
  await admin.req('POST', `/admin/eventos/${ev.id}/editar`, {
    name: 'Americana Halloween', event_date: '2026-10-31', event_time: '', format: 'americana',
    price: '10', price_nonmember: '', max_players: '0', mode: 'individual', status: 'abierta',
    slug: 'americana-halloween-31-octubre',
  });
  ok(mdb('SELECT price_nonmember_cents p FROM events WHERE id = ?', ev.id)[0].p === null, 'vaciar no socios → precio único');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
