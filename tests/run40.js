// Portal KNB (portada solo en el dominio del club), hub /torneos,
// /liga en la ronda actual y vista previa de cuadros de playoff en el ranking.
// HTTP + sqlite directo contra una temporada temporal.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const PORT = 3490;
const dir = path.join(process.env.HOME, 'workspace', 'liga-padel');
const DATA = '/tmp/test-data40';
const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 't', DATA_DIR: DATA, PORTAL_HOST: '127.0.0.1' };
fs.rmSync(DATA, { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };

function makeClient() {
  let cookie = '';
  const req = (m, p, d, extra) => new Promise((res, rej) => {
    let b = null; const h = { ...(extra || {}) };
    if (d) {
      const u = new URLSearchParams();
      for (const k in d) [].concat(d[k]).forEach(v => u.append(k, v));
      b = u.toString(); h['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ port: PORT, path: p, method: m, headers: h }, (rs) => {
      let t = ''; rs.on('data', c => t += c); rs.on('end', () => {
        const sc = rs.headers['set-cookie']; if (sc && sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
        res({ statusCode: rs.statusCode, location: rs.headers.location || '', text: t, type: rs.headers['content-type'] || '' });
      });
    });
    r.on('error', rej); if (b) r.write(b); r.end();
  });
  return { req };
}
const { DatabaseSync } = require('node:sqlite');
const sdb = (sql, ...p) => { const d = new DatabaseSync(SEASON); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const srun = (sql, ...p) => { const d = new DatabaseSync(SEASON); try { return d.prepare(sql).run(...p); } finally { d.close(); } };
let SEASON = '';

const srv = spawn('node', ['src/index.js'], { cwd: dir, env, stdio: 'ignore' });
(async () => {
  await new Promise(r => setTimeout(r, 4000));
  const admin = makeClient(), pub = makeClient();
  await admin.req('POST', '/admin/setup', { password: 'admin12345' });
  await admin.req('GET', '/admin');
  SEASON = path.join(DATA, fs.readdirSync(DATA).find(f => /^season-\d+\.db$/.test(f)));
  ok(SEASON && fs.existsSync(SEASON), 'existe la BD de temporada');

  // --- 6 parejas M con puntos de R1 (200, 175, 155, 140, 130, 115) ---
  const pairIds = [];
  for (let i = 1; i <= 6; i++) {
    const p1 = srun("INSERT INTO players(name, phone, level, gender, member_no, member_verified) VALUES(?, ?, 3.0, 'M', '1', 1)",
      `Jugador 0${2 * i - 1}`, `6000000${2 * i - 1}`).lastInsertRowid;
    const p2 = srun("INSERT INTO players(name, phone, level, gender, member_no, member_verified) VALUES(?, ?, 3.0, 'M', '1', 1)",
      `Jugador 0${2 * i}`, `6000000${2 * i}`).lastInsertRowid;
    const pair = srun("INSERT INTO pairs(code, category, player1_id, player2_id, captain_id, level_avg, status) VALUES(?, 'M', ?, ?, ?, 3.0, 'active')",
      `P0000${i}`, p1, p2, p1).lastInsertRowid;
    pairIds.push(pair);
    srun("INSERT INTO round_results(pair_id, category, round_no, group_no, position, round_points, target_group) VALUES(?, 'M', 1, 1, ?, ?, 1)",
      pair, i, [200, 175, 155, 140, 130, 115][i - 1]);
  }
  const name = i => `Jugador 0${2 * i - 1} / Jugador 0${2 * i}`;

  // --- 1. logo servido ---
  const logo = await pub.req('GET', '/knb-logo.png');
  ok(logo.statusCode === 200 && /image\/png/.test(logo.type), 'logo KNB servido en /knb-logo.png');

  // --- 2. portal solo en el dominio del club ---
  const portal = (await pub.req('GET', '/', null, { Host: '127.0.0.1' })).text;
  ok(portal.includes('KNB PADEL CLUB'), 'portal: marca KNB');
  ok(portal.includes('Torneos KNB') && portal.includes('/torneos'), 'portal: tarjeta Torneos con enlace al hub');
  ok(portal.includes('Equipos Federados KNB') && portal.includes('Próximamente'), 'portal: tarjeta Equipos como Próximamente');
  ok(portal.includes('fcpadel.cat'), 'portal: Equipos enlaza a la FCP');
  ok(portal.includes('Academia de Pádel') && portal.includes('https://academia.kanbesport.com'), 'portal: Academia enlaza a academia.kanbesport.com');
  ok(portal.includes('Av. de la Pau 52') && portal.includes('info@kanbesport.com') && portal.includes('@kanbesport'), 'portal: pie con los datos de kanbesport.com');
  ok(!portal.includes('/reservar') && !portal.includes('Reservar pista'), 'portal: ni rastro de reservas');
  ok(portal.includes('Sport & Social · Portal oficial'), 'portal: subtítulo Sport & Social · Portal oficial');
  ok(!portal.includes('Club deportivo de pádel'), 'portal: sin el texto Club deportivo de pádel');
  ok(!portal.includes('href="/normativa"') && !portal.includes('href="/liga"') && !portal.includes('href="/ranking"')
    && !portal.includes('href="/playoffs"') && !portal.includes('href="/eventos"') && !portal.includes('class="burger"'),
    'portal: sin navegación de la liga arriba, solo las tarjetas');
  ok(portal.includes('Barlow+Condensed'), 'portal: tipografía del club (Barlow Condensed)');
  const css = (await pub.req('GET', '/style.css')).text;
  ok(css.includes('#277151') && css.includes('body.portal-page') && css.includes('Barlow Condensed'),
    'CSS: tema claro del club (verde #277151, fondo claro, Barlow Condensed)');

  const classic = (await pub.req('GET', '/', null, { Host: 'localhost' })).text;
  ok(classic.includes('Liga de pádel por parejas'), 'otro dominio: portada clásica de la liga');
  ok(!classic.includes('KNB PADEL CLUB'), 'otro dominio: sin portal KNB');
  ok(classic.includes('href="/liga"') && classic.includes('href="/normativa"'), 'otro dominio: navegación de la liga intacta');
  ok(!classic.includes('Barlow+Condensed'), 'otro dominio: sin la fuente del portal');

  // --- 3. fase en curso: el portal y el hub muestran la ronda actual ---
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('phase_r2_label', 'Ronda 2')");
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('phase_r2_ini', '2026-11-01')");
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('phase_r2_fin', '2026-12-31')");
  const portal2 = (await pub.req('GET', '/', null, { Host: '127.0.0.1' })).text;
  ok(portal2.includes('En juego') && portal2.includes('Ronda 2'), 'portal: badge En juego con la ronda actual');
  const hub = (await pub.req('GET', '/torneos')).text;
  ok(hub.includes('Torneos KNB') && hub.includes('Liga social') && hub.includes('Mediodía') && hub.includes('Eventos'),
    'hub /torneos: las 3 secciones');
  ok(hub.includes('kanbe-mediodia.padelvalles.com'), 'hub: Mediodía enlaza a su subdominio');
  ok(hub.includes('¿Cómo funciona?') && hub.includes('Calendario'), 'hub: conserva el contenido de la portada clásica');
  ok(!hub.includes('/reservar'), 'hub: ni rastro de reservas');

  // --- 4. /liga abre en la primera ronda no cerrada ---
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('round1_closed', '1')");
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('round2_closed', '0')");
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('round3_closed', '0')");
  let r = await pub.req('GET', '/liga');
  ok(r.statusCode === 302 && r.location === '/liga/M/2', '/liga con R1 cerrada → R2');
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('round1_closed', '0')");
  r = await pub.req('GET', '/liga');
  ok(r.location === '/liga/M/1', '/liga sin rondas cerradas → R1');
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('round1_closed', '1')");
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('round2_closed', '1')");
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('round3_closed', '1')");
  r = await pub.req('GET', '/liga');
  ok(r.location === '/liga/M/3', '/liga con todo cerrado → R3');
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('round1_closed', '1')");
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('round2_closed', '0')");
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('round3_closed', '0')");

  // --- 5. vista previa de playoffs en el ranking ---
  srun("INSERT OR REPLACE INTO settings(key, value) VALUES('playoff_sizes_M', '4,4')");
  let rk = (await pub.req('GET', '/ranking/M')).text;
  const prev = rk.slice(rk.indexOf('Vista previa'));
  ok(rk.includes('Vista previa de los cuadros de playoff'), 'ranking: sección de vista previa');
  ok(prev.includes('Cuadro 1 · Playoff de 1.ª categoría (4 parejas)'), 'ranking: cuadro 1 con 4 parejas');
  ok(prev.indexOf(name(1)) < prev.indexOf('Sin playoff') && prev.indexOf(name(4)) < prev.indexOf('Sin playoff'),
    'ranking: las 4 primeras en el cuadro 1');
  ok(prev.indexOf('Sin playoff') < prev.indexOf(name(5)) && prev.indexOf(name(6)) > prev.indexOf('Sin playoff'),
    'ranking: la 5.ª y la 6.ª fuera del cuadro');
  ok(!rk.includes('Excluidas por el admin'), 'ranking: sin excluidas no se muestra el aviso');

  // --- 6. exclusión: la 1.ª sale y la 5.ª asciende al cuadro ---
  srun("INSERT INTO playoff_excluded(category, pair_id) VALUES('M', ?)", pairIds[0]);
  rk = (await pub.req('GET', '/ranking/M')).text;
  const prev2 = rk.slice(rk.indexOf('Vista previa'));
  ok(prev2.includes('Excluidas por el admin') && prev2.includes(name(1)), 'ranking: la excluida se marca como tal');
  ok(prev2.indexOf(name(5)) < prev2.indexOf('Sin playoff'), 'ranking: la 5.ª asciende al cuadro 1 al excluir a la 1.ª');
  ok(prev2.indexOf(name(1)) > prev2.indexOf('Sin playoff') || prev2.indexOf(name(1)) > prev2.indexOf('Excluidas'),
    'ranking: la excluida no está en el cuadro 1');
  srun("DELETE FROM playoff_excluded WHERE category = 'M'");

  console.log(`\nrun40: ${pass} OK, ${fail} FALLOS`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
