# Generador automático de beatmaps para osu!mania

Aplicación web que recibe una canción (MP3 / WAV / FLAC / OGG), la analiza y genera
beatmaps de **4K y 7K** en cuatro dificultades (**Easy · Normal · Hard · Insane**),
con patrones híbridos basados en ritmo, melodía y jugabilidad. Los mapas se
previsualizan en el navegador y se descargan como `.osu` sueltos o como un `.osz`
listo para importar en osu! (basta con abrirlo).

## Puesta en marcha

Requisitos: Python 3.11+ y `ffmpeg` en el PATH (para MP3/FLAC/OGG y para convertir
el audio a MP3 dentro del `.osz`; sin ffmpeg solo se admite WAV).

```bash
pip install -r requirements.txt
python app.py            # http://localhost:5000
```

También hay una línea de comandos:

```bash
python -m motor.cli "Artista - Tema.mp3" --teclas 4 7 --dificultades Hard Insane \
    --estilo hibrido --artista "Artista" --salida salida/
```

Pruebas: `python -m pytest -q`.

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

1. **Rejilla**: cada pulso se divide en 1/2 (Easy, Normal) o 1/4 (Hard, Insane); en
   Hard/Insane se usa 1/3 donde los onsets calzan mejor con tresillos.
2. **Selección de eventos**: cada punto se puntúa con golpe + cambio melódico + peso
   métrico (tiempo fuerte > pulso > medio pulso). Por compás se toman tantos eventos como
   pida la densidad objetivo, que depende de la dificultad, la intensidad local y la
   sección; se respeta una separación mínima.
3. **Asignación de columnas**: cada evento sortea una posición preferida entre tres
   fuentes —contorno melódico, motivo rítmico activo (escaleras en ráfagas, trinos en
   notas repetidas, alternancia de manos en corcheas) y banda dominante (graves a la
   izquierda, agudos a la derecha)— y elige la columna o el acorde de menor costo. El costo
   penaliza jacks más rápidos que el mínimo de la dificultad, anclas, holds activos,
   desequilibrio entre manos y columnas sobreusadas.
4. **Acordes y holds**: los golpes fuertes en tiempos (sobre todo con bombo y en el
   clímax) pueden volverse acordes hasta el máximo de la dificultad; las notas sostenidas
   se alargan hasta la rejilla, con un límite de holds simultáneos.

Es determinista: la misma semilla produce el mismo mapa; otra semilla cambia los
patrones manteniendo el ritmo.

| Dificultad | Rejilla | NPS base 4K / 7K | Acorde máx. 4K / 7K | Jack mínimo | OD |
|---|---|---|---|---|---|
| Easy   | 1/2       | 1.6 / 1.8 | 1 / 2 | 450 ms | 5   |
| Normal | 1/2       | 3.0 / 3.4 | 2 / 3 | 280 ms | 6.5 |
| Hard   | 1/4 · 1/3 | 5.2 / 6.0 | 2 / 4 | 170 ms | 7.5 |
| Insane | 1/4 · 1/3 | 7.8 / 9.0 | 3 / 5 | 110 ms | 8.3 |

### Parámetros en la interfaz

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

- Supone **tempo constante**: canciones con cambios de BPM o grabaciones en vivo con
  tempo variable quedarán desfasadas en algunas partes (se puede forzar BPM/offset).
- Asume compás de 4/4.
- La estrella mostrada (`≈★`) es una estimación gruesa, no el star rating oficial.
- El análisis se probó con audio sintético en las pruebas; conviene validar y afinar
  los perfiles de dificultad con canciones reales.
