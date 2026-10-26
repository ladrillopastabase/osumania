// Separación de la música en capas por instrumento.
//
// Se usa HPSS (separación armónico/percusiva por filtros de mediana) sobre un
// espectrograma mel de 128 bandas: lo que se sostiene en el tiempo es armónico;
// lo que ocupa muchas frecuencias a la vez es percusivo. Cada parte se divide
// por registro:
//
//   percusión: bombo (<150 Hz) · caja (180 Hz–4 kHz) · platillos (>5 kHz)
//   melodía:   bajo (<250 Hz) · melodía/voz (250 Hz–5 kHz)
//
// No es una separación de fuentes perfecta (no distingue una voz de una
// guitarra en el mismo registro), pero alcanza para saber qué golpe viene de
// qué capa y dejar que el usuario elija cuánto pesa cada una.

import { filtroUniforme, limitar, medianaEnColumnas, medianaEnTiempo, percentil } from "./dsp.js";

export const N_MEL_FINO = 128;

// nombre, familia, parte (p = percusiva, h = armónica), fmin, fmax
export const DEFINICION = [
  ["bombo", "percusion", "p", 0, 150],
  ["caja", "percusion", "p", 180, 4000],
  ["platillos", "percusion", "p", 5000, 1e9],
  ["bajo", "melodia", "h", 0, 250],
  ["melodia", "melodia", "h", 250, 5000],
];
export const NOMBRES = DEFINICION.map((d) => d[0]);
export const PERCUSION = DEFINICION.filter((d) => d[1] === "percusion").map((d) => d[0]);
export const MELODIA = DEFINICION.filter((d) => d[1] === "melodia").map((d) => d[0]);

/** Devuelve [armónica, percusiva] con máscaras suaves de Wiener. */
export function hpss(potencia, frames, bandas, hopS, bandasFreq = 9) {
  const largoT = Math.max(3, Math.trunc(0.25 / hopS) | 1);
  const armonica = medianaEnTiempo(potencia, frames, bandas, largoT, "nearest");
  const percusiva = medianaEnColumnas(potencia, frames, bandas, bandasFreq, "nearest");
  for (let i = 0; i < potencia.length; i++) {
    const a2 = armonica[i] * armonica[i];
    const p2 = percusiva[i] * percusiva[i];
    const total = a2 + p2 + 1e-20;
    armonica[i] = potencia[i] * (a2 / total);
    percusiva[i] = potencia[i] * (p2 / total);
  }
  return [armonica, percusiva];
}

/**
 * `melFino`: potencia mel (frames × 128, fila por frame). Devuelve {nombre: capa}.
 * `detectarOnsets(env, hopS, delta)` viene del análisis.
 */
export function separar(melFino, frames, centros, hopS, detectarOnsets) {
  const B = N_MEL_FINO;
  const [armonica, percusiva] = hpss(melFino, frames, B, hopS);
  // La referencia de cada banda sale de la mezcla completa: así la fuga de una
  // parte en la otra queda en su nivel real (débil) y no se amplifica.
  const referencia = new Float64Array(B);
  const columna = new Float64Array(frames);
  for (let b = 0; b < B; b++) {
    for (let f = 0; f < frames; f++) columna[f] = melFino[f * B + b];
    referencia[b] = percentil(columna, 99) + 1e-12;
  }
  const comprimir = (fuente, f, b) => Math.log1p((100 * fuente[f * B + b]) / referencia[b]);
  const log100 = Math.log1p(100);

  const datos = {};
  for (const [nombre, familia, parte, fmin, fmax] of DEFINICION) {
    const bandas = [];
    for (let b = 0; b < B; b++) if (centros[b] >= fmin && centros[b] < fmax) bandas.push(b);
    if (!bandas.length) continue;
    const fuente = parte === "p" ? percusiva : armonica;
    // Flujo sobre la compresión log1p relativa al nivel fuerte de cada banda: a
    // diferencia de los dB, un sonido 30 dB bajo lo habitual casi no genera ataques.
    const cruda = new Float64Array(frames);
    const energia = new Float64Array(frames);
    const presencia = new Float64Array(frames);
    const previo = new Float64Array(bandas.length);
    const actual = new Float64Array(bandas.length);
    const cuantas = Math.max(1, Math.floor(bandas.length / 4));
    for (let f = 0; f < frames; f++) {
      let flujo = 0, suma = 0;
      for (let j = 0; j < bandas.length; j++) {
        const b = bandas[j];
        actual[j] = comprimir(fuente, f, b);
        if (f > 0) flujo += Math.max(0, actual[j] - previo[j]);
        suma += fuente[f * B + b];
      }
      cruda[f] = flujo / bandas.length;
      energia[f] = 10 * Math.log10(suma + 1e-10);
      // Presencia: el cuarto de bandas más fuerte (una voz ocupa pocas bandas a la vez).
      const orden = Float64Array.from(actual).sort();
      let fuerte = 0;
      for (let j = bandas.length - cuantas; j < bandas.length; j++) fuerte += orden[j];
      presencia[f] = fuerte / cuantas / log100;
      previo.set(actual);
    }
    datos[nombre] = { familia, cruda, energia, presencia };
  }

  // Normalización común por familia: las capas quedan comparables entre sí.
  const escala = {};
  for (const familia of ["percusion", "melodia"]) {
    const miembros = Object.values(datos).filter((d) => d.familia === familia);
    const maximo = new Float64Array(frames);
    for (const d of miembros) for (let f = 0; f < frames; f++) maximo[f] = Math.max(maximo[f], d.cruda[f]);
    escala[familia] = percentil(maximo, 99.5) + 1e-9;
  }

  const capas = {};
  for (const [nombre, familia] of DEFINICION) {
    const d = datos[nombre];
    if (!d) continue;
    const env = new Float32Array(frames);
    for (let f = 0; f < frames; f++) env[f] = limitar(d.cruda[f] / escala[familia], 0, 1.5);
    const energiaDb = Float32Array.from(filtroUniforme(d.energia, 5));
    const presencia = Float32Array.from(
      filtroUniforme(d.presencia, Math.max(3, Math.trunc(0.5 / hopS))), (v) => limitar(v, 0, 1));
    const [onsets, fuerzas] = detectarOnsets(env, hopS, 0.08);
    // Actividad: fuerza de los ataques por segundo (lo que importa para mapear).
    const golpes = new Float64Array(frames);
    for (let i = 0; i < onsets.length; i++) {
      const f = limitar(Math.round(onsets[i] / hopS), 0, frames - 1);
      golpes[f] += fuerzas[i];
    }
    const actividad = filtroUniforme(golpes, Math.max(3, Math.trunc(1.0 / hopS))).map((v) => v / hopS);
    capas[nombre] = { nombre, familia, env, actividad, onsets, fuerzas, presencia, energiaDb };
  }
  // Actividad normalizada por familia, para comparar capas entre sí.
  for (const familia of ["percusion", "melodia"]) {
    const miembros = Object.values(capas).filter((c) => c.familia === familia);
    if (!miembros.length) continue;
    const maximo = new Float64Array(frames);
    for (const c of miembros) for (let f = 0; f < frames; f++) maximo[f] = Math.max(maximo[f], c.actividad[f]);
    const tope = percentil(maximo, 98) + 1e-9;
    for (const c of miembros) c.actividad = Float32Array.from(c.actividad, (v) => limitar(v / tope, 0, 1));
  }
  return capas;
}
