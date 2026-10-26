// Canciones sintéticas para las pruebas (con ritmo y notas conocidos).

import { Azar } from "../js/motor/azar.js";

export const SR = 22050;

function normal(azar) {
  // Box-Muller
  const u = 1 - azar.random(), v = azar.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function desvanecer(x) {
  const cola = Math.min(x.length, 64);
  for (let i = 0; i < cola; i++) x[x.length - cola + i] *= cola > 1 ? 1 - i / (cola - 1) : 0;
  return x;
}

const muestras = (dur, sr) => Math.trunc(sr * dur);

export function bombo(sr = SR, dur = 0.2) {
  const n = muestras(dur, sr);
  const x = new Float64Array(n);
  let fase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    fase += (60 + 90 * Math.exp(-t * 40)) / sr;
    x[i] = Math.sin(2 * Math.PI * fase) * Math.exp(-t * 25);
  }
  return desvanecer(x);
}

export function platillo(sr = SR, dur = 0.05, semilla = 0) {
  const azar = new Azar(semilla + 100);
  const n = muestras(dur, sr);
  const x = new Float64Array(n);
  let previo = 0;
  for (let i = 0; i < n; i++) {
    const r = normal(azar);
    x[i] = 0.25 * (r - previo) * Math.exp(-(i / sr) * 80); // derivada: brillo
    previo = r;
  }
  return desvanecer(x);
}

export function caja(sr = SR, dur = 0.15, semilla = 2) {
  const azar = new Azar(semilla + 200);
  const n = muestras(dur, sr);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = 0.5 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) + 0.45 * normal(azar) * Math.exp(-t * 22);
  }
  return desvanecer(x);
}

const frecuencia = (midi) => 440 * 2 ** ((midi - 69) / 12);

export function tono(midi, dur, sr = SR) {
  const n = muestras(dur, sr);
  const x = new Float64Array(n);
  const f = frecuencia(midi);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let onda = 0;
    for (let h = 0; h < 4; h++) onda += 0.6 ** h * Math.sin(2 * Math.PI * f * (h + 1) * t);
    x[i] = 0.35 * onda * Math.min(1, t / 0.01) * Math.exp(-t * 1.2);
  }
  return desvanecer(x);
}

export function pad(midis, dur, sr = SR) {
  const n = muestras(dur, sr);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let onda = 0;
    for (const m of midis) onda += Math.sin(2 * Math.PI * frecuencia(m) * t);
    x[i] = 0.08 * onda * Math.min(1, t / 0.4) * Math.min(1, (dur - t) / 0.3);
  }
  return desvanecer(x);
}

export function bajo(midi, dur, sr = SR) {
  const n = muestras(dur, sr);
  const x = new Float64Array(n);
  const f = frecuencia(midi);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const onda = Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t);
    x[i] = 0.6 * onda * Math.min(1, t / 0.005) * Math.exp(-t * 2.0);
  }
  return desvanecer(x);
}

/** Nota cantada: ataque suave, se sostiene toda la duración, con vibrato. */
export function voz(midi, dur, sr = SR) {
  const n = muestras(dur, sr);
  const x = new Float64Array(n);
  let fase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    fase += (2 * Math.PI * frecuencia(midi) * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t))) / sr;
    let onda = 0;
    for (let h = 0; h < 5; h++) onda += 0.7 ** h * Math.sin(fase * (h + 1));
    x[i] = 0.3 * onda * Math.min(1, t / 0.03) * Math.min(1, (dur - t) / 0.05);
  }
  return desvanecer(x);
}

function poner(senal, t, sonido, ganancia, sr = SR) {
  const a = Math.trunc(t * sr);
  for (let i = 0; i < sonido.length && a + i < senal.length; i++) if (a + i >= 0) senal[a + i] += ganancia * sonido[i];
}

function normalizar(senal) {
  let pico = 0;
  for (const v of senal) pico = Math.max(pico, Math.abs(v));
  return Float32Array.from(senal, (v) => v / pico);
}

/**
 * Bombo en cada tiempo, platillo en contratiempos y una melodía en corcheas.
 * La segunda mitad tiene más energía (doble platillo) para simular un estribillo.
 */
export function cancion(bpm = 150, segundos = 40, offset = 0.5, sr = SR, melodia = true, semilla = 1) {
  const azar = new Azar(semilla);
  const n = Math.trunc(segundos * sr);
  const senal = new Float64Array(n + sr);
  const periodo = 60 / bpm;
  const k = bombo(sr), p = platillo(sr);
  const escala = [60, 62, 64, 65, 67, 69, 71, 72];
  for (let t = offset, i = 0; t < segundos; t += periodo, i++) {
    poner(senal, t, k, i % 4 === 0 ? 1.0 : 0.8, sr);
    poner(senal, t + periodo / 2, p, 1, sr);
    if (t > segundos / 2) poner(senal, t + periodo / 4, p, 0.7, sr);
    if (melodia && i % 2 === 0) poner(senal, t, tono(escala[azar.entero(escala.length)], periodo * 2, sr), 1, sr);
  }
  return normalizar(senal.subarray(0, n));
}

export function clics(tiempos, segundos, sr = SR) {
  const senal = new Float64Array(Math.trunc(segundos * sr));
  const k = bombo(sr);
  for (const t of tiempos) poner(senal, t, k, 1, sr);
  return Float32Array.from(senal);
}

const CORO = ["coro", 8, [0, 3, 8, 11], [4, 12], [...Array(16).keys()],
  [[0, 7, 2], [2, 5, 2], [4, 4, 2], [6, 2, 2], [8, 0, 1], [9, 2, 1], [10, 4, 1], [11, 5, 1],
    [12, 7, 1], [13, 9, 1], [14, 11, 1], [15, 12, 1]]];
// nombre, compases, bombo, caja, platillo, melodía [paso, nota relativa, duración en pasos]
// (patrones de 16 semicorcheas por compás)
const SECCIONES = [
  ["intro", 4, [], [], [0, 4, 8, 12], []],
  ["verso", 8, [0, 7, 10], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14],
    [[0, 0, 3], [3, 2, 3], [6, 4, 2], [8, 5, 4], [12, 4, 2], [14, 2, 2]]],
  CORO,
  ["puente", 4, [0], [], [], [[0, 0, 8], [8, 4, 8]]],
  CORO,
];

// Coro "sostenido": bombo en negras, melodía en notas largas y casi sin platillos.
export const SECCIONES_SOSTENIDAS = [
  ["intro", 4, [], [], [0, 8], []],
  ["verso", 8, [0, 7, 10], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14],
    [[0, 0, 3], [3, 2, 3], [6, 4, 2], [8, 5, 4], [12, 4, 2], [14, 2, 2]]],
  ["coro", 8, [0, 4, 8, 12], [], [], [[0, 12, 8], [8, 11, 4], [12, 9, 4]]],
  ["verso", 4, [0, 7, 10], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14], [[0, 0, 3], [3, 2, 3], [6, 4, 2]]],
];

/** Devuelve {senal, eventos}; `eventos`: [tiempo, instrumento, sección, paso] ordenados. */
export function cancionRealista({ bpm = 170, offset = 0.6, sr = SR, secciones = SECCIONES } = {}) {
  const paso = 60 / bpm / 4;
  const compases = secciones.reduce((s, x) => s + x[1], 0);
  const senal = new Float64Array(Math.trunc((offset + compases * 16 * paso + 1.0) * sr));
  const eventos = [];
  const k = bombo(sr), s = caja(sr), p = platillo(sr);
  let tCompas = offset;
  for (const [nombre, cantidad, bombos, cajas, platillos, melodia] of secciones) {
    const fuerte = nombre === "coro" ? 1.0 : 0.75;
    for (let c = 0; c < cantidad; c++) {
      poner(senal, tCompas, pad([48, 55, 64], 16 * paso, sr), 1, sr);
      for (let i = 0; i < 16; i++) {
        const t = tCompas + i * paso;
        if (bombos.includes(i)) { poner(senal, t, k, fuerte, sr); eventos.push([t, "bombo", nombre, i]); }
        if (cajas.includes(i)) { poner(senal, t, s, fuerte * 0.8, sr); eventos.push([t, "caja", nombre, i]); }
        if (platillos.includes(i)) { poner(senal, t, p, 0.5, sr); eventos.push([t, "platillo", nombre, i]); }
      }
      for (const [i, nota, duracion] of melodia) {
        const t = tCompas + i * paso;
        poner(senal, t, tono(67 + nota, duracion * paso * 1.6, sr), 0.9, sr);
        eventos.push([t, "melodia", nombre, i]);
      }
      tCompas += 16 * paso;
    }
  }
  eventos.sort((a, b) => a[0] - b[0]);
  return { senal: normalizar(senal), eventos };
}

/**
 * Tres partes de 8 compases: solo de bajo, batería fuerte y voz con notas largas.
 * Devuelve {senal, eventos, partes}; partes = {nombre: [inicio, fin]}; los eventos
 * son [tiempo, instrumento, dato] (la nota del bajo, la duración de la voz).
 */
export function cancionCapas(bpm = 150, offset = 0.5, sr = SR) {
  const paso = 60 / bpm / 4;
  const compas = 16 * paso;
  const senal = new Float64Array(Math.trunc((offset + 24 * compas + 1.0) * sr));
  const eventos = [];
  const k = bombo(sr), s = caja(sr), p = platillo(sr);
  const lineaBajo = [[0, 36, 2], [2, 38, 2], [4, 40, 2], [6, 43, 2], [8, 45, 2], [10, 43, 2], [12, 40, 2], [14, 38, 2]];
  const vozLarga = [[0, 72, 8], [8, 74, 4], [12, 76, 4]];
  const partes = {};
  for (const [parte, desde] of [["bajo", 0], ["bateria", 8], ["voz", 16]]) {
    partes[parte] = [offset + desde * compas, offset + (desde + 8) * compas];
    for (let c = desde; c < desde + 8; c++) {
      const t0 = offset + c * compas;
      for (let i = 0; i < 16; i++) {
        const t = t0 + i * paso;
        if (parte === "bajo") {
          if (i % 8 === 0) { poner(senal, t, k, 0.35, sr); eventos.push([t, "bombo", 0]); }
        } else if (parte === "bateria") {
          if ([0, 3, 8, 11].includes(i)) { poner(senal, t, k, 1.0, sr); eventos.push([t, "bombo", 0]); }
          if ([4, 12].includes(i)) { poner(senal, t, s, 0.9, sr); eventos.push([t, "caja", 0]); }
          poner(senal, t, p, 0.6, sr);
          eventos.push([t, "platillo", 0]);
        } else if (i % 4 === 0) {
          poner(senal, t, k, 0.4, sr);
          eventos.push([t, "bombo", 0]);
        }
      }
      if (parte === "bajo") {
        for (const [i, nota, dur] of lineaBajo) {
          poner(senal, t0 + i * paso, bajo(nota, dur * paso * 0.95, sr), 1.0, sr);
          eventos.push([t0 + i * paso, "bajo", nota]);
        }
      } else if (parte === "voz") {
        for (const [i, nota, dur] of vozLarga) {
          poner(senal, t0 + i * paso, voz(nota, dur * paso * 0.97, sr), 1.0, sr);
          eventos.push([t0 + i * paso, "voz", dur * paso]);
        }
      } else {
        poner(senal, t0, pad([48, 55, 64], 16 * paso, sr), 0.5, sr);
      }
    }
  }
  eventos.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  return { senal: normalizar(senal), eventos, partes };
}
