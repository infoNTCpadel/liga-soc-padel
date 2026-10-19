// Fase 1: directorio único del club + eventos (landing + inscripciones) + puentes.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3473;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-ev/data29';
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
require('fs').rmSync(DATA, { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

function makeClient() {
  let cookie = '';
  const req = (m, p, d) => new Promise((res, rej) => {
    const b = d ? new URLSearchParams(d).toString() : null;
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
const mdx = (sql, ...p) => { const d = new DatabaseSync(DATA + '/meta.db'); try { return d.prepare(sql).run(...p); } finally { d.close(); } };
const sdb = (sql, ...p) => { const d = new DatabaseSync(DATA + '/season-1.db'); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const sdx = (sql, ...p) => { const d = new DatabaseSync(DATA + '/season-1.db'); try { return d.prepare(sql).run(...p); } finally { d.close(); } };

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), pub = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });

  // 1. Crear evento
  let r = await admin.req('POST', '/admin/eventos/nuevo', {
    name: 'Americana de Navidad', description: 'Quedada navideña', event_date: '2026-12-20',
    event_time: '10:00', format: 'americana', price: '15', max_players: '2',
  });
  ok(r.statusCode === 302 && r.location.startsWith('/admin/eventos/'), 'evento creado');
  const evId = mdb('SELECT id, slug FROM events')[0].id;
  const slug = mdb('SELECT slug FROM events')[0].slug;
  ok(slug === 'americana-de-navidad', 'slug generado: ' + slug);

  // 2. Landing pública
  r = await pub.req('GET', '/eventos');
  ok(r.statusCode === 200 && r.text.includes('Americana de Navidad'), 'índice lista el evento');
  r = await pub.req('GET', '/eventos/' + slug);
  ok(r.statusCode === 200 && r.text.includes('Apuntarme') && r.text.includes('15,00'), 'landing con formulario y precio');

  // 3. Inscripción de persona nueva sin nº de socio → se crea en el directorio con nº generado
  r = await pub.req('POST', `/eventos/${slug}/inscribir`, {
    name: 'Laura Gómez', phone: '612111001', level: '3', gender: 'F', member_no: '', email: 'laura@x.es',
  });
  ok(r.statusCode === 302 && r.location.includes('ok=1'), 'inscripción OK');
  const mem = mdb('SELECT * FROM club_members WHERE phone_norm = ?', '612111001')[0];
  ok(mem && mem.member_no.startsWith('NV-') && mem.name === 'Laura Gómez' && Number(mem.level) === 3, 'directorio: ficha creada sin duplicar, nº generado');
  ok(mdb('SELECT COUNT(*) c FROM event_inscriptions WHERE event_id = ?', evId)[0].c === 1, '1 inscripción');

  // 4. Mismo teléfono otra vez → no duplica persona ni inscripción
  r = await pub.req('POST', `/eventos/${slug}/inscribir`, {
    name: 'Laura Gómez', phone: '612 111 001', level: '3', gender: 'F',
  });
  ok(r.location.includes('error='), 'doble inscripción avisa');
  ok(mdb('SELECT COUNT(*) c FROM club_members WHERE phone_norm = ?', '612111001')[0].c === 1, 'sigue habiendo 1 persona');
  ok(mdb('SELECT COUNT(*) c FROM event_inscriptions WHERE event_id = ?', evId)[0].c === 1, 'sigue habiendo 1 inscripción');

  // 5. Inscripción con nº de socio real → lo usa
  r = await pub.req('POST', `/eventos/${slug}/inscribir`, {
    name: 'Pedro Socio', phone: '612111002', level: '4', gender: 'M', member_no: '2042',
  });
  ok(r.statusCode === 302 && r.location.includes('ok=1'), 'inscripción con nº de socio OK');
  ok(mdb('SELECT member_no FROM club_members WHERE phone_norm = ?', '612111002')[0].member_no === '2042', 'usa el nº de socio dado');

  // 6. Evento lleno (max 2) → bloquea
  r = await pub.req('POST', `/eventos/${slug}/inscribir`, { name: 'Tercero', phone: '612111003', level: '2' });
  ok(r.statusCode === 302 && r.location.includes('error='), 'sin plazas → error');
  ok(decodeURIComponent(r.location).includes('plazas'), 'mensaje de plazas');

  // 7. Admin: detalle, pagado, WhatsApp, CSV
  r = await admin.req('GET', '/admin/eventos/' + evId);
  ok(r.statusCode === 200 && r.text.includes('Laura Gómez') && r.text.includes('wa.me/34612111001'), 'detalle con WhatsApp');
  const iid = mdb('SELECT id FROM event_inscriptions')[0].id;
  r = await admin.req('POST', `/admin/eventos/${evId}/inscripcion/${iid}/pagado`, { paid: '1' });
  ok(mdb('SELECT paid FROM event_inscriptions WHERE id = ?', iid)[0].paid === 1, 'marcar pagado');
  r = await admin.req('GET', `/admin/eventos/${evId}/csv`);
  ok(r.statusCode === 200 && r.text.includes('Laura Gómez') && r.text.includes('612111001'), 'CSV exporta inscritos');

  // 8. Cerrar inscripciones → la landing lo refleja
  await admin.req('POST', `/admin/eventos/${evId}/cerrar`, {});
  r = await pub.req('GET', '/eventos/' + slug);
  ok(r.text.includes('cerradas'), 'landing muestra cierre');
  r = await pub.req('POST', `/eventos/${slug}/inscribir`, { name: 'X', phone: '612111009', level: '2' });
  ok(decodeURIComponent(r.location).includes('cerradas'), 'inscribir en cerrado → error');

  // 9. Puente social → directorio: alta manual activa vuelca los jugadores
  r = await admin.req('POST', '/admin/parejas/nueva', { category: 'M',
    p1_name: 'Socio Uno', p1_phone: '612222001', p1_gender: 'M', p1_level: '3', p1_member: '3001',
    p2_name: 'Socio Dos', p2_phone: '612222002', p2_gender: 'M', p2_level: '3', p2_member: '3002' });
  const pairId = sdb('SELECT id FROM pairs ORDER BY id DESC LIMIT 1')[0].id;
  sdx('UPDATE players SET member_verified = 1 WHERE id IN (SELECT player1_id FROM pairs WHERE id = ?) OR id IN (SELECT player2_id FROM pairs WHERE id = ?)', pairId, pairId);
  r = await admin.req('POST', `/admin/inscripciones/${pairId}/estado`, { status: 'active' });
  ok(!r.location.includes('err='), 'activación OK');
  ok(mdb('SELECT COUNT(*) c FROM club_members WHERE phone_norm IN (?, ?)', '612222001', '612222002')[0].c === 2,
    'puente: los 2 jugadores ya están en el directorio único');
  ok(mdb('SELECT member_no FROM club_members WHERE phone_norm = ?', '612222001')[0].member_no === '3001', 'con su nº de socio real');

  // 10. El inscrito al evento tiene acceso a reservas (active=1)
  ok(mdb('SELECT active FROM club_members WHERE phone_norm = ?', '612111001')[0].active === 1, 'miembro activo → puede activar PIN de reservas');

  // 11. Nivel Playtomic bajo (0.5) no rompe el directorio
  await admin.req('POST', '/admin/eventos/nuevo', { name: 'Quedada libre', event_date: '2026-12-21', format: 'quedada', price: '0', max_players: '0' });
  const slug2 = mdb("SELECT slug FROM events WHERE name = 'Quedada libre'")[0].slug;
  r = await pub.req('POST', `/eventos/${slug2}/inscribir`, { name: 'Novato', phone: '612111004', level: '0.5' });
  ok(r.statusCode === 302 && r.location.includes('ok=1'), 'nivel 0.5 aceptado');
  ok(mdb('SELECT level FROM club_members WHERE phone_norm = ?', '612111004')[0].level === 0.5, 'nivel guardado');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
