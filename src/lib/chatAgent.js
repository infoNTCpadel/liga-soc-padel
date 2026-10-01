// Agente conversacional de reservas (chat web de la app).
//
// El socio habla en lenguaje natural y un LLM con function calling interpreta
// la intención y llama a las mismas funciones internas que usa la parrilla.
// Se habla con cualquier API compatible con OpenAI (por defecto OpenRouter):
//   LLM_BASE_URL  (defecto https://openrouter.ai/api/v1)
//   LLM_API_KEY o OPENROUTER_API_KEY
//   LLM_MODEL     (defecto openai/gpt-4o-mini)
//   CHAT_CAP_EUR  (tope de gasto mensual, defecto 10)
//   CHAT_MAX_TURNS (pasos de herramienta por mensaje, defecto 10)
//   CHAT_DAY_LIMIT (mensajes por socio y día, defecto 40)
//
// Reglas duras (también en el system prompt):
// - El LLM propone; nunca crea ni anula nada por sí solo.
// - Crear/anular pasan por un borrador (draft) en memoria que solo se ejecuta
//   con confirmación explícita del socio en la conversación.
// - Precios y disponibilidad siempre salen de la BD, nunca del modelo.

const crypto = require('crypto');
const B = require('./bookings');

const bdb = B.bdb;
bdb.exec(`CREATE TABLE IF NOT EXISTS chat_spend(
  month TEXT PRIMARY KEY,
  eur REAL NOT NULL DEFAULT 0
)`);

// ------------------------------------------------------------ configuración
function chatConfig() {
  const key = (process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();
  const num = (v, dflt) => { const n = parseFloat(v); return Number.isFinite(n) ? n : dflt; };
  const int = (v, dflt) => { const n = parseInt(v, 10); return Number.isInteger(n) ? n : dflt; };
  return {
    enabled: !!key,
    key,
    baseUrl: (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    model: (process.env.LLM_MODEL || 'openai/gpt-4o-mini').trim(),
    capEur: num(process.env.CHAT_CAP_EUR, 10),
    maxTurns: int(process.env.CHAT_MAX_TURNS, 10),
    dayLimit: int(process.env.CHAT_DAY_LIMIT, 40),
  };
}

// ------------------------------------------------------------ gasto mensual
// Precios aproximados ($/1M tokens) para estimar el gasto. Si el modelo no
// está en la tabla se usa una estimación conservadora.
const PRICE_TABLE = {
  'openai/gpt-4o-mini': [0.15, 0.60],
  'openai/gpt-4.1-nano': [0.10, 0.40],
  'openai/gpt-4.1-mini': [0.40, 1.60],
  'openai/gpt-5-mini': [0.20, 0.80],
  'anthropic/claude-haiku-4-5': [1.00, 5.00],
};
const USD_EUR = 0.92;
function estimateCostEur(model, inTokens, outTokens) {
  const [pi, po] = PRICE_TABLE[model] || [1.0, 3.0];
  return ((inTokens * pi + outTokens * po) / 1e6) * USD_EUR;
}
function monthKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function spendThisMonth() {
  const r = bdb.prepare('SELECT eur FROM chat_spend WHERE month = ?').get(monthKey());
  return r ? r.eur : 0;
}
function addSpend(eur) {
  if (!(eur > 0)) return;
  bdb.prepare(`INSERT INTO chat_spend(month, eur) VALUES(?, ?)
    ON CONFLICT(month) DO UPDATE SET eur = eur + excluded.eur`).run(monthKey(), eur);
}

// ------------------------------------------------------------ borradores (requieren confirmación)
const drafts = new Map(); // draft_id -> { kind, member_no, payload, resumen, expires }
function newDraft(kind, member_no, payload, resumen) {
  const id = crypto.randomBytes(8).toString('hex');
  drafts.set(id, { kind, member_no, payload, resumen, expires: Date.now() + 10 * 60000 });
  return id;
}
function takeDraft(id, member_no, kind) {
  const d = drafts.get(id);
  if (!d) return { error: 'Ese borrador ya no existe (caducan a los 10 minutos).' };
  if (Date.now() > d.expires) { drafts.delete(id); return { error: 'El borrador ha caducado; vuelve a pedirlo.' }; }
  if (d.member_no !== member_no) return { error: 'Ese borrador no es tuyo.' };
  if (d.kind !== kind) return { error: 'Borrador no válido para esta acción.' };
  drafts.delete(id);
  return { draft: d };
}
// Anti fuerza bruta del PIN en el chat (en memoria; un solo proceso).
const pinFails = new Map();
function pinLocked(no) {
  const f = pinFails.get(no);
  return f && f.until > Date.now();
}
function pinFail(no) {
  const f = pinFails.get(no) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 15 * 60000; f.n = 0; }
  pinFails.set(no, f);
  return f.until > Date.now();
}

// ------------------------------------------------------------ herramientas
function activeCourts() {
  try {
    return require('../db').db.prepare('SELECT id, name FROM courts WHERE active = 1 ORDER BY name').all();
  } catch (e) { return []; }
}
function resolveCourt(courts, pista) {
  if (pista === undefined || pista === null || pista === '') return { court: null, needChoice: courts.length > 1 };
  const q = String(pista).trim().toLowerCase();
  let court = /^\d+$/.test(q) ? courts.find(c => c.id === parseInt(q, 10))
    : courts.find(c => c.name.toLowerCase() === q) || courts.find(c => c.name.toLowerCase().includes(q));
  return { court: court || null };
}
function checkDate(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return 'Indica la fecha como AAAA-MM-DD.';
  const c = B.getConfig();
  const today = B.todayStr(), max = B.addDays(today, c.days_ahead);
  if (fecha < today) return 'Esa fecha ya ha pasado.';
  if (fecha > max) return `Solo se puede reservar hasta ${max.split('-').reverse().join('/')} (${c.days_ahead} días).`;
  return null;
}

const TOOLS = [
  { type: 'function', function: {
    name: 'identificarse',
    description: 'Identifica al socio en el chat con su nº de socio y PIN. Úsala en cuanto el socio dé ambos datos.',
    parameters: { type: 'object', properties: {
      member_no: { type: 'string', description: 'Nº de socio' },
      pin: { type: 'string', description: 'PIN de 4 a 8 dígitos' } },
      required: ['member_no', 'pin'] } } },
  { type: 'function', function: {
    name: 'ver_disponibilidad',
    description: 'Huecos libres de un día (AAAA-MM-DD): por pista, inicios válidos y duraciones que encajan.',
    parameters: { type: 'object', properties: {
      fecha: { type: 'string', description: 'Día en formato AAAA-MM-DD' } },
      required: ['fecha'] } } },
  { type: 'function', function: {
    name: 'mis_reservas',
    description: 'Próximas reservas del socio identificado (con id para anular).',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: {
    name: 'preparar_reserva',
    description: 'Prepara una reserva SIN crearla: valida y devuelve un borrador con resumen. La duración se elige automáticamente (la mayor que encaje). Después pide confirmación explícita y llama a confirmar_reserva.',
    parameters: { type: 'object', properties: {
      fecha: { type: 'string', description: 'Día AAAA-MM-DD' },
      inicio: { type: 'string', description: 'Hora de inicio HH:MM' },
      pista: { type: 'string', description: 'Nombre o id de la pista (opcional si hay varias, pregunta)' },
      jugadores: { type: 'string', description: 'Nombres de acompañantes separados por comas (opcional, máx 3)' } },
      required: ['fecha', 'inicio'] } } },
  { type: 'function', function: {
    name: 'confirmar_reserva',
    description: 'Crea la reserva del borrador. Úsala SOLO después de que el socio haya confirmado explícitamente el resumen.',
    parameters: { type: 'object', properties: {
      draft_id: { type: 'string', description: 'Id del borrador de preparar_reserva' } },
      required: ['draft_id'] } } },
  { type: 'function', function: {
    name: 'preparar_anulacion',
    description: 'Prepara la anulación de una reserva SIN anularla: devuelve un borrador con resumen. Después pide confirmación explícita y llama a confirmar_anulacion.',
    parameters: { type: 'object', properties: {
      reserva_id: { type: 'integer', description: 'Id de la reserva (ver mis_reservas)' } },
      required: ['reserva_id'] } } },
  { type: 'function', function: {
    name: 'confirmar_anulacion',
    description: 'Anula la reserva del borrador. Úsala SOLO tras confirmación explícita del socio.',
    parameters: { type: 'object', properties: {
      draft_id: { type: 'string', description: 'Id del borrador de preparar_anulacion' } },
      required: ['draft_id'] } } },
  { type: 'function', function: {
    name: 'ver_partidos_abiertos',
    description: 'Partidos abiertos con plazas libres visibles para el socio (respeta niveles y bloqueos).',
    parameters: { type: 'object', properties: {
      fecha: { type: 'string', description: 'Día AAAA-MM-DD (opcional, defecto hoy)' } } } } },
  { type: 'function', function: {
    name: 'apuntarse_partido',
    description: 'Apunta al socio identificado a un partido abierto. Úsala solo cuando el socio lo pida claramente.',
    parameters: { type: 'object', properties: {
      partido_id: { type: 'integer', description: 'Id del partido (ver ver_partidos_abiertos)' } },
      required: ['partido_id'] } } },
  { type: 'function', function: {
    name: 'apuntarse_lista_espera',
    description: 'Apunta al socio a la lista de espera de una hora ocupada (se le avisa si se libera).',
    parameters: { type: 'object', properties: {
      fecha: { type: 'string', description: 'Día AAAA-MM-DD' },
      inicio: { type: 'string', description: 'Hora deseada HH:MM' },
      pista: { type: 'string', description: 'Nombre o id de la pista (opcional)' } },
      required: ['fecha', 'inicio'] } } },
];

function toolResult(ok, data) { return ok ? { ok: true, ...data } : { ok: false, error: data }; }

function dispatch(name, args, ctx) {
  const a = args || {};
  try {
    switch (name) {
      case 'identificarse': {
        const no = (a.member_no || '').trim();
        const m = B.getMember(no);
        if (!m || !m.active) return toolResult(false, 'Nº de socio no encontrado o desactivado.');
        if (!B.hasPin(no)) return toolResult(false, 'Ese socio aún no tiene PIN: debe activarlo en "Activar mi acceso" o en recepción.');
        if (pinLocked(no)) return toolResult(false, 'Demasiados intentos: espera 15 minutos.');
        if (!B.checkPin(no, a.pin)) {
          const locked = pinFail(no);
          return toolResult(false, locked ? 'Demasiados intentos: espera 15 minutos.' : 'PIN incorrecto.');
        }
        pinFails.delete(no);
        ctx.memberNo = no;
        return toolResult(true, { nombre: m.name, mensaje: `Hola ${m.name}, ya sé quién eres.` });
      }
      case 'ver_disponibilidad': {
        const err = checkDate(a.fecha);
        if (err) return toolResult(false, err);
        const pistas = ctx.courts.map(court => {
          const huecos = [];
          for (const g of B.freeSegments(court.id, a.fecha)) {
            for (const v of B.validStarts(g.start, g.end)) {
              huecos.push({ inicio: B.minToStr(v.start_min), duraciones: v.durations });
            }
          }
          return { pista: court.name, id: court.id, huecos };
        });
        return toolResult(true, { fecha: a.fecha, pistas });
      }
      case 'mis_reservas': {
        if (!ctx.memberNo) return toolResult(false, 'Necesito saber quién eres: dime tu nº de socio y tu PIN.');
        const area = B.memberArea(ctx.memberNo);
        return toolResult(true, {
          reservas: area.bookings.map(b => ({
            id: b.id, fecha: b.fecha, inicio: B.minToStr(b.start_min), fin: B.minToStr(b.end_min),
            pista: b.court_name, jugadores: b.players.map(p => p.name),
            plazas_libres: b.open_spots,
          })),
          ofertas_espera: area.offers.map(w => ({ id: w.id, fecha: w.date, inicio: B.minToStr(w.start_min), pista: w.court_name })),
        });
      }
      case 'preparar_reserva': {
        if (!ctx.memberNo) return toolResult(false, 'Necesito saber quién eres: dime tu nº de socio y tu PIN.');
        const err = checkDate(a.fecha);
        if (err) return toolResult(false, err);
        const start_min = B.strToMin(a.inicio);
        if (start_min === null) return toolResult(false, 'Hora no válida (usa HH:MM).');
        const { court, needChoice } = resolveCourt(ctx.courts, a.pista);
        if (!court) {
          if (needChoice) return toolResult(false, '¿En qué pista? ' + ctx.courts.map(c => c.name).join(', '));
          return toolResult(false, 'No encuentro esa pista.');
        }
        // Duración automática: la mayor configurada que encaje (75, si no 60…).
        const d = B.fitDuration(court.id, a.fecha, start_min);
        if (!d) return toolResult(false, 'Esa hora no está libre o no encaja sin dejar huecos. Pregunta por otra hora o mira la disponibilidad del día.');
        const extras = String(a.jugadores || '').split(',').map(s => s.trim()).filter(Boolean)
          .slice(0, 3).map(name => ({ name, member_no: '' }));
        const verr = B.validateNewBooking({
          court_id: court.id, date: a.fecha, start_min, duration_min: d,
          titular_member_no: ctx.memberNo, players: extras,
        });
        if (verr) return toolResult(false, verr);
        const member = B.getMember(ctx.memberNo);
        const names = [member.name, ...extras.map(e => e.name)].filter(Boolean).join(', ');
        const resumen = `${court.name} · ${a.fecha.split('-').reverse().join('/')} · ${B.minToStr(start_min)}–${B.minToStr(start_min + d)} (${d} min) · ${names}`;
        const id = newDraft('reserva', ctx.memberNo, {
          court_id: court.id, court_name: court.name, date: a.fecha,
          start_min, duration_min: d, titular_member_no: ctx.memberNo, players: extras,
        }, resumen);
        return toolResult(true, { draft_id: id, resumen });
      }
      case 'confirmar_reserva': {
        if (!ctx.memberNo) return toolResult(false, 'Necesito saber quién eres: dime tu nº de socio y tu PIN.');
        const { draft, error } = takeDraft(a.draft_id, ctx.memberNo, 'reserva');
        if (error) return toolResult(false, error);
        const r = B.createBooking(draft.payload);
        if (r.error) return toolResult(false, r.error);
        const b = B.getBooking(r.id);
        return toolResult(true, {
          reserva_id: r.id,
          confirmacion: `${b.court_name} · ${b.date.split('-').reverse().join('/')} · ${B.minToStr(b.start_min)}–${B.minToStr(b.end_min)}`,
          pago: b.payment_status === 'pending' ? 'Hay invitados: se paga en recepción.' : 'Sin cargos pendientes.',
        });
      }
      case 'preparar_anulacion': {
        if (!ctx.memberNo) return toolResult(false, 'Necesito saber quién eres: dime tu nº de socio y tu PIN.');
        const b = B.getBooking(parseInt(a.reserva_id, 10));
        if (!b || b.status !== 'active') return toolResult(false, 'No encuentro esa reserva activa.');
        if (b.titular_member_no !== ctx.memberNo) return toolResult(false, 'Esa reserva no es tuya.');
        const c = B.getConfig();
        const start = new Date(b.date + 'T00:00:00');
        start.setMinutes(b.start_min);
        const hoursLeft = (start - new Date()) / 3600000;
        if (hoursLeft < c.cancel_limit_h)
          return toolResult(false, `Ya no se puede anular online (límite: ${c.cancel_limit_h} h antes). Contacta con recepción.`);
        const resumen = `${b.court_name} · ${b.date.split('-').reverse().join('/')} · ${B.minToStr(b.start_min)}–${B.minToStr(b.end_min)}`;
        const id = newDraft('anulacion', ctx.memberNo, { booking_id: b.id }, resumen);
        return toolResult(true, { draft_id: id, resumen });
      }
      case 'confirmar_anulacion': {
        if (!ctx.memberNo) return toolResult(false, 'Necesito saber quién eres: dime tu nº de socio y tu PIN.');
        const { draft, error } = takeDraft(a.draft_id, ctx.memberNo, 'anulacion');
        if (error) return toolResult(false, error);
        const r = B.cancelBooking(draft.payload.booking_id, false);
        if (r.error) return toolResult(false, r.error);
        return toolResult(true, { anulada: true, resumen: draft.resumen });
      }
      case 'ver_partidos_abiertos': {
        const fecha = a.fecha || B.todayStr();
        const err = checkDate(fecha);
        if (err) return toolResult(false, err);
        const viewer = ctx.memberNo ? B.getMember(ctx.memberNo) : null;
        const v = viewer ? { member_no: viewer.member_no, level: viewer.level } : null;
        const rows = bdb.prepare(
          `SELECT bk.*, m.level AS booker_level, m.name AS booker_name FROM bookings bk
           LEFT JOIN club_members m ON m.member_no = bk.titular_member_no
           WHERE bk.date = ? AND bk.status = 'active' AND bk.open_spots > 0
           ORDER BY bk.start_min`).all(fecha);
        const partidos = [];
        for (const b of rows) {
          if (!B.openVisibleTo(b.titular_member_no, b.booker_level, v)) continue;
          const players = bdb.prepare('SELECT name FROM booking_players WHERE booking_id = ? ORDER BY id').all(b.id);
          partidos.push({
            id: b.id, pista: b.court_name,
            inicio: B.minToStr(b.start_min), fin: B.minToStr(b.end_min),
            plazas: b.open_spots, titular: b.booker_name || b.titular_name,
            nivel: B.levelRangeText(b.booker_level),
            apuntados: players.map(p => p.name),
          });
        }
        return toolResult(true, { fecha, partidos });
      }
      case 'apuntarse_partido': {
        if (!ctx.memberNo) return toolResult(false, 'Necesito saber quién eres: dime tu nº de socio y tu PIN.');
        const member = B.getMember(ctx.memberNo);
        const r = B.joinOpenMatch(parseInt(a.partido_id, 10), member);
        if (r.error) return toolResult(false, r.error);
        return toolResult(true, { apuntado: true });
      }
      case 'apuntarse_lista_espera': {
        if (!ctx.memberNo) return toolResult(false, 'Necesito saber quién eres: dime tu nº de socio y tu PIN.');
        const err = checkDate(a.fecha);
        if (err) return toolResult(false, err);
        const start_min = B.strToMin(a.inicio);
        if (start_min === null) return toolResult(false, 'Hora no válida (usa HH:MM).');
        const { court, needChoice } = resolveCourt(ctx.courts, a.pista);
        if (!court) {
          if (needChoice) return toolResult(false, '¿En qué pista? ' + ctx.courts.map(c => c.name).join(', '));
          return toolResult(false, 'No encuentro esa pista.');
        }
        const ds = [...B.getConfig().durations].sort((x, y) => y - x);
        const d = ds.find(x => B.isPotentiallyValid(court.id, a.fecha, start_min, x));
        if (!d) return toolResult(false, 'Esa hora no es válida para la lista de espera.');
        const r = B.joinWaitlist({
          court_id: court.id, court_name: court.name, date: a.fecha,
          start_min, duration_min: d, member_no: ctx.memberNo,
        });
        if (r.error) return toolResult(false, r.error);
        return toolResult(true, { en_espera: true, detalle: `${court.name} · ${a.fecha.split('-').reverse().join('/')} · ${a.inicio} (${d} min)` });
      }
      default:
        return toolResult(false, 'Herramienta desconocida.');
    }
  } catch (e) {
    return toolResult(false, 'Error interno: ' + e.message);
  }
}

// ------------------------------------------------------------ prompt del sistema
function buildSystemPrompt(member) {
  const c = B.getConfig();
  const now = new Date();
  const wd = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const hoy = `${wd[now.getDay()]} ${B.todayStr()}`;
  const maxD = B.addDays(B.todayStr(), c.days_ahead);
  const durs = [...c.durations].sort((x, y) => y - x);
  return `Eres el asistente de reservas de pistas del club. Hablas español de España, de forma cercana y concisa. Solo ayudas con reservas de pistas: disponibilidad, reservar, mis reservas, anular, lista de espera y partidos abiertos. Si te preguntan otra cosa, dilo amablemente y reconduce.

Hoy es ${hoy} (zona Europe/Madrid). Resuelve expresiones como "mañana", "el viernes" o "este finde" a fechas AAAA-MM-DD a partir de hoy.

Normas del club (úsalas siempre, no las inventes):
- Horario: ${B.minToStr(c.open_min)}–${B.minToStr(c.close_min)}. Duraciones: ${durs.join(' y ')} min (se usa automáticamente la mayor que encaje en el hueco).
- Se puede reservar hasta el ${maxD.split('-').reverse().join('/')} (${c.days_ahead} días).
- Anular online hasta ${c.cancel_limit_h} h antes; después, en recepción.
${c.guest_price ? `- Invitados (no socios): pagan ${c.guest_price} en recepción.` : `- Los invitados (no socios) pagan en recepción.`}
- Partidos abiertos: visibles según nivel (±1) y bloqueos; apuntarse exige estar identificado.

Reglas de actuación:
1. Para reservar, anular o apuntarte necesitas saber quién es el socio. Si no está identificado, pide su nº de socio y su PIN y usa "identificarse". El socio ${member ? `ya está identificado (${member.name})` : 'aún NO está identificado'}.
2. Disponibilidad y precios: consúltalos SIEMPRE con las herramientas, nunca los inventes.
3. Para crear una reserva: primero "preparar_reserva", muestra el resumen al socio y pregúntale si lo confirma; solo cuando diga que sí (explícitamente), llama a "confirmar_reserva" con el draft_id.
4. Para anular: primero "preparar_anulacion", muestra el resumen y pide confirmación explícita; luego "confirmar_anulacion".
5. Si falta un dato (pista, hora), pregunta antes de llamar a la herramienta.
6. Respuestas cortas, sin tecnicismos. Las horas en formato HH:MM y las fechas como "viernes 3/10".`;
}

// ------------------------------------------------------------ llamada al LLM
async function defaultLLM(cfg, messages, signal) {
  const res = await fetch(cfg.baseUrl + '/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://kanbeplay.padelvalles.com/',
      'X-Title': 'Reservas club padel (chat)',
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 600,
    }),
  });
  if (!res.ok) throw new Error('LLM respondió ' + res.status);
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const msg = (choice && choice.message) || {};
  return {
    content: msg.content || null,
    toolCalls: (msg.tool_calls || []).map(t => ({
      id: t.id, name: t.function.name,
      args: JSON.parse(t.function.arguments || '{}'),
    })),
    usage: (data.usage && {
      in: data.usage.prompt_tokens || 0,
      out: data.usage.completion_tokens || 0,
    }) || { in: 0, out: 0 },
  };
}

// ------------------------------------------------------------ bucle principal
async function runChat({ message, session, llm }) {
  const cfg = chatConfig();
  if (!cfg.enabled)
    return { reply: 'El chat de reservas no está disponible ahora mismo. Puedes reservar desde la parrilla.', disabled: true };
  if (spendThisMonth() >= cfg.capEur)
    return { reply: 'El chat ha llegado a su tope mensual y está en pausa. Puedes reservar desde la parrilla sin problema.', capped: true };

  // Límite diario por socio/sesión.
  const today = B.todayStr();
  session.chatUsage = session.chatUsage || {};
  if (session.chatUsage.date !== today) session.chatUsage = { date: today, n: 0 };
  if (session.chatUsage.n >= cfg.dayLimit)
    return { reply: 'Has llegado al límite de mensajes de hoy en el chat. Mañana seguimos, o usa la parrilla.', limited: true };
  session.chatUsage.n++;

  const member = session.bookingMemberNo ? B.getMember(session.bookingMemberNo) : null;
  const ctx = { memberNo: member ? member.member_no : null, courts: activeCourts() };
  const history = (session.chatHistory || []).slice(-20);
  const messages = [
    { role: 'system', content: buildSystemPrompt(member) },
    ...history,
    { role: 'user', content: message },
  ];

  let reply = 'Se me ha atragantado la respuesta. Prueba de nuevo o usa la parrilla.';
  let totalIn = 0, totalOut = 0;
  try {
    for (let step = 0; step < cfg.maxTurns; step++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let out;
      try {
        out = llm
          ? await llm(messages, TOOLS)
          : await defaultLLM(cfg, messages, ctrl.signal);
      } finally { clearTimeout(timer); }
      totalIn += out.usage.in; totalOut += out.usage.out;
      if (out.toolCalls.length) {
        messages.push({
          role: 'assistant', content: out.content,
          tool_calls: out.toolCalls.map(t => ({
            id: t.id, type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.args) },
          })),
        });
        for (const t of out.toolCalls) {
          const r = dispatch(t.name, t.args, ctx);
          messages.push({ role: 'tool', tool_call_id: t.id, content: JSON.stringify(r) });
        }
        continue;
      }
      if (out.content) reply = out.content;
      break;
    }
  } catch (e) {
    console.error('chat LLM:', e.message);
    reply = 'No he podido contactar con el asistente ahora mismo. Prueba de nuevo en un momento o usa la parrilla.';
  }
  addSpend(estimateCostEur(cfg.model, totalIn, totalOut));

  // La identificación dentro del chat inicia sesión también en la web.
  if (ctx.memberNo && ctx.memberNo !== session.bookingMemberNo)
    session.bookingMemberNo = ctx.memberNo;

  session.chatHistory = [...history.slice(-18), { role: 'user', content: message }, { role: 'assistant', content: reply }];
  return { reply, identified: !!ctx.memberNo };
}

module.exports = {
  chatConfig, runChat, dispatch, TOOLS, buildSystemPrompt,
  estimateCostEur, spendThisMonth, addSpend, monthKey,
  // solo para tests:
  _drafts: drafts, _newDraft: newDraft, _takeDraft: takeDraft,
};
