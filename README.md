# Liga de Pádel — App de gestión (Master Padel League, un club)

Aplicación web completa para gestionar la liga de pádel por parejas de tu club
según la normativa oficial: inscripciones, pagos, grupos, resultados con
validación de 24 h, clasificaciones con desempates, ascensos/descensos,
ranking por puntos y playoffs.

**Stack:** Node.js 24 + Express + SQLite (integrado en Node, sin dependencias
nativas) + EJS. Todo corre en un único contenedor; los datos viven en un
fichero SQLite (`./data/liga.db`).

---

## Puesta en marcha en local

```bash
npm install
npm start
# abrir http://localhost:3000
```

La primera vez que entres en **/admin** se te pedirá crear la contraseña de la
organización.

## Despliegue con Docker

```bash
cp .env.example .env   # y edita SESSION_SECRET
docker compose up -d --build
# abrir http://TU_SERVIDOR:3000
```

Los datos persisten en `./data` (volumen). Para parar: `docker compose down`.

## Dónde desplegarla (opciones)

### Opción A — Railway (recomendado, lo más sencillo)
1. Sube este proyecto a un repositorio de GitHub.
2. En [railway.app](https://railway.app) crea un proyecto → *Deploy from GitHub Repo*.
3. Añade un **Volume** montado en `/app/data` (para que no se pierdan los datos).
4. Variables de entorno: `SESSION_SECRET` (cadena larga aleatoria).
5. Railway te da una URL pública HTTPS automáticamente.

### Opción B — Render
1. Sube el proyecto a GitHub.
2. En [render.com](https://render.com) crea un *Web Service* desde el repo (Docker).
3. Añade un **Disk** montado en `/app/data`.
4. Variable de entorno: `SESSION_SECRET`.

### Opción C — VPS propio (p. ej. Hetzner, DigitalOcean)
1. Instala Docker en el servidor.
2. Copia el proyecto y ejecuta `docker compose up -d --build`.
3. (Recomendado) Pon delante Caddy o Nginx como proxy inverso con tu dominio
   para tener HTTPS.

---

## Guía de uso por fases de la temporada

### 1. Preparación
- **/admin/ajustes**: pon el nombre de tu club, revisa las fechas de cada fase.
- **/admin/preguntas**: añade preguntas extra al formulario de inscripción
  (los datos básicos —nombres, teléfonos, nivel, camiseta— siempre se piden).
- Comparte el enlace **/inscripcion** con los jugadores.

### 2. Inscripciones (hasta el 2 de octubre)
- Revisa cada inscripción en **/admin/inscripciones** y actívala.
- Marca quién ha pagado en el club (19,95 €/jugador) desde la ficha de cada
  pareja; controla las camisetas (14,95 €) en el mismo sitio.
- Cada pareja recibe un **código de acceso** para gestionar sus partidos.

### 3. Ronda 1 (5 oct – 1 nov)
- **/admin/grupos**: genera los grupos por nivel y el calendario (todos contra todos).
- Las parejas suben sus resultados desde **/pareja**; el rival tiene 24 h para
  validarlos (si no, se validan solos). Puedes corregir resultados en
  **/admin/partidos** y marcar W.O. o partidos no jugados.
- **Cerrar la ronda** (vista previa con movimientos y puntos) cuando termine el
  plazo: los partidos sin resultado contarán como no jugados.

### 4. Rondas 2 y 3
- Genera los nuevos grupos: se aplican solos los **ascensos y descensos**
  (1º sube 2, 2º sube 1, 3º baja 1, 4º baja 2, con las excepciones del
  Grupo 1, Grupo 2, penúltimo y último).
- Repite el ciclo: calendario → resultados → cierre. El **ranking** acumula los
  puntos de cada ronda automáticamente.

### 5. Playoffs (28 dic – 31 ene)
- **/admin/playoffs**: genera los cuadros. El ranking se divide por la mitad:
  playoff de 1ª y de 2ª categoría, con cabezas de serie y byes si hace falta.
- Los ganadores avanzan solos de ronda. Los resultados los suben las parejas
  o la organización. Los campeones de cada playoff son los campeones de la
  temporada en su categoría.

### Cambios de pareja
Las parejas lo solicitan desde su panel; la app solo permite un cambio, exige
el mismo nivel (mismo tramo Playtomic) y lo bloquea una vez empezados los
playoffs. La organización lo aprueba en **/admin/cambios**.

---

## Notas técnicas

- SQLite con WAL; un único fichero en `DATA_DIR` (por defecto `./data`).
- Sesiones en memoria: pensado para una sola instancia (suficiente para un club).
- Sin dependencias nativas: la imagen Docker compila en segundos.
- Copia de seguridad: basta con copiar `data/liga.db`.
