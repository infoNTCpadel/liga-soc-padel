// Eventos: al cambiar el cartel no debe salir el anterior (caché).
// Cada subida genera un nombre único y la landing lo referencia con ?v=<nombre>.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const PORT = 3483;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-ev/data35';
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA };
fs.rmSync(DATA, { recursive: true, force: true });

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
      const chunks = [];
      rs.on('data', c => chunks.push(c));
      rs.on('end', () => {
        const sc = rs.headers['set-cookie']; if (sc && sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
        const buf = Buffer.concat(chunks);
        res({ statusCode: rs.statusCode, location: rs.headers.location || '', text: buf.toString('utf8'), buf, headers: rs.headers });
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
const fakeJpeg = (size, fill) => {
  const b = Buffer.alloc(size, fill);
  b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF; b[3] = 0xE0;
  return b;
};
const { DatabaseSync } = require('node:sqlite');
const mdb = (sql, ...p) => { const d = new DatabaseSync(DATA + '/meta.db'); try { return d.prepare(sql).all(...p); } finally { d.close(); } };

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const admin = makeClient(), pub = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });

  // 1. Crear con cartel A
  let mp = multipart(
    { name: 'Evento Cache', event_date: '2026-12-20', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta' },
    { field: 'poster', filename: 'a.jpg', type: 'image/jpeg', data: fakeJpeg(50000, 0x41) }
  );
  await admin.req('POST', '/admin/eventos/nuevo', mp.body, { 'Content-Type': mp.contentType });
  let ev = mdb("SELECT * FROM events WHERE name = 'Evento Cache'")[0];
  const posterA = ev.poster;
  ok(/^\d+-[a-z0-9]+\.jpg$/.test(posterA), 'nombre versionado: ' + posterA);
  let r = await pub.req('GET', `/eventos/${ev.slug}/poster?v=${posterA}`);
  ok(r.statusCode === 200 && r.buf.length === 50000, 'se sirve el cartel A');

  // 2. Reemplazar por cartel B
  mp = multipart(
    { name: 'Evento Cache', event_date: '2026-12-20', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta' },
    { field: 'poster', filename: 'b.jpg', type: 'image/jpeg', data: fakeJpeg(30000, 0x42) }
  );
  await admin.req('POST', `/admin/eventos/${ev.id}/editar`, mp.body, { 'Content-Type': mp.contentType });
  ev = mdb('SELECT * FROM events WHERE id = ?', ev.id)[0];
  ok(ev.poster !== posterA, 'el nombre cambia al reemplazar');
  ok(!fs.existsSync(`${DATA}/event-posters/${posterA}`), 'el archivo anterior se borra');
  ok(fs.existsSync(`${DATA}/event-posters/${ev.poster}`), 'el archivo nuevo existe');

  // 3. La ruta sirve el nuevo y la landing referencia la versión nueva
  r = await pub.req('GET', `/eventos/${ev.slug}/poster?v=${ev.poster}`);
  ok(r.statusCode === 200 && r.buf.length === 30000, 'se sirve el cartel B (no el A cacheado)');
  r = await pub.req('GET', `/eventos/${ev.slug}`);
  ok(r.text.includes(`poster?v=${ev.poster}`), 'la landing usa la URL versionada nueva');
  ok(!r.text.includes(`poster?v=${posterA}`), 'la landing ya no referencia la versión vieja');

  // 4. Quitar cartel borra también archivos versionados
  await admin.req('POST', `/admin/eventos/${ev.id}/poster/quitar`, {});
  ok(!fs.existsSync(`${DATA}/event-posters/${ev.poster}`), 'quitar borra el archivo versionado');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
