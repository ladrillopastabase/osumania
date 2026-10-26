# Generador automático de beatmaps para osu!mania

Página web que recibe una canción (MP3 / WAV / FLAC / OGG / M4A), la analiza y genera
beatmaps de **4K y 7K** en cuatro dificultades (**Easy · Normal · Hard · Insane**),
con patrones híbridos basados en ritmo, melodía y jugabilidad. Los mapas se
previsualizan en el navegador y se descargan como `.osu` sueltos o como un `.osz`
listo para importar en osu! (basta con abrirlo).

**Todo corre en el navegador** (JavaScript, sin servidor): el audio no sale del equipo
del usuario. Por eso se puede publicar gratis en **GitHub Pages**.

## Publicar en GitHub Pages

1. Sube el repositorio a GitHub (la página está en la raíz: `index.html`).
2. En el repositorio: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, elige la rama (por ejemplo `main`) y la carpeta **`/ (root)`**, y guarda.
3. En uno o dos minutos la página queda en `https://<usuario>.github.io/<repositorio>/`.

No hay que compilar nada: son archivos estáticos (módulos ES y trabajadores web). El
archivo `.nojekyll` evita que GitHub Pages procese el sitio con Jekyll.

## Probar en el equipo

Los módulos y trabajadores web no funcionan abriendo `index.html` con doble clic
(`file://`); hace falta un servidor local cualquiera:

```bash
python3 -m http.server 8000      # o: npx serve
# abrir http://localhost:8000
```

Pruebas (Node 20+): `npm test`. Usan canciones sintéticas con ritmo conocido
(`tests/sintetico.js`) y verifican que no haya notas fantasma, que se cubran los golpes
principales, que los patrones duren, que los compases repetidos tengan el mismo ritmo, que
las capas detecten cada instrumento, que los controles de influencia cambien el mapa, que
los holds sean cortos y variados, y que el `.osu`, el recorte, el `.osz` y la lectura de
etiquetas funcionen.

## Arquitectura

```
index.html · estilos.css · js/app.js     interfaz (pasos, línea de tiempo, previsualización)
  ├─ js/audio.js        decodificación (Web Audio), mono a 22 050 Hz, recorte con fundido,
  │                     etiquetas y carátula (ID3 / FLAC), imagen de fondo a JPG
  ├─ js/mp3.js          trabajador: codificación a MP3 con lamejs
  ├─ js/zip.js          paquete .osz (zip sin compresión, con CRC32)
  └─ js/trabajador.js   trabajador con el motor (no congela la página)
      └─ js/motor/analisis.js    BPM y pulsos · onsets y energía · melodía · secciones
          ├─ js/motor/capas.js       separación por instrumento (bombo, caja, platillos, bajo, melodía)
          ├─ js/motor/dsp.js         FFT, filtros (como scipy.ndimage), percentiles
          └─ js/motor/generador.js   selección de eventos → columnas → patrones → holds
              ├─ js/motor/dificultades.js   perfiles Easy/Normal/Hard/Insane para 4K y 7K
              ├─ js/motor/validador.js      jugabilidad + estadísticas
              ├─ js/motor/recorte.js        tramo de la canción
              └─ js/motor/exportador.js     .osu v14
```

El motor (`js/motor/`) no sabe nada del navegador: corre igual en Node (así se prueba).
Es una traducción de la versión anterior en Python (numpy/scipy), comprobada contra ella:
con las mismas señales da el mismo BPM, offset, onsets, capas y secciones.

### Motor de análisis (`js/motor/analisis.js`)

FFT propia y filtros equivalentes a los de scipy, en un trabajador web.

- **Onsets y energía**: flujo espectral sobre 64 bandas mel (ventana de 1024), separado
  en graves (<200 Hz), medios y agudos. Cada banda pesa lo mismo en la envolvente total.
  Desfase calibrado con clics sintéticos: error < 12 ms.
- **BPM y pulsos**: autocorrelación de la envolvente (con énfasis en graves) y un prior
  centrado en 140 BPM (si gana un tempo de menos de 100 BPM y el doble está casi igual de
  marcado, se usa el doble, como en DnB o half-time); luego se afinan BPM y fase buscando la rejilla constante que mejor
  calza con los golpes, y se redondea a BPM entero/.5 cuando corresponde. El tiempo fuerte
  del compás se elige donde más pega el bombo.
- **Melodía**: altura dominante por suma de armónicos (G2–D#6, ventana de 2048) y una
  medida de confianza.
- **Secciones**: matriz de autosimilitud por compás y novedad con kernel de tablero;
  cada sección se etiqueta como *tranquila / media / intensa / clímax* según su energía.
  Las de clímax se exportan como **kiai**.
- **Notas sostenidas**: cuánto dura la energía tonal tras un ataque (para los holds).

### Capas por instrumento (`js/motor/capas.js`)

Sobre un espectrograma mel de 128 bandas se aplica **HPSS** (separación armónico/percusiva
con filtros de mediana): lo que se sostiene en el tiempo es armónico y lo que ocupa muchas
frecuencias a la vez es percusivo. Cada parte se divide por registro:

| Familia | Capa | Rango |
|---|---|---|
| Percusión | bombo | < 150 Hz |
| Percusión | caja | 180 Hz – 4 kHz |
| Percusión | platillos | > 5 kHz |
| Melodía | bajo | < 250 Hz |
| Melodía | melodía / voz | 250 Hz – 5 kHz |

Los ataques de cada capa se miden con una compresión relativa al nivel habitual de cada
banda y se normalizan por familia, para que la fuga débil de un instrumento en la banda de
otro no parezca un golpe. En la canción de prueba (con imprecisión humana, eco y ruido):
bombo 100 % encontrado / 91 % correcto, caja 100 / 81 %, platillos 96 / 100 %, melodía 94 / 93 %.
No es una separación de fuentes perfecta: no distingue una voz de una guitarra en el mismo
registro. La interfaz muestra la actividad de cada capa a lo largo de la canción.

Además de los ataques, cada capa guarda su **presencia** (cuánto suena respecto de lo
habitual en sus bandas, útil para voces largas que atacan poco) y su **energía**, con la
que se mide cuánto dura una nota de ese instrumento. El bajo tiene su propio contorno de
altura (E1–E3), aparte del de la melodía (G2–D#6).

### Instrumento destacado

En cada compás se elige el instrumento que lleva la música: el que más aporta en los
eventos del compás (ya con la influencia que eligió el usuario) y, para el bajo y la voz,
también cuánto suenan sostenidos. Para no saltar de un instrumento a otro, solo cambia si
el nuevo supera al actual en un 25 %. El destacado:

- **pesa más** al elegir qué golpes se vuelven notas (×1,6; el resto ×0,8);
- **decide el patrón**: si lo lleva la voz o el bajo (≥ 70 % melódico), las columnas dibujan
  su contorno de forma relativa (sube → derecha, baja → izquierda; los saltos grandes avanzan
  dos columnas), usando la línea de bajo cuando el bajo lidera; si lo lleva la batería, se
  usan patrones rítmicos;
- **decide los holds**: duran lo que dura la nota de ese instrumento (medido en su capa, no en
  la mezcla) y son más probables cuando ese instrumento es el destacado.

Bombo, caja y bajo comparten registro: una nota real de bajo cambia de altura y la cola de un 808
o el cuerpo de una caja no; con eso se decide a quién atribuir cada golpe grave. En la canción de prueba con
instrumentos que se turnan (`cancionCapas`): el destacado sale bien en las tres partes
(bajo, batería, voz), en 7K las columnas siguen la dirección del bajo en ~90-95 % de los
cambios (en 4K una línea de 5 notas seguidas no cabe en 4 columnas y baja a ~60 %), y las
notas largas de la voz se vuelven holds con el largo correcto.

### Motor de generación híbrida (`js/motor/generador.js`)

1. **Eventos**: los ataques de cada capa se ajustan a la rejilla de la dificultad: 1/1 y 1/2 en
   Easy/Normal, 1/4 o 1/3 (donde hay tresillos) en Hard/Insane. Un golpe que no cae cerca de
   un punto permitido se descarta: **nunca se mueve un golpe ni se ponen notas donde no suena
   nada**.
   Cada evento recuerda la fuerza de cada capa que sonó en ese punto. Un ataque armónico sin
   cambio de altura que llega justo después de un golpe más fuerte se atenúa: suele ser la
   cola tonal del golpe (un 808), no una nota nueva.
2. **Selección por sección**: la saliencia de cada evento combina la percusión (bombo > caja >
   platillos) y la melodía (melodía/voz, bajo, cambio de altura) con los **pesos que elige el
   usuario**. Con la percusión en 0 %, un golpe de platillo solo no genera nota; con la
   melodía en 0 %, tampoco una nota de la voz sin batería. En cada sección se toman los más salientes hasta la
   densidad objetivo, con un umbral común: así todos los compases siguen las mismas capas de
   la música. Después se regulariza: lo que se repite en los compases vecinos entra y lo
   aislado y débil sale. Un piso global evita rellenar partes casi vacías con eco o ruido.
3. **Relleno de huecos**: si la música suena y entre dos eventos queda un espacio mayor al
   máximo de la dificultad (4 pulsos en Easy, 2 en Normal, 1,5 en Hard, 1 en Insane; la mitad
   en el clímax y el doble en partes tranquilas), se rellena en este orden: un **hold** si el
   sonido del evento anterior se sostiene; los golpes reales más fuertes que habían quedado
   fuera; y, si la música está fuerte y aun así no hay golpes, notas en los pulsos. El clímax
   además pide más densidad y acepta golpes más suaves, para que no se pierda.
4. **Frases**: los eventos se agrupan en frases de velocidad parecida (una ráfaga de 1/4 con
   un hueco o un ritmo 3-3-2 siguen siendo la misma frase), de hasta ~16 eventos.
5. **Patrones por frase**: cada frase recibe un patrón completo que dura toda la frase —
   escalera, trino, celda repetida (p. ej. `0213`), jumptrill, brackets (7K), chordjack
   (Insane), manos alternas o contorno melódico— elegido según la velocidad, la dificultad,
   la intensidad y qué capa lleva la frase: si la llevan la melodía o la voz, las notas dibujan
   su contorno; si la lleva la batería, se usan patrones rítmicos. Los patrones de acordes
   (jumptrill, brackets, chordjack) solo aparecen si la percusión tiene peso. Cuando el mismo ritmo vuelve (el coro se repite),
   se repite el mismo patrón, alternando con su espejo, como hacen los mapeadores.
6. **Jugabilidad, acordes y holds**: si una nota del patrón cae en una columna ocupada (jack
   más rápido que el mínimo de la dificultad o hold activo) se mueve a la libre más cercana.
   Los golpes fuertes de bombo y caja en tiempo se vuelven acordes, repartidos entre ambas
   manos y en proporción al peso de la percusión, por lo que caen siempre en los mismos
   lugares del compás.
7. **Holds**: se planifican para toda la canción a la vez. Cada nota que se sostiene (en la
   capa de su instrumento) recibe un puntaje según cuánto dura, si es melódica y si es del
   instrumento destacado; se eligen de mayor a menor con un largo máximo (4 pulsos en Easy,
   3 en Normal, 2 en Hard/Insane), una pausa entre holds, nunca dos eventos seguidos con
   hold y un tope de ~25 % del tiempo cubierto (con el control en 1×). Así los holds caen en
   las notas más largas y no se vuelven monótonos. Se suelta en un punto
   musical: justo cuando empieza otra nota (el gesto típico de un LN) o, si no hay ninguna
   cerca, en el tiempo más fuerte antes de que se apague el sonido. El control de holds va de
   0× (ninguno) a 1× (holds en sonidos sostenidos) y hasta 2,5× (estilo LN: también se
   alargan notas cortas mientras la otra mano sigue tocando).

La interfaz muestra, por mapa, qué patrones se usaron y cuántas notas dura una frase en
promedio. Es determinista: la misma semilla produce el mismo mapa; otra semilla cambia los
patrones manteniendo el ritmo.

| Dificultad | Rejilla | NPS base 4K / 7K | Acorde máx. 4K / 7K | Jack mínimo | OD |
|---|---|---|---|---|---|
| Easy   | 1/2       | 1.6 / 1.8 | 1 / 2 | 450 ms | 5   |
| Normal | 1/2       | 3.0 / 3.4 | 2 / 3 | 280 ms | 6.5 |
| Hard   | 1/4 · 1/3 | 5.2 / 6.0 | 2 / 4 | 170 ms | 7.5 |
| Insane | 1/4 · 1/3 | 7.8 / 9.0 | 3 / 5 | 110 ms | 8.3 |

### Parámetros en la interfaz

- **Audio**: un archivo que el navegador sepa decodificar (MP3, WAV, FLAC, OGG, M4A…).
  Título, artista y carátula se leen de las etiquetas del MP3 (ID3) o FLAC; si no hay, del
  nombre del archivo ("Artista - Tema.mp3").
- **Modos** 4K / 7K y **dificultades** a generar.
- **Influencia de cada instrumento** (0–100 %: bombo, caja, platillos, bajo, melodía/voz; con
  preajustes *Equilibrado*, *Batería*, *Melodía / voz*, *Bajo* y *Todo*). Un instrumento en
  0 % no genera notas, ni siquiera de relleno. La vista de capas muestra arriba qué instrumento
  quedó como destacado en cada tramo.
- **Imagen de fondo** (opcional): si no se sube una, se usa la carátula incrustada en el
  MP3/FLAC. Se guarda como JPG de hasta 1920 px y
  se ve también detrás de la previsualización.
- **Densidad** (0.5×–1.8×) y **holds** (0×–2.5×; sobre 1× es estilo LN).
- **Avanzado**: BPM y offset manuales (útil si el BPM detectado sale a la mitad o al doble)
  y semilla.

**Recorte**: en la línea de tiempo se arrastran el inicio y el fin (o se escriben, en
`m:ss.s`); por defecto se ajustan al inicio de compás más cercano. El mapa se genera sobre la
canción completa (BPM y secciones más estables) y luego se recorta (`js/motor/recorte.js`): el
audio se corta con precisión de muestra con un fundido final opcional y se codifica a MP3, las
notas se desplazan, los holds que pasan el final se acortan, durante el fundido no quedan
notas y el punto de tiempo y el kiai se corren al tramo. El `.osz` lleva solo el audio
recortado. Mínimo 10 s.

**Instrumentos por sección**: cada sección detectada puede usar los pesos globales, un
preajuste (*Batería*, *Melodía / voz*, *Bajo*, *Todo*), *Sin notas* o pesos personalizados.
En el motor: `capasSecciones` = `[{inicio: s, fin: s, capas: {bombo: 0..1, …}}]`; fuera
de esos tramos rigen los globales.

**Interfaz**: un flujo de pasos en orden — 1. Canción (se analiza una vez),
2. Recorte, 3. Instrumentos (toda la canción y, opcionalmente, por sección), 4. Mapas (modos,
dificultades, densidad, holds) y 5. Resultados. Una barra fija abajo tiene siempre el único
botón de acción: *Analizar canción* → *Generar mapas* → *Regenerar*. Si después de generar se
cambia cualquier ajuste, aparece «Cambios sin aplicar» y el botón pasa a *Aplicar cambios y
regenerar*. Tema claro, oscuro o automático con el botón de la barra superior.

**Regenerar sin volver a analizar**: la canción se decodifica y analiza una sola vez; el
análisis queda en el trabajador. Cada *Regenerar* usa ese análisis: se pueden cambiar título,
artista, creador, imagen de fondo y todos los parámetros al instante. Solo si se cambia el BPM
o el offset manual se vuelve a analizar. La vista previa conserva la dificultad que se estaba
mirando.

### Exportador (`js/motor/exportador.js`, `js/zip.js`)

Escribe `.osu` v14 (`Mode: 3`, `CircleSize` = teclas, un punto de tiempo rojo y puntos
heredados para kiai, `PreviewTime` en el primer clímax). Las notas usan
`x = columna·512/K + 256/K`, de modo que osu! las lee en la columna correcta. Si hay
imagen, se declara como fondo en `[Events]`. El `.osz` incluye el audio, el fondo y todas
las dificultades. Un MP3 u OGG sin recortar va tal cual; lo demás (WAV, FLAC, M4A o un tramo
recortado) se codifica a MP3 de 192 kbps con [lamejs](https://github.com/zhuker/lamejs)
(`vendor/`, licencia LGPL). Se descartan las 1105 muestras de retraso del codificador para que
el audio quede alineado con las notas.

## Limitaciones conocidas

- Ya no se puede pegar un enlace de YouTube: una página estática no puede descargar audio
  de YouTube (lo bloquean el navegador y YouTube). Descarga el audio por tu cuenta (solo con
  contenido que tengas derecho a usar) y súbelo.
- Una canción larga ocupa bastante memoria en el navegador (≈ 200 MB por cada 5 minutos);
  en teléfonos viejos puede fallar.
- Supone **tempo constante**: canciones con cambios de BPM o grabaciones en vivo con
  tempo variable quedarán desfasadas en algunas partes (se puede forzar BPM/offset).
- Asume compás de 4/4.
- La estrella mostrada (`≈★`) es una estimación gruesa, no el star rating oficial.
- El análisis se probó con audio sintético en las pruebas; conviene validar y afinar
  los perfiles de dificultad con canciones reales.
