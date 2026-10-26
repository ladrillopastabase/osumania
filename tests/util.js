// Ayudas compartidas por las pruebas.

import { analizar } from "../js/motor/analisis.js";

export const distanciaMinima = (lista, t) => lista.reduce((m, v) => Math.min(m, Math.abs(v - t)), Infinity);
export const promedio = (lista) => lista.reduce((s, v) => s + Number(v), 0) / lista.length;
export const esHold = (n) => n.fin !== null;

const memoria = new Map();
/** Análisis memorizado: varias pruebas usan la misma canción. */
export function analisisDe(clave, crear) {
  if (!memoria.has(clave)) {
    const { senal, ...resto } = crear();
    memoria.set(clave, { analisis: analizar(senal), ...resto });
  }
  return memoria.get(clave);
}

/** Hueco más largo sin notas (ni holds) entre `desde` y `hasta`. */
export function huecoMaximo(mapa, desde, hasta) {
  const ocupado = mapa.notas.filter((n) => n.tiempo >= desde && n.tiempo < hasta)
    .map((n) => [n.tiempo, n.fin ?? n.tiempo]).sort((a, b) => a[0] - b[0]);
  let ultimo = desde, maximo = 0;
  for (const [inicio, fin] of ocupado) {
    maximo = Math.max(maximo, inicio - ultimo);
    ultimo = Math.max(ultimo, fin);
  }
  return Math.max(maximo, hasta - ultimo);
}
