# Booth 360

App web (PWA) para plataforma 360: graba con la cámara del iPhone, edita el video con velocidades
(rápido, lento, reverso/boomerang), efectos animados (brillos, estrellas, corazones, bokeh, confeti),
texto o PNG superpuesto y música recortada, y lo guarda en el teléfono listo para enviar por WhatsApp.
Reemplaza el flujo que hoy se hace con LumaBooth, sin suscripción mensual.

Todo se procesa en el teléfono (sin servidor, sin internet durante el evento). Los videos no salen del
iPhone salvo que vos los compartas.

## Instalación (una sola vez)

La app necesita abrirse por **HTTPS** para que Safari permita la cámara. La forma más simple y gratis:

1. Subí la carpeta `booth360` a un hosting estático. Opciones gratuitas:
   - **Netlify Drop**: entrá a https://app.netlify.com/drop y arrastrá la carpeta. Te da una URL `https://....netlify.app`.
   - **GitHub Pages**: creá un repositorio, subí los archivos y activá Pages en Settings → Pages (branch `main`, carpeta `/`).
   - **Cloudflare Pages** o **Vercel**: también sirven, es un sitio estático sin build.
2. En el iPhone abrí la URL en **Safari**.
3. Tocá **Compartir → “Agregar a inicio”**. Queda como app a pantalla completa, con ícono propio, y funciona sin conexión después de la primera carga.
4. La primera vez que toques **Grabar** Safari va a pedir permiso de cámara: aceptá.

Requisitos: iPhone con iOS 17 o superior (usa WebCodecs). También funciona en Android con Chrome.

Para probar en una computadora: `python3 -m http.server 8787` dentro de la carpeta y abrir `http://localhost:8787`.

## Uso en el evento

1. En **Inicio** escribí el nombre del evento (se usa para nombrar los archivos).
2. **Grabar 360** → se abre la cámara trasera. Tocá el botón redondo: aparece el texto “¡Preparate!”, la cuenta regresiva y graba los segundos configurados (15 por defecto).
3. La app edita el video al instante (ves el progreso en pantalla).
4. En la pantalla de resultado:
   - **Guardar en Fotos / Compartir**: abre la hoja de compartir del iPhone. Elegí **“Guardar video”** para dejarlo en Fotos (y después usás tu atajo de WhatsApp como siempre), o mandalo directo a WhatsApp desde ahí.
   - **Guardar original (comprimido)**: guarda y comparte el video sin editar, recomprimido liviano (3 Mbps por defecto, ~5 MB por 15 s).
   - **Grabar otro**: vuelve a la cámara.
5. Los videos también quedan en la **Galería** de la app (dentro del teléfono) si está activado en Configuración → 6.

**Empezar al girar la plataforma** (opcional, apagado de fábrica): Configuración → 6 → "Empezar a grabar al girar la plataforma", con sensibilidad baja, media o alta. Usa el giroscopio del iPhone: cuando el brazo gira, arranca la cuenta regresiva y graba. Se vuelve a habilitar cuando la plataforma queda quieta 2 segundos. En la pantalla de grabar, el botón **🔄** muestra el estado (verde: listo; naranja: esperando que se detenga) y lo apaga o prende al toque, por si el sensor anda mal. El botón rojo funciona siempre. La primera vez el iPhone pide permiso para los sensores de movimiento.

**Control Bluetooth**: un control tipo teclado o de presentaciones (Enter, espacio, flechas o Página arriba/abajo) empieza la grabación en la pantalla de grabar; si lo apretás mientras graba, la corta antes (mínimo 1 segundo). En la pantalla del resultado vuelve a la cámara ("Grabar otro"). Los controles que solo mandan "subir volumen" (los de selfie más baratos) no sirven desde Safari.

## Novedades (octubre 2026)

- **Video girado en el iPhone, arreglado**: el iPhone entrega los cuadros de la cámara acostados (como los lee el
  sensor) con una marca de giro; antes se grababan así y el video editado salía girado. Ahora se graban tal como se
  ven en pantalla, y si el teléfono pasa a horizontal en medio de la grabación el clip sigue vertical.
- **Al ritmo de la música** (Configuración → 5, prendido de fábrica): la app busca el pulso de la canción (el bombo,
  las palmas) y corre un poco cada cambio de velocidad y el final del video para que caigan justo sobre un golpe
  (cada borde se mueve como mucho un 30 % de su tramo). Si la canción no tiene un pulso claro (un tema lento, sin
  batería), no toca nada. En el resultado dice "al ritmo (120 BPM)" cuando lo aplicó.
- **Congelar la imagen**: cada tramo de la línea de tiempo puede terminar con la imagen quieta ½, 1 o 2 segundos
  (Configuración → 1 → "Congelar la imagen al final"). Preset nuevo: "Rápido, pausa y lento".
- **Filtros de color** (Configuración → 3): Natural, Blanco y negro, Glam (B y N con contraste), Cálido, Frío,
  Vintage y Vivo. Cambian solo la imagen de la cámara: el texto, el PNG y los efectos quedan con sus colores.
- Solidez: si el iPhone cierra la base de datos con la app en segundo plano, se reabre sola; la cámara no se abre dos
  veces con un doble toque; al grabar se usa el reloj de la cámara (menos cuadros dobles) y, si el codificador se
  atrasa, no se acumulan cuadros en la memoria.
- **Perfiles del evento** (pantalla de Inicio): toda la configuración (texto o PNG, placa final, velocidades, efectos,
  música, salida y nombre del evento) se guarda con un nombre y se cambia con un toque. Sirve para dejar preparados
  los eventos de la noche antes de salir. Las canciones son las mismas para todos los perfiles.
- **Placa final** (Configuración → 4): una imagen con tu logo o la marca del evento aparece al final del video con un
  fundido, de 1 a 4 segundos. La música sigue hasta el final de la placa.
- **Edición casi el doble de rápida**: los cuadros del clip se leen con un solo decodificador (antes se creaba uno por
  cuadro) y el texto se dibuja una sola vez. En una PC de prueba: 41 s de video en 13 s (antes 21 s).
- **Video más parejo y nítido**: se sacaron los saltitos (cuadros repetidos) que aparecían en la cámara lenta en reverso
  y el achicado de la imagen usa el filtro fino. Los efectos ya están en pantalla desde el primer cuadro.
- **Cámara lenta sin "latido"**: a 0,5x cada cuadro sale mezclado parejo (75/25) en vez de alternar uno nítido y uno
  doble. Para la cámara lenta más fluida, grabá a 60 fps si el iPhone lo permite (Configuración → 6).
- **Volumen parejo**: cada canción se lleva sola a -14 LUFS (el volumen de Instagram, TikTok y WhatsApp), con el pico
  por debajo de -2 dB. Una canción bajita y una fuerte salen parecidas, y nada satura.
- **Efectos más lindos**: estrellas y confeti caen hasta abajo y los corazones suben hasta arriba (antes se apagaban a
  mitad de camino); el confeti es más grande y da vueltas.
- **Texto en zona segura**: nunca queda pegado al borde de abajo, donde WhatsApp, Reels y TikTok ponen sus botones.
  La posición de fábrica es un poco más arriba.
- **720 a 5 Mbps** de fábrica (antes 6): WhatsApp lo recomprime igual y así pesa menos y se comparte más rápido.
  Elegí la misma resolución final que la de la cámara: 1080 desde 720 solo agranda la imagen.
- **Aviso de video largo**: si la línea de tiempo deja el video final en más de 30 s, el resumen avisa (ideal 15–25 s
  para que la fila avance).
- **Letras sin internet**: las fuentes del texto vienen dentro de la app (antes se bajaban de Google y, sin conexión,
  los videos salían con otra letra).
- **Abre al instante sin internet**: la app sale de la memoria del teléfono y se actualiza por detrás.
- Arreglos: la memoria ya no se llena con muchas canciones; si el teléfono se queda sin espacio, el video igual se
  muestra y se comparte; ✕ y ⟲ no hacen nada mientras graba o edita; un doble toque del control durante la cuenta
  regresiva ya no corta la grabación a 1 segundo; si el iPhone no deja compartir solo, el botón Compartir late para
  tocarlo; la galería libera los videos al salir; el sonido de la cuenta regresiva se activa con el toque.

## Prueba de calidad (`test\jueces.js`)

Renderiza un video de prueba en varias configuraciones y mide nitidez, cuadros repetidos, suavidad de la cámara lenta,
niveles, volumen (LUFS) y fundidos del audio, que la música arranque en el punto elegido, duración audio/video,
"latido" de la cámara lenta, tiempo de edición (720 y 1080), cuánto se ven los efectos y dónde quedan, y la placa
final. Deja
`test\salida\jueces\informe.md` con los números y cuadros PNG para mirar:
`"..\Código del programa\node_modules\electron\dist\electron.exe" test\jueces.js`.

## Configuración

1. **Velocidades (línea de tiempo)**: presets (Normal, Rápido → lento, Boomerang, Cámara lenta, Épico…) o tramos personalizados. Cada tramo tiene velocidad (0.25x a 3x), dirección (adelante/atrás) y qué parte del clip usa (por ejemplo del 50 % al 100 %). “Reverso” reproduce todo hacia adelante y después hacia atrás. “Suavizar cámara lenta” mezcla cuadros para que el 0.5x se vea fluido.
2. **Video de prueba**: previsualizá la edición con la última grabación o con un video de Archivos.
3. **Efectos animados**: brillos, estrellas que caen, corazones (con color), bokeh, confeti o brillos + corazones, con intensidad 1–3.
4. **Texto superpuesto**: texto con fuente (Great Vibes, Dancing Script, Pacifico, Playfair, Bebas Neue, Montserrat), tamaño, color, sombra, borde y un emoji opcional arriba (👑). Arrastrá el texto en la vista previa para ubicarlo. Si preferís seguir usando tus PNG transparentes de 720×1280, elegí “Imagen PNG”.
5. **Música**: agregá canciones completas (MP3, M4A/AAC, WAV). Para cada una marcás desde qué segundo empieza, tocando o arrastrando la forma de onda; la app usa exactamente la duración del video final, con entrada suave y bajada de volumen al final. Las canciones se eligen al azar o en orden en cada grabación.
6. **Grabación y salida**: duración de la grabación (5–30 s), cuenta regresiva, texto previo, 30 o 60 fps (si el iPhone lo permite desde Safari), resolución de cámara y del video final (720×1280 o 1080×1920), calidad en Mbps, guardar en galería, guardar el original comprimido, abrir “Compartir” automáticamente.

La sección **Estado del dispositivo** muestra qué funciones soporta el navegador y el espacio usado.

## Cómo funciona por dentro

- `js/capture.js`: abre la cámara y graba con `VideoEncoder` un MP4 en el que **cada cuadro es keyframe**, para poder leer cualquier cuadro al instante (reverso y cámara lenta sin esperas).
- `js/render.js`: arma el plan de cuadros según la línea de tiempo, dibuja cada cuadro en un canvas (video + efectos + texto) y lo codifica a H.264 con `mediabunny` (muxer MP4). Si el dispositivo no tiene H.264 usa HEVC/VP9/AV1.
- `js/audio.js`: recorta la canción con Web Audio, aplica fundidos y la codifica a AAC con `AudioEncoder`. Si el navegador no puede codificar AAC, copia los paquetes AAC/MP3 originales sin recodificar.
- `js/effects.js`: partículas deterministas con sprites pre-dibujados.
- `js/overlay.js`: texto (con las fuentes de `fonts/`, incluidas en la app) o PNG a pantalla completa.
- `js/beats.js`: busca el pulso de la canción (tempo y golpes) para acomodar los cambios de velocidad sobre la música.
- `js/db.js`: IndexedDB para música, imágenes, video de prueba y galería.
- `sw.js`: service worker para uso sin conexión.
- `vendor/mediabunny.min.mjs`: librería de muxing/demuxing (licencia MPL-2.0, ver `vendor/mediabunny-LICENSE`).

## Limitaciones conocidas

- Safari limita la cámara web a 30 fps en muchos modelos; la opción de 60 fps se aplica solo si el iPhone lo permite. La cámara lenta a 0.5x con 30 fps se suaviza mezclando cuadros.
- El flash parpadeante durante la grabación no está disponible desde Safari (no hay acceso a la linterna).
- La subida automática a la nube no está incluida (evita gasto de datos). Los originales comprimidos quedan en la galería de la app y se pueden compartir a Archivos/iCloud cuando haya Wi-Fi.
- El video final tarda aproximadamente lo mismo que dura (un video de 30 s se edita en 15–40 s según el iPhone).

## Archivos de prueba (desarrollo)

En esta PC, sin instalar nada (desde la carpeta de la app, con `"..\Código del programa\node_modules\electron\dist\electron.exe"`):
- `test\probar.js`: cámara simulada; graba, edita, prueba el control Bluetooth, el arranque por giro y los perfiles. Deja los MP4 y capturas en `test\salida\funcional`.
- `test\giro.js`: simula la cámara del iPhone (cuadros acostados, y un cambio a horizontal en medio) y revisa que el
  clip quede vertical y derecho.
- `test\ritmo.js`: el detector de pulso (120 BPM y una canción sin pulso), los cambios de velocidad sobre los golpes, la pausa y los filtros de color. Deja todo en `test\salida\ritmo` (`filtros.png` muestra los 7 filtros).
- `test\jueces.js`: la prueba de calidad (ver arriba).


En `test/` (no se sube al hosting) hay un script de Playwright que simula la cámara, graba, edita y verifica el MP4.
