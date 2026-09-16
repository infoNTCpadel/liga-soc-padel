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

## Despliegue en tu VPS (Hostinger)

1. Clona el repositorio y entra en la carpeta:
   ```bash
   git clone https://github.com/infoNTCpadel/liga-soc-padel.git
   cd liga-soc-padel
   ```
2. Crea el fichero `.env` a partir del ejemplo y pon un `SESSION_SECRET` largo y aleatorio:
   ```bash
   cp .env.example .env
   # edita .env y cambia SESSION_SECRET por una cadena aleatoria
   ```
3. Arranca con Docker:
   ```bash
   docker compose up -d --build
   ```
4. La app responde en `http://TU_IP:3000`.

Para actualizar a una versión nueva (los datos están en `./data` y no se tocan):
```bash
git pull
docker compose up -d --build
```

## Dominio propio y HTTPS

### Opción definitiva: tu propio dominio
1. Consigue el dominio (p. ej. en Hostinger → Dominios) o usa uno que ya tengas.
2. En la zona DNS del dominio crea un registro **A**:
   - `@` → la IP de tu VPS
   - `www` → la IP de tu VPS (opcional)
3. Espera a que propague (normalmente minutos). Compruébalo con `ping tudominio.com`.
4. En el VPS, instala Caddy (proxy inverso con HTTPS automático y gratuito vía Let's Encrypt):
   ```bash
   apt install -y debian-keyring debian-archive-keyring apt-transport-https
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
   apt update && apt install -y caddy
   ```
5. Edita `/etc/caddy/Caddyfile` con tu dominio:
   ```
   tudominio.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```
6. Recarga Caddy: `systemctl reload caddy`. Desde ese momento `https://tudominio.com`
   sirve la app con certificado válido, renovado solo.
7. (Recomendado) Haz que Docker solo escuche en local. En `docker-compose.yml` cambia
   `ports: ["3000:3000"]` por `ports: ["127.0.0.1:3000:3000"]` y reconstruye.

### Opción provisional gratuita: subdominio DuckDNS
Si aún no tienes dominio, puedes usar uno gratis en 5 minutos:
1. Entra en [duckdns.org](https://www.duckdns.org), regístrate y crea un subdominio
   (p. ej. `tuliga.duckdns.org`) apuntando a la IP de tu VPS.
2. Sigue los pasos 4–6 anteriores usando `tuliga.duckdns.org` como dominio en el Caddyfile.
   Caddy también emite certificado HTTPS válido para subdominios DuckDNS.

---

## Temporadas

La app gestiona **varias temporadas** (p. ej. «Liga Social de Invierno», «Apertura»…).
Cada temporada tiene sus propios datos aislados: parejas, grupos, partidos,
ajustes (precios, fechas, nombre del club) y preguntas del formulario.

- **Los jugadores solo ven y acceden a la temporada activa.** Su código de pareja
  solo funciona mientras esa temporada esté activa.
- La organización cambia de temporada en **/admin → Temporadas**: crear, activar,
  renombrar y eliminar (no se puede eliminar la activa).
- La barra del panel muestra siempre el nombre de la temporada activa.
- Crear una temporada no activa la anterior: empieza vacía y lista para configurar.

### Temporada de prueba con datos inventados
Para probar sin tocar los datos reales, el proyecto incluye un generador:
```bash
docker compose exec liga node src/seed-test-season.js "Temporada de Prueba" 100 40 36
```
Crea la temporada (inactiva) con 100 parejas masculinas, 40 femeninas y 36 mixtas
inventadas (nombres, teléfonos, emails, niveles y pagos aleatorios). Los números
son opcionales: `node src/seed-test-season.js "Nombre" [nM] [nF] [nX]`.
Después actívala desde **/admin → Temporadas** para trastear con grupos,
resultados y playoffs. Cuando termines, vuelve a activar la temporada real y,
si quieres, elimina la de prueba.

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
  Puedes mover parejas entre grupos (desplegable → **Mover**) mientras no tengan
  resultados, y **eliminar los grupos para volver a generarlos** (botón
  «Eliminar grupos y volver a generar», solo si no hay resultados): útil si se
  apunta alguna pareja de última hora.
- En la vista pública **/liga**, la clasificación muestra los **movimientos
  previstos** (quién sube, baja o permanece) según la posición actual.
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

- SQLite con WAL; una base de datos por temporada (`data/season-<id>.db`) más
  `data/meta.db` con la lista de temporadas y la contraseña de la organización.
- Sesiones en memoria: pensado para una sola instancia (suficiente para un club).
- Sin dependencias nativas: la imagen Docker compila en segundos.
- Copia de seguridad: basta con copiar la carpeta `data/` entera.
- Al actualizar desde la versión de una sola temporada, `data/liga.db` se migra
  automáticamente a la primera temporada (temporada 1, activa) sin perder datos.
