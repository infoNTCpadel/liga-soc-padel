// Pruebas del agente conversacional de reservas (chat web).
// El LLM se simula con funciones guionizadas: no se hace ninguna llamada real.
const DATA = '/tmp/test-chat/data9';
process.env.DATA_DIR = DATA;
process.env.LLM_API_KEY = 'test-key';
require('fs').rmSync(DATA, { recursive: true, force: true });

const B = require('../src/lib/bookings');
const Chat = require('../src/lib/chatAgent');
const { db } = require('../src/db');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : (fail++, console.log('FALLO:', n)); };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + ` (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`);

const dayStr = (off) => { const d = new Date(Date.now() + off * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TOM = dayStr(1), D2 = dayStr(2);
const hhmm = (m) => B.minToStr(m);

// Guioniza un LLM falso: cada llamada consume el siguiente paso.
function scripted(steps) {
  let i = 0;
  return async (messages) => {
    if (i >= steps.length) throw new Error('el LLM falso se quedó sin pasos');
    return steps[i++](messages);
  };
}
const say = (content) => () => ({ content, toolCalls: [], usage: { in: 100, out: 50 } });
const call = (name, args, content = null) => () => ({
  content, toolCalls: [{ id: 't' + Math.random().toString(36).slice(2), name, args }], usage: { in: 100, out: 50 },
});
function lastDraftId(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool' && m.content.includes('draft_id')) {
      const j = JSON.parse(m.content);
      if (j.draft_id) return j.draft_id;
    }
  }
  return null;
}

(async () => {
// ---- base: pistas y socios ----
db.prepare("INSERT INTO courts(name, active) VALUES('Pista 1', 1), ('Pista 2', 1)").run();
B.upsertMember('7', 'Siete Pruebas', '600000007');
B.setPin('7', '1234');
B.upsertMember('8', 'Ocho Pruebas', '600000008');
B.setPin('8', '5678');

// ---- 1. sin clave no hay chat y no se llama al LLM ----
delete process.env.LLM_API_KEY; delete process.env.OPENROUTER_API_KEY;
let llmCalled = false;
let r = await Chat.runChat({ message: 'hola', session: {}, llm: async () => { llmCalled = true; } });
ok(r.disabled && !llmCalled, 'sin API key el chat está desactivado y no llama al LLM');
process.env.LLM_API_KEY = 'test-key';

// ---- 2. disponibilidad de mañana ----
{
  const session = {};
  r = await Chat.runChat({
    message: '¿hay hueco mañana?', session,
    llm: scripted([
      call('ver_disponibilidad', { fecha: TOM }),
      (messages) => {
        const toolMsg = messages[messages.length - 1];
        const j = JSON.parse(toolMsg.content);
        ok(j.ok && j.pistas.length === 2 && j.pistas[0].huecos.length > 0, 'ver_disponibilidad devuelve huecos por pista');
        return { content: 'Mañana hay huecos: ' + j.pistas[0].huecos.slice(0, 3).map(h => h.inicio).join(', '), toolCalls: [], usage: { in: 1, out: 1 } };
      },
    ]),
  });
  ok(r.reply.includes('huecos'), 'el agente responde con la disponibilidad de la BD');
}

// ---- 3. confirmar sin borrador no crea nada ----
{
  const session = { bookingMemberNo: '7' };
  r = await Chat.runChat({
    message: 'confirma', session,
    llm: scripted([
      call('confirmar_reserva', { draft_id: 'inexistente' }),
      say('No hay ningún borrador.'),
    ]),
  });
  const bookings = B.dayBookings(TOM).filter(b => b.titular_member_no === '7');
  ok(bookings.length === 0, 'confirmar_reserva con draft inválido no crea reserva');
}

// ---- 4. conversación completa: identificar → preparar → confirmar ----
{
  const session = {};
  const seg = B.freeSegments(1, TOM)[0];
  const start = B.validStarts(seg.start, seg.end)[0].start_min;
  const inicio = hhmm(start);
  // Mensaje 1: pide disponibilidad (sin identificar)
  r = await Chat.runChat({
    message: `quiero reservar mañana a las ${inicio}`, session,
    llm: scripted([
      call('ver_disponibilidad', { fecha: TOM }),
      say('Hay hueco. Dime tu nº de socio y PIN para identificarte.'),
    ]),
  });
  ok(!session.bookingMemberNo, 'sin identificarse no hay sesión de socio');
  // Mensaje 2: se identifica
  r = await Chat.runChat({
    message: 'soy el socio 7, mi pin es 1234', session,
    llm: scripted([
      call('identificarse', { member_no: '7', pin: '1234' }),
      say('Hola Siete Pruebas. ¿A qué hora reservamos?'),
    ]),
  });
  ok(session.bookingMemberNo === '7', 'identificarse con PIN correcto inicia sesión en el chat');
  // Mensaje 3: prepara la reserva (no la crea)
  let draftId = null;
  r = await Chat.runChat({
    message: `sí, mañana a las ${inicio} en pista 1`, session,
    llm: scripted([
      call('preparar_reserva', { fecha: TOM, inicio, pista: 'Pista 1' }),
      (messages) => {
        const j = JSON.parse(messages[messages.length - 1].content);
        ok(j.ok && j.draft_id && j.resumen.includes('75 min'), 'preparar_reserva crea borrador con duración automática 75');
        draftId = j.draft_id; // en producción el LLM lo tiene en su contexto
        return { content: 'Te preparo esto: ' + j.resumen + '. ¿Confirmo?', toolCalls: [], usage: { in: 1, out: 1 } };
      },
    ]),
  });
  ok(B.dayBookings(TOM).filter(b => b.titular_member_no === '7').length === 0, 'preparar no crea la reserva');
  // Mensaje 4: confirma
  r = await Chat.runChat({
    message: 'sí, confirma', session,
    llm: scripted([
      call('confirmar_reserva', { draft_id: draftId }),
      say('Reserva confirmada.'),
    ]),
  });
  const mine = B.dayBookings(TOM).filter(b => b.titular_member_no === '7');
  ok(mine.length === 1 && mine[0].end_min - mine[0].start_min === 75, 'confirmar_reserva crea la reserva de 75 min');
}

// ---- 5. PIN incorrecto y bloqueo por fuerza bruta ----
{
  const ctx = { memberNo: null, courts: [] };
  for (let i = 0; i < 5; i++) Chat.dispatch('identificarse', { member_no: '8', pin: '0000' }, ctx);
  const locked = Chat.dispatch('identificarse', { member_no: '8', pin: '5678' }, ctx);
  ok(!locked.ok && locked.error.includes('15 minutos'), '5 PIN fallidos bloquean 15 minutos aunque el sexto sea correcto');
  ok(!ctx.memberNo, 'bloqueado no identifica');
}

// ---- 6. anular: dentro del límite de 6 h se rechaza ----
{
  // Reserva hoy dentro de 2 h (límite 6 h) en pista 2
  const now = B.nowMin();
  const seg = B.freeSegments(2, B.todayStr()).find(g => g.start > now && g.end - (g.start + 60) >= 0);
  if (seg) {
    const st = B.validStarts(seg.start, seg.end).find(v => v.durations.includes(60) && v.start_min > now && v.start_min < now + 5 * 60);
    if (st) {
      const created = B.createBooking({
        court_id: 2, court_name: 'Pista 2', date: B.todayStr(),
        start_min: st.start_min, duration_min: 60, titular_member_no: '7', players: [],
      });
      ok(!created.error, 'reserva de prueba creada para hoy');
      const prep = Chat.dispatch('preparar_anulacion', { reserva_id: created.id }, { memberNo: '7', courts: [] });
      ok(!prep.ok && prep.error.includes('6 h'), 'anular dentro del límite de 6 h se rechaza');
    } else ok(true, 'sin hueco válido hoy para probar el límite (omitido)');
  } else ok(true, 'sin tramo libre hoy para probar el límite (omitido)');
  // Reserva de mañana: preparar + confirmar anulación funciona
  const seg2 = B.freeSegments(2, D2)[0];
  const st2 = B.validStarts(seg2.start, seg2.end)[0];
  const created2 = B.createBooking({
    court_id: 2, court_name: 'Pista 2', date: D2,
    start_min: st2.start_min, duration_min: st2.durations[0], titular_member_no: '7', players: [],
  });
  const ctx = { memberNo: '7', courts: [] };
  const prep2 = Chat.dispatch('preparar_anulacion', { reserva_id: created2.id }, ctx);
  ok(prep2.ok && prep2.draft_id, 'preparar_anulacion crea borrador fuera del límite');
  const conf2 = Chat.dispatch('confirmar_anulacion', { draft_id: prep2.draft_id }, ctx);
  ok(conf2.ok && B.getBooking(created2.id).status === 'cancelled', 'confirmar_anulacion anula la reserva');
}

// ---- 7. tope de gasto mensual ----
{
  process.env.CHAT_CAP_EUR = '0';
  let called = false;
  r = await Chat.runChat({ message: 'hola', session: {}, llm: async () => { called = true; } });
  ok(r.capped && !called, 'con el tope de gasto alcanzado no se llama al LLM');
  delete process.env.CHAT_CAP_EUR;
}

// ---- 8. límite diario de mensajes ----
{
  const session = { chatUsage: { date: B.todayStr(), n: 40 } };
  let called = false;
  r = await Chat.runChat({ message: 'hola', session, llm: async () => { called = true; } });
  ok(r.limited && !called, 'superado el límite diario no se llama al LLM');
}

// ---- 9. estimación de coste ----
{
  const eur = Chat.estimateCostEur('openai/gpt-4o-mini', 1e6, 1e6);
  ok(Math.abs(eur - 0.69) < 0.01, 'coste estimado gpt-4o-mini 1M+1M ≈ 0,69 €');
  ok(Chat.estimateCostEur('modelo-desconocido', 0, 0) === 0, 'sin tokens no hay coste');
}

// ---- 10. el prompt incluye las normas del club ----
{
  const p = Chat.buildSystemPrompt(null);
  const c = B.getConfig();
  ok(p.includes('Hoy es') && p.includes(String(c.cancel_limit_h)) && p.includes('confirmar_reserva'),
    'system prompt con fecha, límite de anulación y flujo de confirmación');
}

// ---- 11. partidos abiertos: visibles y apuntarse ----
{
  // Socio 7 crea un abierto mañana con 2 plazas (via createBooking directo)
  const seg = B.freeSegments(1, D2).find(g => g.end - g.start >= 150) || B.freeSegments(1, D2)[0];
  const st = B.validStarts(seg.start, seg.end)[0];
  const created = B.createBooking({
    court_id: 1, court_name: 'Pista 1', date: D2, start_min: st.start_min,
    duration_min: st.durations[0], titular_member_no: '7', players: [], open_spots: 2,
  });
  const seen = Chat.dispatch('ver_partidos_abiertos', { fecha: D2 }, { memberNo: '8', courts: [] });
  ok(seen.ok && seen.partidos.some(p => p.id === created.id), 'el socio 8 ve el partido abierto del socio 7');
  const join = Chat.dispatch('apuntarse_partido', { partido_id: created.id }, { memberNo: '8', courts: [] });
  ok(join.ok && B.getBooking(created.id).open_spots === 1, 'apuntarse_partido resta una plaza');
}

// ---- 12. el borrador sobrevive entre turnos: "sí" confirma sin repreparar ----
{
  const session = { bookingMemberNo: '8' };
  const seg = B.freeSegments(2, D2).find(g => g.end - g.start >= 150) || B.freeSegments(2, D2)[0];
  const inicio = hhmm(seg.start);
  // Turno 1: el modelo prepara el borrador y pide confirmación
  let r = await Chat.runChat({
    message: `reserva pasado mañana a las ${inicio} en pista 2`, session,
    llm: scripted([
      call('preparar_reserva', { fecha: D2, inicio, pista: 'Pista 2' }),
      say('Te preparo la reserva. ¿Confirmo?'),
    ]),
  });
  ok(session.pendingDraft && session.pendingDraft.draft_id, 'tras preparar, la sesión guarda el borrador pendiente');
  ok(r.reply.includes('¿Confirmo?'), 'el agente pide confirmación tras preparar');
  const before = B.dayBookings(D2).filter(b => b.titular_member_no === '8').length;
  // Turno 2: el "sí" del socio. El LLM simulado solo sabe lo que runChat le pasa,
  // como un modelo real: extrae el draft_id de la nota del sistema.
  r = await Chat.runChat({
    message: 'sí', session,
    llm: scripted([
      (messages) => {
        const note = messages.find(m => m.role === 'system' && m.content.includes('Borrador pendiente'));
        ok(!!note, 'el segundo turno recibe la nota con el borrador pendiente');
        const id = (note.content.match(/draft_id=([0-9a-f]+)/) || [])[1];
        ok(id === session.pendingDraft.draft_id, 'la nota trae el draft_id del borrador');
        return { content: null, toolCalls: [{ id: 't1', name: 'confirmar_reserva', args: { draft_id: id } }], usage: { in: 1, out: 1 } };
      },
      say('Reserva confirmada.'),
    ]),
  });
  const after = B.dayBookings(D2).filter(b => b.titular_member_no === '8').length;
  ok(after === before + 1, 'decir "sí" confirma el borrador sin repreparar');
  ok(!session.pendingDraft, 'tras confirmar se limpia el borrador pendiente');
  ok(r.reply.includes('confirmada'), 'el agente confirma la reserva al socio');
}

console.log(`\n${pass}/${pass + fail} pruebas del chat superadas`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
