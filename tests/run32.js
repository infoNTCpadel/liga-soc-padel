// Eventos: cartel (subida desde el admin, ligero, visible en la landing).
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3476;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-ev/data32';
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
require('fs').rmSync(DATA, { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

function makeClient() {
  let cookie = '';
  const req = (m, p, d, headers = {}) => new Promise((res, rej) => {
    let b = null;
    const h = { ...headers };
    if (d) {
      if (Buffer.isBuffer(d)) { b = d; }
      else {
        const u = new URLSearchParams();
        for (const k in d) [].concat(d[k]).forEach(v => u.append(k, v));
        b = Buffer.from(u.toString());
        h['Content-Type'] = h['Content-Type'] || 'application/x-www-form-urlencoded';
      }
      h['Content-Length'] = b.length;
    }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ port: PORT, path: p, method: m, headers: h }, (rs) => {
      let t = ''; rs.on('data', c => t += c); rs.on('end', () => {
        const sc = rs.headers['set-cookie']; if (sc && sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
        res({ statusCode: rs.statusCode, location: rs.headers.location || '', text: t, headers: rs.headers });
      });
    });
    r.on('error', rej); if (b) r.write(b); r.end();
  });
  return { req };
}
function multipart(fields, file) {
  const boundary = '----testboundary123';
  const parts = [];
  for (const k in fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${fields[k]}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
// JPEG mínimo válido (magic bytes + relleno)
const fakeJpeg = (size) => {
  const b = Buffer.alloc(size, 0x41);
  b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF; b[3] = 0xE0;
  return b;
};

const { DatabaseSync } = require('node:sqlite');
const mdb = (sql, ...p) => { const d = new DatabaseSync(DATA + '/meta.db'); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const fs = require('fs');

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), pub = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });

  // 1. Crear evento con cartel
  let mp = multipart(
    { name: 'Evento Cartel', event_date: '2026-12-20', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta' },
    { field: 'poster', filename: 'cartel.jpg', type: 'image/jpeg', data: fakeJpeg(50000) }
  );
  let r = await admin.req('POST', '/admin/eventos/nuevo', mp.body, { 'Content-Type': mp.contentType });
  ok(r.statusCode === 302, 'evento con cartel creado');
  const ev = mdb("SELECT * FROM events WHERE name = 'Evento Cartel'")[0];
  ok(ev.poster && ev.poster.endsWith('.jpg'), 'cartel guardado en la BD: ' + ev.poster);
  ok(fs.existsSync(`${DATA}/event-posters/${ev.poster}`), 'archivo en DATA_DIR/event-posters');

  // 2. La landing lo muestra y la URL sirve la imagen
  r = await pub.req('GET', '/eventos/' + ev.slug);
  ok(r.text.includes(`/eventos/${ev.slug}/poster`), 'landing muestra el cartel');
  r = await pub.req('GET', `/eventos/${ev.slug}/poster`);
  ok(r.statusCode === 200 && (r.headers['content-type'] || '').includes('image/jpeg'), 'poster servido como imagen');

  // 3. Reemplazar cartel desde editar
  mp = multipart(
    { name: 'Evento Cartel', event_date: '2026-12-20', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta' },
    { field: 'poster', filename: 'nuevo.png', type: 'image/png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(1000)]) }
  );
  r = await admin.req('POST', `/admin/eventos/${ev.id}/editar`, mp.body, { 'Content-Type': mp.contentType });
  const ev2 = mdb('SELECT poster FROM events WHERE id = ?', ev.id)[0];
  ok(ev2.poster.endsWith('.png') && !fs.existsSync(`${DATA}/event-posters/${ev.poster}`), 'cartel reemplazado (el anterior se borra)');

  // 4. Quitar cartel
  r = await admin.req('POST', `/admin/eventos/${ev.id}/poster/quitar`, {});
  ok(mdb('SELECT poster FROM events WHERE id = ?', ev.id)[0].poster === '', 'cartel quitado de la BD');
  r = await pub.req('GET', `/eventos/${ev.slug}/poster`);
  ok(r.statusCode === 404, 'sin cartel → 404');

  // 5. Archivo no válido → error amable, evento no creado
  const nBefore = mdb('SELECT COUNT(*) c FROM events')[0].c;
  mp = multipart(
    { name: 'Evento Malo', event_date: '2026-12-21', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta' },
    { field: 'poster', filename: 'nota.txt', type: 'text/plain', data: Buffer.from('hola') }
  );
  r = await admin.req('POST', '/admin/eventos/nuevo', mp.body, { 'Content-Type': mp.contentType });
  ok(r.statusCode === 200 && r.text.includes('no es una imagen válida'), 'archivo inválido → error amable');
  ok(mdb('SELECT COUNT(*) c FROM events')[0].c === nBefore, 'evento no creado con imagen inválida');

  // 6. Imagen demasiado pesada → error amable
  mp = multipart(
    { name: 'Evento Pesado', event_date: '2026-12-21', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta' },
    { field: 'poster', filename: 'big.jpg', type: 'image/jpeg', data: fakeJpeg(900 * 1024) }
  );
  r = await admin.req('POST', '/admin/eventos/nuevo', mp.body, { 'Content-Type': mp.contentType });
  ok(r.statusCode === 200 && r.text.includes('800 KB'), 'imagen pesada → error amable');

  // 7. Eliminar evento borra también el cartel
  mp = multipart(
    { name: 'Evento Borrar', event_date: '2026-12-22', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta' },
    { field: 'poster', filename: 'c.jpg', type: 'image/jpeg', data: fakeJpeg(10000) }
  );
  await admin.req('POST', '/admin/eventos/nuevo', mp.body, { 'Content-Type': mp.contentType });
  const evD = mdb("SELECT * FROM events WHERE name = 'Evento Borrar'")[0];
  const posterFile = `${DATA}/event-posters/${evD.poster}`;
  ok(fs.existsSync(posterFile), 'cartel existe antes de borrar');
  await admin.req('POST', `/admin/eventos/${evD.id}/eliminar`, {});
  ok(!fs.existsSync(posterFile), 'al eliminar el evento se borra el cartel');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
