# Generador automático de beatmaps para osu!mania

Aplicación web que recibe una canción (MP3 / WAV / FLAC / OGG, o un enlace de YouTube), la analiza y genera
beatmaps de **4K y 7K** en cuatro dificultades (**Easy · Normal · Hard · Insane**),
con patrones híbridos basados en ritmo, melodía y jugabilidad. Los mapas se
previsualizan en el navegador y se descargan como `.osu` sueltos o como un `.osz`
listo para importar en osu! (basta con abrirlo).

## Puesta en marcha

Requisitos: Python 3.11+ y `ffmpeg` en el PATH (para MP3/FLAC/OGG, para enlaces de
YouTube y para convertir el audio a MP3 dentro del `.osz`; sin ffmpeg solo se admite WAV).

```bash
pip install -r requirements.txt
python app.py            # http://localhost:5000
```

También hay una línea de comandos:

```bash
python -m motor.cli "Artista - Tema.mp3" --teclas 4 7 --dificultades Hard Insane \
    --capas bombo=1 caja=0.9 platillos=0.3 bajo=0.8 melodia=1 --imagen fondo.jpg \
    --artista "Artista" --salida salida/
```

Pruebas: `python -m pytest -q`. Incluyen una canción sintética con ritmo conocido
(`tests/sintetico.py`) que verifica que no haya notas fantasma, que se cubran los golpes
principales, que los patrones duren, que los compases repetidos tengan el mismo ritmo, que
las capas detecten cada instrumento y que los controles de percusión/melodía cambien el mapa.

## Arquitectura

```
Audio (MP3/WAV/FLAC)
  └─ motor/audio.py        decodificación con ffmpeg, mono a 22 050 Hz
      └─ motor/analisis.py   BPM y pulsos · onsets y energía · melodía · secciones
          ├─ motor/capas.py      separación por instrumento (bombo, caja, platillos, bajo, melodía)
          └─ motor/generador.py   selección de eventos → columnas → patrones → holds
              ├─ motor/dificultades.py   perfiles Easy/Normal/Hard/Insane para 4K y 7K
              ├─ motor/validador.py      jugabilidad + estadísticas
              ├─ motor/exportador.py     .osu v14 y paquete .osz
              └─ motor/imagen.py         fondo: imagen subida, miniatura de YouTube o portada
app.py + static/            interfaz web (subida, parámetros, previsualización, descargas)
```

Los tres componentes son independientes: la interfaz solo llama al motor, y el motor
no sabe nada de la web (la CLI usa exactamente las mismas funciones).

### Motor de análisis (`motor/analisis.py`)

Todo con numpy/scipy, procesando el espectrograma por bloques.

- **Onsets y energía**: flujo espectral sobre 64 bandas mel (ventana de 1024), separado
  en graves (<200 Hz), medios y agudos. Cada banda pesa lo mismo en la envolvente total.
  Desfase calibrado con clics sintéticos: error < 12 ms.
- **BPM y pulsos**: autocorrelación de la envolvente (con énfasis en graves) y un prior
  centrado en 140 BPM; luego se afinan BPM y fase buscando la rejilla constante que mejor
  calza con los golpes, y se redondea a BPM entero/.5 cuando corresponde. El tiempo fuerte
  del compás se elige donde más pega el bombo.
- **Melodía**: altura dominante por suma de armónicos (G2–D#6, ventana de 2048) y una
  medida de confianza.
- **Secciones**: matriz de autosimilitud por compás y novedad con kernel de tablero;
  cada sección se etiqueta como *tranquila / media / intensa / clímax* según su energía.
  Las de clímax se exportan como **kiai**.
- **Notas sostenidas**: cuánto dura la energía tonal tras un ataque (para los holds).

### Capas por instrumento (`motor/capas.py`)

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

Bombo y bajo comparten registro: una nota real de bajo cambia de altura y la cola de un 808
no; con eso se decide a quién atribuir cada golpe grave. En la canción de prueba con
instrumentos que se turnan (`cancion_capas`): el destacado sale bien en las tres partes
(bajo, batería, voz), en 7K las columnas siguen la dirección del bajo en ~90-95 % de los
cambios (en 4K una línea de 5 notas seguidas no cabe en 4 columnas y baja a ~60 %), y las
notas largas de la voz se vuelven holds con el largo correcto.

### Motor de generación híbrida (`motor/generador.py`)

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
7. **Holds**: una nota se vuelve hold cuando su sonido se sostiene (voz o sintetizador
   largo), con más probabilidad si es melódica o si después hay aire. Se suelta en un punto
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

- **Audio**: un archivo o un enlace de YouTube (`youtube.com`, `youtu.be`, `music.youtube.com`).
  El audio se extrae con [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`motor/youtube.py`),
  solo del video indicado (no listas), hasta 15 minutos y sin transmisiones en vivo. Título y
  artista se toman del video ("Artista - Tema") si no se escriben a mano. Si YouTube cambia
  y la descarga falla, actualiza yt-dlp: `pip install -U yt-dlp`.
- **Modos** 4K / 7K y **dificultades** a generar.
- **Influencia de cada instrumento** (0–100 %: bombo, caja, platillos, bajo, melodía/voz; con
  preajustes *Equilibrado*, *Batería*, *Melodía / voz*, *Bajo* y *Todo*). Un instrumento en
  0 % no genera notas, ni siquiera de relleno. La vista de capas muestra arriba qué instrumento
  quedó como destacado en cada tramo.
- **Imagen de fondo** (opcional): si no se sube una, se usa la miniatura del video de
  YouTube o la carátula incrustada en el MP3/FLAC. Se guarda como JPG de hasta 1920 px y
  se ve también detrás de la previsualización.
- **Densidad** (0.5×–1.8×) y **holds** (0×–2.5×; sobre 1× es estilo LN).
- **Avanzado**: BPM y offset manuales (útil si el BPM detectado sale a la mitad o al doble)
  y semilla.

**Regenerar sin volver a descargar**: la primera vez la canción se sube o descarga y se
analiza (`POST /api/trabajos`). Después, el formulario muestra la canción cargada y cada
*Regenerar* (`POST /api/trabajos/<id>/generar`) usa el análisis guardado: se pueden cambiar
título, artista, creador, imagen de fondo y todos los parámetros sin descargar ni analizar de
nuevo. Solo si se cambia el BPM o el offset manual se vuelve a analizar el audio ya guardado.
La vista previa conserva la dificultad y la posición que se estaban mirando.

### Exportador (`motor/exportador.py`)

Escribe `.osu` v14 (`Mode: 3`, `CircleSize` = teclas, un punto de tiempo rojo y puntos
heredados para kiai, `PreviewTime` en el primer clímax). Las notas usan
`x = columna·512/K + 256/K`, de modo que osu! las lee en la columna correcta. Si hay
imagen, se declara como fondo en `[Events]`. El `.osz` incluye el audio (WAV/FLAC se
convierten a MP3), el fondo y todas las dificultades.

## Limitaciones conocidas

- Usa la descarga desde YouTube solo con contenido que tengas derecho a usar.

- Supone **tempo constante**: canciones con cambios de BPM o grabaciones en vivo con
  tempo variable quedarán desfasadas en algunas partes (se puede forzar BPM/offset).
- Asume compás de 4/4.
- La estrella mostrada (`≈★`) es una estimación gruesa, no el star rating oficial.
- El análisis se probó con audio sintético en las pruebas; conviene validar y afinar
  los perfiles de dificultad con canciones reales.
