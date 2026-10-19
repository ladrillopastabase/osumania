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
    --estilo hibrido --artista "Artista" --salida salida/
```

Pruebas: `python -m pytest -q`. Incluyen una canción sintética con ritmo conocido
(`tests/sintetico.py`) que verifica que no haya notas fantasma, que se cubran los golpes
principales, que los patrones duren y que los compases repetidos tengan el mismo ritmo.

## Arquitectura

```
Audio (MP3/WAV/FLAC)
  └─ motor/audio.py        decodificación con ffmpeg, mono a 22 050 Hz
      └─ motor/analisis.py   BPM y pulsos · onsets y energía · melodía · secciones
          └─ motor/generador.py   selección de eventos → columnas → patrones → holds
              ├─ motor/dificultades.py   perfiles Easy/Normal/Hard/Insane para 4K y 7K
              ├─ motor/validador.py      jugabilidad + estadísticas
              └─ motor/exportador.py     .osu v14 y paquete .osz
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

### Motor de generación híbrida (`motor/generador.py`)

1. **Eventos**: los onsets (detectados en la envolvente total y en cada banda, para no perder
   platillos tapados por el bombo) se ajustan a la rejilla de la dificultad: 1/1 y 1/2 en
   Easy/Normal, 1/4 o 1/3 (donde hay tresillos) en Hard/Insane. Un golpe que no cae cerca de
   un punto permitido se descarta: **nunca se mueve un golpe ni se ponen notas donde no suena
   nada**.
2. **Selección por sección**: cada evento tiene una saliencia según qué suena (bombo, caja,
   platillos, cambio de melodía). En cada sección se toman los más salientes hasta la
   densidad objetivo, con un umbral común: así todos los compases siguen las mismas capas de
   la música. Después se regulariza: lo que se repite en los compases vecinos entra y lo
   aislado y débil sale. Un piso global evita rellenar partes casi vacías con eco o ruido.
3. **Frases**: los eventos se agrupan en frases de velocidad parecida (una ráfaga de 1/4 con
   un hueco o un ritmo 3-3-2 siguen siendo la misma frase), de hasta ~16 eventos.
4. **Patrones por frase**: cada frase recibe un patrón completo que dura toda la frase —
   escalera, trino, celda repetida (p. ej. `0213`), jumptrill, brackets (7K), chordjack
   (Insane), manos alternas o contorno melódico— elegido según la velocidad, la dificultad,
   la intensidad y si la melodía se mueve. Cuando el mismo ritmo vuelve (el coro se repite),
   se repite el mismo patrón, alternando con su espejo, como hacen los mapeadores.
5. **Jugabilidad, acordes y holds**: si una nota del patrón cae en una columna ocupada (jack
   más rápido que el mínimo de la dificultad o hold activo) se mueve a la libre más cercana.
   Los golpes fuertes en tiempo (bombo, caja) se vuelven acordes, repartidos entre ambas
   manos, por lo que caen siempre en los mismos lugares del compás. Las notas sostenidas se
   vuelven holds al final de las frases o en pasajes lentos.

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
- **Estilo**: híbrido (por defecto), rítmico (sigue la percusión) o melódico (sigue la melodía).
- **Densidad** (0.5×–1.8×) y **cantidad de holds** (0×–2.5×).
- **Avanzado**: BPM y offset manuales (útil si el BPM detectado sale a la mitad o al doble)
  y semilla.

### Exportador (`motor/exportador.py`)

Escribe `.osu` v14 (`Mode: 3`, `CircleSize` = teclas, un punto de tiempo rojo y puntos
heredados para kiai, `PreviewTime` en el primer clímax). Las notas usan
`x = columna·512/K + 256/K`, de modo que osu! las lee en la columna correcta. El `.osz`
incluye el audio (WAV/FLAC se convierten a MP3) y todas las dificultades.

## Limitaciones conocidas

- Usa la descarga desde YouTube solo con contenido que tengas derecho a usar.

- Supone **tempo constante**: canciones con cambios de BPM o grabaciones en vivo con
  tempo variable quedarán desfasadas en algunas partes (se puede forzar BPM/offset).
- Asume compás de 4/4.
- La estrella mostrada (`≈★`) es una estimación gruesa, no el star rating oficial.
- El análisis se probó con audio sintético en las pruebas; conviene validar y afinar
  los perfiles de dificultad con canciones reales.
