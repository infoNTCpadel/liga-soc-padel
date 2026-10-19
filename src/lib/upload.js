// Subida de archivos sin dependencias: parser multipart mínimo + carteles de eventos.
// El redimensionado se hace en el navegador (canvas → JPG ligero); aquí solo se
// valida tipo por magic bytes y peso máximo, y se guarda en DATA_DIR/event-posters/.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../db');

const MAX_BYTES = 3 * 1024 * 1024;      // tope del cuerpo multipart
const MAX_IMG = 800 * 1024;             // tope de la imagen (el navegador la deja en ~100-200 KB)

function postersDir() {
  const d = path.join(dataDir, 'event-posters');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Parsea un cuerpo multipart/form-data. Devuelve { fields, file } o null si no es multipart.
// file = { field, filename, type, data } o null si no se adjuntó archivo.
function parseMultipart(req, maxBytes = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    const m = ct.match(/boundary=([^;]+)/);
    if (!m) return resolve(null);
    const boundary = Buffer.from('--' + m[1].trim());
    const chunks = [];
    let size = 0, dead = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes && !dead) {
        dead = true;
        reject(new Error('El envío es demasiado grande.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (dead) return;
      try {
        const buf = Buffer.concat(chunks);
        const fields = {};
        let file = null;
        let i = 0;
        for (;;) {
          const bStart = buf.indexOf(boundary, i);
          if (bStart < 0) break;
          let p = bStart + boundary.length;
          if (buf[p] === 45 && buf[p + 1] === 45) break; // -- final
          if (buf[p] === 13 && buf[p + 1] === 10) p += 2;
          const hEnd = buf.indexOf('\r\n\r\n', p);
          if (hEnd < 0) break;
          const headers = buf.toString('latin1', p, hEnd);
          const nm = headers.match(/name="([^"]*)"/);
          const fn = headers.match(/filename="([^"]*)"/);
          const dataStart = hEnd + 4;
          const dataEnd = buf.indexOf(boundary, dataStart);
          if (dataEnd < 0 || !nm) break;
          let data = buf.subarray(dataStart, dataEnd);
          if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) {
            data = data.subarray(0, data.length - 2);
          }
          if (fn) {
            if (fn[1]) { // input file vacío → se ignora
              const ctm = headers.match(/Content-Type:\s*([^\r\n]+)/i);
              file = { field: nm[1], filename: fn[1], type: (ctm && ctm[1].trim()) || '', data: Buffer.from(data) };
            }
          } else {
            fields[nm[1]] = data.toString('utf8');
          }
          i = dataEnd;
        }
        resolve({ fields, file });
      } catch (e) { reject(e); }
    });
  });
}

// Devuelve mensaje de error o null si la imagen vale. Solo JPG/PNG por magic bytes.
function validImage(file) {
  if (!file || !file.data || file.data.length === 0) return null; // no adjuntó: válido (opcional)
  if (file.data.length > MAX_IMG) return 'La imagen pesa más de 800 KB: usa el formulario (la reduce solo).';
  const d = file.data;
  const isJpeg = d[0] === 0xFF && d[1] === 0xD8 && d[2] === 0xFF;
  const isPng = d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4E && d[3] === 0x47;
  if (!isJpeg && !isPng) return 'El archivo no es una imagen válida (JPG o PNG).';
  return null;
}

function imageExt(file) {
  const d = file.data;
  return (d[0] === 0x89) ? 'png' : 'jpg';
}

// Guarda el cartel del evento (id) y devuelve el nombre de archivo, o '' si no hay.
function savePoster(eventId, file) {
  const dir = postersDir();
  // Borra versiones anteriores (jpg/png)
  for (const f of fs.readdirSync(dir)) {
    if (f === `${eventId}.jpg` || f === `${eventId}.png`) fs.rmSync(path.join(dir, f), { force: true });
  }
  if (!file || !file.data || file.data.length === 0) return '';
  const name = `${eventId}.${imageExt(file)}`;
  fs.writeFileSync(path.join(dir, name), file.data);
  return name;
}

function removePoster(eventId) {
  const dir = postersDir();
  for (const f of fs.readdirSync(dir)) {
    if (f === `${eventId}.jpg` || f === `${eventId}.png`) fs.rmSync(path.join(dir, f), { force: true });
  }
}

function posterPath(filename) {
  if (!/^\d+\.(jpg|png)$/.test(filename || '')) return null;
  const fp = path.join(postersDir(), filename);
  return fs.existsSync(fp) ? fp : null;
}

module.exports = { parseMultipart, validImage, savePoster, removePoster, posterPath, postersDir };
