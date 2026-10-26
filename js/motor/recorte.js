// Recorte de la canción: un tramo del audio y del mapa, con fundido al final.
//
// El mapa se genera sobre la canción completa (el BPM y las secciones salen más
// estables) y después se recorta: se quedan las notas del tramo, los holds que
// pasan el final se acortan y todo se desplaza para que el tramo empiece en 0.

import { Analisis } from "./analisis.js";
import { limitar, redondear } from "./dsp.js";
import { Nota } from "./generador.js";

export const DURACION_MINIMA = 10.0; // s
const MARGEN_FINAL = 0.4;            // s sin notas antes de que termine el audio recortado

/** Lleva `t` al inicio de compás más cercano (dentro de la canción). */
export function ajustarACompas(analisis, t) {
  const compas = analisis.periodo * analisis.compas;
  let ajustado = analisis.offset + redondear((t - analisis.offset) / compas) * compas;
  if (ajustado < 0) ajustado += compas;
  return limitar(ajustado, 0, analisis.duracion);
}

export function validarTramo(analisis, inicio, fin) {
  inicio = limitar(inicio, 0, analisis.duracion);
  fin = limitar(fin, 0, analisis.duracion);
  if (fin - inicio < DURACION_MINIMA) {
    throw new Error(`El tramo recortado debe durar al menos ${DURACION_MINIMA.toFixed(0)} s.`);
  }
  return [inicio, fin];
}

/**
 * Notas del tramo [inicio, fin), desplazadas para empezar en 0.
 *
 * Durante el fundido final solo quedan las notas de la primera mitad: así el
 * mapa no termina con notas casi inaudibles.
 */
export function recortarMapa(mapa, inicio, fin, periodo, fundido = 0) {
  const limite = fin - Math.max(MARGEN_FINAL, fundido / 2);
  const minimoHold = 0.5 * mapa.perfil.holdMinPulsos * periodo; // holds que quedan muy cortos pasan a nota
  const notas = [];
  for (const n of mapa.notas) {
    if (!(inicio - 1e-6 <= n.tiempo && n.tiempo < limite)) continue;
    let final = null;
    if (n.fin !== null && n.fin !== undefined) {
      final = Math.min(n.fin, limite);
      if (final - n.tiempo < minimoHold) final = null;
    }
    notas.push(new Nota(n.tiempo - inicio, n.columna, final === null ? null : final - inicio));
  }
  const destacados = mapa.destacados
    .filter(([a, b]) => b > inicio && a < fin)
    .map(([a, b, capa]) => [Math.max(a, inicio) - inicio, Math.min(b, fin) - inicio, capa]);
  return { ...mapa, notas, destacados };
}

/**
 * El análisis visto desde el audio recortado (para exportar el .osu).
 *
 * El offset se corre al primer tiempo fuerte dentro del tramo; las secciones
 * se recortan y desplazan (el kiai queda donde estaba).
 */
export function vistaRecortada(analisis, inicio, fin) {
  const compas = analisis.periodo * analisis.compas;
  let offset = analisis.offset - inicio;
  offset -= Math.floor(offset / compas) * compas; // primer compás que empieza en el tramo
  const secciones = analisis.secciones
    .filter((s) => s.fin > inicio && s.inicio < fin)
    .map((s) => ({ ...s, inicio: Math.max(s.inicio, inicio) - inicio, fin: Math.min(s.fin, fin) - inicio }));
  return new Analisis({ ...analisis, offset, duracion: fin - inicio, secciones });
}
