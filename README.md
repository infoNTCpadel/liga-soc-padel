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
  (los datos básicos —nombres, teléfonos, nivel— siempre se piden). La
  **camiseta oficial** es una pregunta del sistema: está inactiva por defecto
  y se activa aquí cuando el club la ofrezca; el precio se configura en
  **/admin/ajustes**.
- Comparte el enlace **/inscripcion** con los jugadores. Cuando se acabe el
  plazo, marca **«Inscripción cerrada»** en **/admin/ajustes**: el formulario
  público dejará de admitir parejas (el admin puede seguir añadiéndolas a
  mano desde **/admin/parejas**).

### 2. Inscripciones (hasta el 2 de octubre)
- Cada persona puede jugar **una o dos modalidades** (combinaciones permitidas:
  masculina + mixta, o femenina + mixta), con parejas distintas en cada una;
  puede inscribirlas juntas o en días distintos. No puede repetir modalidad
  ni jugar una tercera. La identidad entre inscripciones es el **teléfono**
  (normalizado: da igual que se escriba con +34, 0034, espacios o guiones).
- El formulario pide **sexo** (obligatorio): la mixta debe ser un hombre y
  una mujer; en las demás categorías, un sexo incoherente muestra un aviso
  «⚠ revisar sexo» en **/admin/inscripciones**.
- El aviso «⚠ posible duplicado» solo salta con el mismo nombre o teléfono
  en dos parejas de la **misma** categoría. Si el jugador está en otra
  modalidad verás el distintivo «2 modalidades» (es legítimo).
- **Precios configurables** en Ajustes: inscripción 1 modalidad (15 € por
  defecto) e inscripción 2 modalidades (25 € por defecto). El pago sigue
  siendo simple (pagado/no pagado) y se controla en la ficha de cada pareja,
  donde verás el precio esperado de cada jugador según sus modalidades.
  Como el pago es por persona, al marcarlo en una pareja se propaga
  automáticamente a sus demás parejas (mismo teléfono).
- El **teléfono** identifica al jugador entre modalidades e inscripciones:
  se normaliza (+34, 0034, espacios y guiones dan igual) y se valida que
  parezca un móvil español (9 dígitos, empieza por 6 o 7).
- **Camiseta: una por jugador y temporada**. Si ya la pidió en otra
  inscripción, el formulario la ignora y avisa.
- Cada pareja recibe un **código de acceso** para gestionar sus partidos.
  Desde **Mis datos** pueden actualizar sus datos, **cambiar el capitán**
  de la pareja si lo deciden entre los dos, y anotar su
  **disponibilidad** (días que no pueden jugar, máx. 120 caracteres); al
  programar pista y horario en **/admin/partidos** verás esa nota.

### 3. Ronda 1 (5 oct – 1 nov)
- **/admin/grupos**: genera los grupos por nivel y el calendario (todos contra todos).
  Puedes mover parejas entre grupos (desplegable → **Mover**) mientras no tengan
  resultados, y **eliminar los grupos para volver a generarlos** (botón
  «Eliminar grupos y volver a generar», solo si no hay resultados): útil si se
  apunta alguna pareja de última hora.
- En la vista pública **/liga**, la clasificación muestra los **movimientos
  previstos** (quién sube, baja o permanece) según la posición actual. Desde
  **/admin/grupos** puedes exportar la clasificación de cada ronda a CSV.
- Las parejas suben sus resultados desde **/pareja**; el rival tiene 24 h para
  validarlos (si no, se validan solos). Puedes corregir resultados en
  **/admin/partidos** y marcar W.O. o partidos no jugados.
- **/admin/parejas**: filtra por categoría (M/F/X) y ordena por nivel de mayor
  a menor; también puedes exportar la lista a CSV.
- **Cerrar la ronda** (vista previa con movimientos y puntos) cuando termine el
  plazo: los partidos sin resultado contarán como no jugados y **ya no se
  podrán subir ni corregir resultados** (ni las parejas ni el admin) hasta
  reabrirla.

### 4. Rondas 2 y 3
- Genera los nuevos grupos: se aplican solos los **ascensos y descensos**
  (1º sube 2, 2º sube 1, 3º baja 1, 4º baja 2, con las excepciones del
  Grupo 1, Grupo 2, penúltimo y último).
- Repite el ciclo: calendario → resultados → cierre. El **ranking** acumula los
  puntos de cada ronda automáticamente.

### 5. Playoffs (28 dic – 31 ene)
- **/admin/playoffs**: genera los cuadros. Las parejas marcadas como «no juega»
  se retiran **antes** de dividir el ranking en categorías de 16 (1ª, 2ª,
  3ª…), así las siguientes ascienden de categoría; si el resto final tiene
  menos de 8 parejas, esas no juegan. Antes de generar puedes reordenar
  cabezas de serie (↑ ↓). En el cuadro ya generado puedes intercambiar
  parejas de primera ronda: las etiquetas de cabeza de serie viajan con la
  pareja.
- Colocación: cabeza nº 2 arriba del todo, nº 1 abajo del todo, nº 3 y 4 por
  sorteo en los cuartos que cruzarían en semifinales. Huecos vacíos = BYE (la
  pareja exenta pasa de ronda automáticamente). Ya generado, puedes
  intercambiar parejas dentro del cuadro mientras no haya resultados.
- Los ganadores avanzan solos de ronda. Los resultados los suben las parejas
  o la organización. Los campeones de cada playoff son los campeones de la
  temporada en su categoría.
- Al terminar, **cierra los playoffs** desde **/admin/playoffs** para bloquear
  la entrada de resultados. En **/admin/partidos** puedes filtrar por bloque
  (1ª, 2ª, 3ª…) y ver cuántos partidos quedan sin programar.

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
