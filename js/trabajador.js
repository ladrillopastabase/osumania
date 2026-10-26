// Trabajador (módulo) que guarda el análisis de la canción y genera los mapas,
// para que la página no se congele. Mensajes:
//
//   {id, tipo: "analizar", senal, sr, bpm, offsetMs}
//   {id, tipo: "generar", parametros}
//
// Responde {id, tipo: "progreso", fraccion, etapa}, {id, tipo: "listo", resultado}
// o {id, tipo: "error", mensaje}.

import { analizar } from "./motor/analisis.js";
import { exportarOsu, nombreArchivo, nombreVersion } from "./motor/exportador.js";
import { generarMapa, OpcionesGeneracion } from "./motor/generador.js";
import { ajustarACompas, recortarMapa, validarTramo, vistaRecortada } from "./motor/recorte.js";
import { validar } from "./motor/validador.js";

let analisis = null;

const redondear3 = (v) => Math.round(v * 1000) / 1000;

function reproduccion(vista, inicio = 0) {
  return { offset_ms: Math.round(vista.offset * 1000), duracion: redondear3(vista.duracion), inicio: redondear3(inicio) };
}

function hacerAnalisis({ senal, sr, bpm, offsetMs }, avisar) {
  const inicio = performance.now();
  analisis = analizar(senal, {
    sr,
    bpm: bpm ?? null,
    offset: offsetMs !== null && offsetMs !== undefined ? offsetMs / 1000 : null,
    alAvanzar: (fraccion, etapa) => avisar(fraccion, etapa),
  });
  return {
    analisis: analisis.resumen(),
    reproduccion: reproduccion(analisis),
    tiempo_analisis: +((performance.now() - inicio) / 1000).toFixed(2),
  };
}

/** Tramo a recortar [inicio, fin] o null para la canción completa. */
function tramo({ inicio, fin, ajustarCompas }) {
  if (inicio === null && fin === null) return null;
  inicio = inicio || 0;
  fin = fin === null ? analisis.duracion : fin;
  if (ajustarCompas) {
    inicio = inicio > 0.05 ? ajustarACompas(analisis, inicio) : 0;
    if (fin < analisis.duracion - 0.05) fin = ajustarACompas(analisis, fin);
  }
  if (inicio <= 0.05 && fin >= analisis.duracion - 0.05) return null;
  return validarTramo(analisis, inicio, fin);
}

function generar(p, avisar) {
  if (!analisis) throw new Error("Primero hay que analizar la canción.");
  const recorte = p.recorte ? tramo(p.recorte) : null;
  const fundido = Math.min(Math.max(Number(p.fundido) || 0, 0), 8);
  const vista = recorte ? vistaRecortada(analisis, recorte[0], recorte[1]) : analisis;
  const meta = p.meta;
  const mapas = [];
  const archivos = [];
  const total = p.teclas.length * p.dificultades.length;
  for (const teclas of p.teclas) {
    for (const dificultad of p.dificultades) {
      avisar(mapas.length / total, `Generando ${teclas}K ${dificultad}`);
      const opciones = new OpcionesGeneracion({
        teclas, dificultad, percusion: p.percusion, melodia: p.melodia, densidad: p.densidad,
        holds: p.holds, semilla: p.semilla, capas: p.capas, capasSecciones: p.capasSecciones,
      });
      let mapa = generarMapa(analisis, opciones);
      if (recorte) mapa = recortarMapa(mapa, recorte[0], recorte[1], analisis.periodo, fundido);
      const informe = validar(mapa, vista.duracion);
      const version = nombreVersion(mapa);
      const nombre = nombreArchivo(meta, version);
      archivos.push({ nombre, datos: exportarOsu(mapa, vista, meta, p.audio, p.fondo) });
      mapas.push({
        indice: mapas.length,
        teclas,
        dificultad,
        version,
        archivo: nombre,
        validacion: informe,
        notas: mapa.notas.map((n) => [Math.round(n.tiempo * 1000), n.columna, n.fin !== null ? Math.round(n.fin * 1000) : -1]),
        destacados: mapa.destacados.map(([a, b, capa]) => [Math.round(a * 1000), Math.round(b * 1000), capa]),
      });
    }
  }
  return {
    analisis: analisis.resumen(),
    mapas,
    archivos,
    osz: nombreArchivo(meta, "set").slice(0, -" [set].osu".length) + ".osz",
    // Lo que se escucha en la vista previa (el tramo recortado, si lo hay).
    reproduccion: reproduccion(vista, recorte ? recorte[0] : 0),
    recorte: recorte ? { inicio: redondear3(recorte[0]), fin: redondear3(recorte[1]), fundido } : null,
  };
}

self.onmessage = (evento) => {
  const { id, tipo } = evento.data;
  const avisar = (fraccion, etapa) => self.postMessage({ id, tipo: "progreso", fraccion, etapa });
  try {
    const resultado = tipo === "analizar" ? hacerAnalisis(evento.data, avisar) : generar(evento.data.parametros, avisar);
    self.postMessage({ id, tipo: "listo", resultado });
  } catch (error) {
    self.postMessage({ id, tipo: "error", mensaje: String((error && error.message) || error) });
  }
};
