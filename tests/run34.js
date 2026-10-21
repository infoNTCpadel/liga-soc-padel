// Eventos: landing con cartel a la derecha y descripción con saltos de línea.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 3481;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-ev/data34';
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
        res({ statusCode: rs.statusCode, location: rs.headers.location || '', text: t });
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
const fakeJpeg = () => {
  const b = Buffer.alloc(20000, 0x41);
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

  const desc = 'Primera línea del evento.\nSegunda línea con detalles.\n\nTercer párrafo tras línea en blanco.';
  const mp = multipart(
    { name: 'Evento Layout', description: desc, event_date: '2026-12-20', format: 'americana', price: '0', max_players: '0', mode: 'individual', status: 'abierta' },
    { field: 'poster', filename: 'cartel.jpg', type: 'image/jpeg', data: fakeJpeg() }
  );
  await admin.req('POST', '/admin/eventos/nuevo', mp.body, { 'Content-Type': mp.contentType });
  const ev = mdb("SELECT * FROM events WHERE name = 'Evento Layout'")[0];
  ok(!!ev, 'evento creado');

  const r = await pub.req('GET', '/eventos/' + ev.slug);
  ok(r.statusCode === 200, 'landing 200');
  ok(r.text.includes('class="ev-head"') && r.text.includes('class="ev-poster"'), 'cartel en columna derecha (ev-head/ev-poster)');
  ok(r.text.includes('class="ev-desc"'), 'descripción con clase ev-desc (pre-line)');
  ok(r.text.includes('Primera línea del evento.\nSegunda línea'), 'los saltos de línea llegan al HTML');
  ok(r.text.indexOf('ev-poster') > r.text.indexOf('ev-main'), 'el cartel va tras el bloque principal');

  // El CSS servido trae las reglas nuevas
  const css = await pub.req('GET', '/style.css');
  ok(css.text.includes('.ev-poster') && css.text.includes('max-height: 430px') && css.text.includes('white-space: pre-line'),
    'style.css con reglas del cartel y pre-line');

  console.log(`\n${pass} OK, ${fail} fallos`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FALLO excepción:', e.message); srv.kill(); process.exit(1); });
