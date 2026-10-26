// Exportador a formato .osu (v14) para importar en osu!.

import { redondear } from "./dsp.js";

export const METADATOS_DEFECTO = {
  titulo: "Sin título",
  artista: "Desconocido",
  creador: "Generador osu!mania",
  fuente: "",
  etiquetas: "generado automatico",
};

function ascii(texto) {
  // eslint-disable-next-line no-control-regex
  const limpio = texto.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").trim();
  return limpio || texto;
}

export const nombreVersion = (mapa) => `${mapa.teclas}K ${mapa.dificultad}`;

export function nombreArchivo(meta, version) {
  const m = { ...METADATOS_DEFECTO, ...meta };
  const nombre = `${ascii(m.artista)} - ${ascii(m.titulo)} (${ascii(m.creador)}) [${version}].osu`;
  return nombre.replace(/[\\/:*?"<>|]/g, "");
}

/** Coordenada x que osu! interpreta como `columna` (floor(x * teclas / 512)). */
export const posicionX = (columna, teclas) => Math.trunc((columna * 512) / teclas + 256 / teclas);

const ms = (segundos) => redondear(segundos * 1000);

function puntosDeTiempo(analisis) {
  const beatMs = 60000 / analisis.bpm;
  const offset = ms(analisis.offset);
  const lineas = [`${offset},${Number(beatMs.toPrecision(12))},${analisis.compas},2,0,40,1,0`];
  for (const s of analisis.secciones) {
    if (!s.kiai) continue;
    const inicio = Math.max(offset, ms(s.inicio));
    const fin = ms(s.fin);
    if (fin - inicio < 1000) continue;
    lineas.push(`${inicio},-100,${analisis.compas},2,0,40,0,1`);
    lineas.push(`${fin},-100,${analisis.compas},2,0,40,0,0`);
  }
  return lineas;
}

function tiempoVistaPrevia(analisis) {
  for (const s of analisis.secciones) if (s.kiai) return ms(s.inicio);
  return ms(analisis.duracion * 0.4);
}

export function exportarOsu(mapa, analisis, meta = {}, audio = "audio.mp3", fondo = null) {
  const m = { ...METADATOS_DEFECTO, ...meta };
  const p = mapa.perfil;
  const lineas = [
    "osu file format v14",
    "",
    "[General]",
    `AudioFilename: ${audio}`,
    "AudioLeadIn: 0",
    `PreviewTime: ${tiempoVistaPrevia(analisis)}`,
    "Countdown: 0",
    "SampleSet: Soft",
    "StackLeniency: 0.7",
    "Mode: 3",
    "LetterboxInBreaks: 0",
    "SpecialStyle: 0",
    "WidescreenStoryboard: 0",
    "",
    "[Editor]",
    "DistanceSpacing: 1",
    `BeatDivisor: ${mapa.divisorEditor}`,
    "GridSize: 4",
    "TimelineZoom: 1",
    "",
    "[Metadata]",
    `Title:${ascii(m.titulo)}`,
    `TitleUnicode:${m.titulo}`,
    `Artist:${ascii(m.artista)}`,
    `ArtistUnicode:${m.artista}`,
    `Creator:${m.creador}`,
    `Version:${nombreVersion(mapa)}`,
    `Source:${m.fuente}`,
    `Tags:${m.etiquetas}`,
    "BeatmapID:0",
    "BeatmapSetID:-1",
    "",
    "[Difficulty]",
    `HPDrainRate:${p.hp}`,
    `CircleSize:${mapa.teclas}`,
    `OverallDifficulty:${p.od}`,
    "ApproachRate:5",
    "SliderMultiplier:1.4",
    "SliderTickRate:1",
    "",
    "[Events]",
    "//Background and Video events",
    ...(fondo ? [`0,0,"${fondo}",0,0`] : []),
    "//Break Periods",
    "//Storyboard Layer 0 (Background)",
    "//Storyboard Layer 1 (Fail)",
    "//Storyboard Layer 2 (Pass)",
    "//Storyboard Layer 3 (Foreground)",
    "//Storyboard Sound Samples",
    "",
    "[TimingPoints]",
    ...puntosDeTiempo(analisis),
    "",
    "",
    "[HitObjects]",
  ];
  const notas = [...mapa.notas].sort((a, b) => a.tiempo - b.tiempo || a.columna - b.columna);
  for (const n of notas) {
    const x = posicionX(n.columna, mapa.teclas);
    if (n.fin !== null && n.fin !== undefined) lineas.push(`${x},192,${ms(n.tiempo)},128,0,${ms(n.fin)}:0:0:0:0:`);
    else lineas.push(`${x},192,${ms(n.tiempo)},1,0,0:0:0:0:`);
  }
  return lineas.join("\r\n") + "\r\n";
}

/** Lee los HitObjects de un .osu de mania: [tiempo_ms, columna, fin_ms | null]. */
export function leerHitobjects(contenido, teclas) {
  const resultado = [];
  let enSeccion = false;
  for (let linea of contenido.split(/\r?\n/)) {
    linea = linea.trim();
    if (linea.startsWith("[")) {
      enSeccion = linea === "[HitObjects]";
      continue;
    }
    if (!enSeccion || !linea) continue;
    const partes = linea.split(",");
    const x = parseInt(partes[0], 10), tiempo = parseInt(partes[2], 10), tipo = parseInt(partes[3], 10);
    const columna = Math.min(teclas - 1, Math.floor((x * teclas) / 512));
    const fin = tipo & 128 ? parseInt(partes[5].split(":")[0], 10) : null;
    resultado.push([tiempo, columna, fin]);
  }
  return resultado;
}
