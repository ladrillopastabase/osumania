// Motor de análisis musical.
//
// A partir de la señal mono (22 050 Hz) obtiene:
//   * envolventes de onset (total y por bandas grave/media/aguda) y onsets,
//   * BPM constante, offset del primer tiempo fuerte y rejilla de pulsos,
//   * contorno melódico (altura dominante por suma de armónicos) y del bajo,
//   * curva de intensidad y secciones musicales por novedad tímbrica,
//   * capas por instrumento (ver capas.js) y duración de notas sostenidas.

import { DEFINICION, N_MEL_FINO, separar } from "./capas.js";
import {
  FFTReal, argmax, autocorrelacion, filtroMaximo, filtroMediana, filtroUniforme, hann, limitar,
  maximoEn, media, normalizar, percentil, redondear,
} from "./dsp.js";

export const SR = 22050;
export const HOP = 256;
const N_FFT_ONSET = 1024;
const N_FFT_MELODIA = 2048;
const N_MEL = 64;

// Desfase medido entre el pico de flujo espectral y el ataque real (segundos),
// calibrado con clics sintéticos (ver tests).
export const CORRECCION_ONSET = 0.0116;

const BPM_MIN = 60;
const BPM_MAX = 250;
const BPM_PREFERIDO = 140;
const BPM_DOBLE = 100; // por debajo, se prefiere el doble si también está marcado

// --------------------------------------------------------------- clase Analisis

export class Analisis {
  constructor(campos) {
    Object.assign(this, campos);
  }

  get periodo() {
    return 60 / this.bpm;
  }

  /** Tiempos de todos los pulsos dentro de la canción (incluye anteriores al offset). */
  pulsos() {
    const primero = this.offset - Math.floor(this.offset / this.periodo) * this.periodo;
    const salida = [];
    for (let t = primero; t < this.duracion; t += this.periodo) salida.push(t);
    return salida;
  }

  /** Índice del pulso relativo al offset (0 = primer tiempo fuerte). */
  indicePulso(t) {
    return redondear((t - this.offset) / this.periodo);
  }

  frame(t) {
    return limitar(redondear(t / this.hopS), 0, this.env.length - 1);
  }

  maximo(curva, t, ventana) {
    const a = this.frame(t - ventana);
    const b = this.frame(t + ventana) + 1;
    return b > a ? maximoEn(curva, a, b) : curva[a];
  }

  valor(curva, t) {
    return curva[this.frame(t)];
  }

  seccionEn(t) {
    for (const s of this.secciones) if (s.inicio <= t && t < s.fin) return s;
    return this.secciones.length ? this.secciones[this.secciones.length - 1] : null;
  }

  /**
   * Cuánto dura el sonido tonal que empieza en `t` (s). Se corta cuando la energía
   * cae 7 dB respecto del ataque o cuando aparece un ataque nuevo. Con `capa`
   * ("bajo", "melodia") se mide solo ese instrumento.
   */
  sostenido(t, maximo = 4.0, capa = null) {
    const i = this.frame(t);
    const fin = Math.min(this.env.length, i + Math.trunc(maximo / this.hopS));
    if (fin - i < 4) return 0;
    let energia, ataques;
    if (capa && this.capas[capa] && this.capas[capa].energiaDb) {
      energia = this.capas[capa].energiaDb;
      ataques = this.capas[capa].env;
    } else {
      energia = this.energiaTonalDb;
      // Solo un ataque armónico nuevo corta la nota: la percusión no.
      ataques = this.capas.melodia ? this.capas.melodia.env : this.envMedio;
    }
    const referencia = maximoEn(energia, i, i + 4);
    for (let j = i + 4; j < fin; j++) {
      if (energia[j] < referencia - 7 || ataques[j] > 0.5) return (j - i) * this.hopS;
    }
    return (fin - i) * this.hopS;
  }

  /** Resumen liviano para la interfaz (curvas reducidas a `puntos`). */
  resumen(puntos = 600) {
    const reducir = (curva) => {
      if (curva.length <= puntos) return Array.from(curva, (v) => +v.toFixed(3));
      const salida = [];
      for (let k = 0; k < puntos; k++) {
        const a = Math.floor((k * curva.length) / puntos);
        const b = Math.floor(((k + 1) * curva.length) / puntos);
        salida.push(+maximoEn(curva, a, Math.max(b, a + 1)).toFixed(3));
      }
      return salida;
    };
    const capas = {};
    for (const [nombre, c] of Object.entries(this.capas)) {
      // En las capas melódicas también cuenta cuánto suenan sostenidas.
      const curva = c.familia === "melodia" && c.presencia
        ? c.actividad.map((v, i) => Math.max(v, c.presencia[i])) : c.actividad;
      capas[nombre] = { familia: c.familia, onsets: Array.from(c.fuerzas).filter((f) => f >= 0.2).length,
        actividad: reducir(curva) };
    }
    return {
      duracion: +this.duracion.toFixed(3),
      bpm: +this.bpm.toFixed(3),
      offset_ms: Math.round(this.offset * 1000),
      compas: this.compas,
      onsets: this.onsets.length,
      secciones: this.secciones.map((s) => ({
        inicio: +s.inicio.toFixed(3), fin: +s.fin.toFixed(3), intensidad: +s.intensidad.toFixed(3),
        etiqueta: s.etiqueta, kiai: s.kiai,
      })),
      intensidad: reducir(this.intensidad),
      capas,
    };
  }
}

// --------------------------------------------------------------- espectro

const hzAMel = (f) => 2595 * Math.log10(1 + f / 700);
const melAHz = (m) => 700 * (10 ** (m / 2595) - 1);

/** Banco de filtros mel triangulares (disperso: inicio + pesos por banda). */
export function bancoMel(sr, nFft, nMel = N_MEL, fmin = 30, fmax = null) {
  fmax = fmax || sr / 2;
  const nBins = nFft / 2 + 1;
  const puntos = [];
  const a = hzAMel(fmin), b = hzAMel(fmax);
  for (let i = 0; i < nMel + 2; i++) puntos.push(melAHz(a + ((b - a) * i) / (nMel + 1)));
  const filtros = [];
  for (let m = 0; m < nMel; m++) {
    const [izq, centro, der] = [puntos[m], puntos[m + 1], puntos[m + 2]];
    const pesos = [];
    let inicio = -1;
    for (let k = 0; k < nBins; k++) {
      const f = (k * sr) / nFft;
      const w = Math.max(0, Math.min((f - izq) / Math.max(centro - izq, 1e-9), (der - f) / Math.max(der - centro, 1e-9)));
      if (w > 0) {
        if (inicio < 0) inicio = k;
        pesos[k - inicio] = w;
      } else if (inicio >= 0) {
        break;
      }
    }
    filtros.push({ inicio: Math.max(inicio, 0), pesos: Float64Array.from(pesos, (v) => v || 0) });
  }
  return { filtros, centros: puntos.slice(1, -1) };
}

function matrizArmonicos(sr, nFft, midiMin = 43, midiMax = 87, nArmonicos = 6) {
  const nBins = nFft / 2 + 1;
  const resolucion = sr / nFft;
  const midis = [], bins = [], pesos = [];
  for (let m = midiMin; m <= midiMax; m++) {
    const f0 = 440 * 2 ** ((m - 69) / 12);
    midis.push(m);
    for (let h = 1; h <= nArmonicos; h++) {
      const bin = Math.round((f0 * h) / resolucion);
      bins.push(Math.min(bin, nBins - 1));
      pesos.push(bin >= nBins ? 0 : 0.84 ** (h - 1));
    }
  }
  return { midis: Float32Array.from(midis), bins: Int32Array.from(bins), pesos: Float64Array.from(pesos), nArmonicos };
}

function espectros(senal, sr, alAvanzar) {
  const n = 1 + Math.floor(senal.length / HOP);
  const margen = N_FFT_MELODIA / 2;
  const acolchada = new Float32Array(senal.length + 2 * margen + N_FFT_MELODIA);
  acolchada.set(senal, margen);

  const ventanaOn = hann(N_FFT_ONSET);
  const ventanaMel = hann(N_FFT_MELODIA);
  const banco = bancoMel(sr, N_FFT_ONSET);
  const bancoFino = bancoMel(sr, N_FFT_ONSET, N_MEL_FINO);
  const arm = matrizArmonicos(sr, N_FFT_MELODIA);
  const armBajo = matrizArmonicos(sr, N_FFT_MELODIA, 28, 52, 4);
  const nMidis = arm.midis.length, nMidisBajo = armBajo.midis.length;
  const binsMel = N_FFT_MELODIA / 2 + 1;
  const tonalDesde = Math.ceil((80 * N_FFT_MELODIA) / sr);
  const tonalHasta = Math.floor((4000 * N_FFT_MELODIA) / sr);

  const melDb = new Float32Array(n * N_MEL);
  const melFino = new Float32Array(n * N_MEL_FINO);
  const energia = new Float64Array(n);
  const energiaTonal = new Float64Array(n);
  const saliencia = new Float32Array(n * nMidis);
  const salienciaBajo = new Float32Array(n * nMidisBajo);

  const fftOn = new FFTReal(N_FFT_ONSET), fftMel = new FFTReal(N_FFT_MELODIA);
  const cuadroOn = new Float64Array(N_FFT_ONSET), cuadroMel = new Float64Array(N_FFT_MELODIA);
  const potOn = new Float64Array(N_FFT_ONSET / 2 + 1), potMel = new Float64Array(binsMel);
  const comprimida = new Float64Array(binsMel);
  const desplazOn = margen - N_FFT_ONSET / 2; // centra ambas ventanas en el mismo instante

  const aplicarBanco = (bancoActual, pot, destino, fila) => {
    const filtros = bancoActual.filtros;
    for (let m = 0; m < filtros.length; m++) {
      const { inicio, pesos } = filtros[m];
      let s = 0;
      for (let j = 0; j < pesos.length; j++) s += pot[inicio + j] * pesos[j];
      destino[fila * filtros.length + m] = s;
    }
  };
  const salienciaDe = (a, destino, fila) => {
    const nm = a.midis.length, h = a.nArmonicos;
    for (let m = 0; m < nm; m++) {
      let s = 0;
      for (let j = 0; j < h; j++) s += comprimida[a.bins[m * h + j]] * a.pesos[m * h + j];
      destino[fila * nm + m] = s;
    }
  };

  for (let f = 0; f < n; f++) {
    const pos = f * HOP;
    for (let j = 0; j < N_FFT_ONSET; j++) cuadroOn[j] = acolchada[pos + desplazOn + j] * ventanaOn[j];
    fftOn.potencia(cuadroOn, potOn);
    aplicarBanco(banco, potOn, melDb, f);
    aplicarBanco(bancoFino, potOn, melFino, f);
    let e = 0;
    for (let k = 0; k < potOn.length; k++) e += potOn[k];
    energia[f] = e;

    for (let j = 0; j < N_FFT_MELODIA; j++) cuadroMel[j] = acolchada[pos + j] * ventanaMel[j];
    fftMel.potencia(cuadroMel, potMel);
    let tonal = 0;
    for (let k = 0; k < binsMel; k++) {
      if (k >= tonalDesde && k <= tonalHasta) tonal += potMel[k];
      comprimida[k] = Math.log1p(Math.sqrt(potMel[k]) * 10);
    }
    energiaTonal[f] = tonal;
    salienciaDe(arm, saliencia, f);
    salienciaDe(armBajo, salienciaBajo, f);
    if (alAvanzar && f % 2000 === 0) alAvanzar(f / n);
  }

  let maximoDb = -Infinity;
  for (let i = 0; i < melDb.length; i++) {
    melDb[i] = 10 * Math.log10(melDb[i] + 1e-10);
    if (melDb[i] > maximoDb) maximoDb = melDb[i];
  }
  for (let i = 0; i < melDb.length; i++) melDb[i] = Math.max(melDb[i], maximoDb - 80);
  return {
    n, melDb, melFino, energia, energiaTonal, saliencia, salienciaBajo,
    midis: arm.midis, midisBajo: armBajo.midis, centros: banco.centros, centrosFinos: bancoFino.centros,
  };
}

/** Flujo espectral con máximo local en frecuencia (reduce falsos onsets por vibrato). */
function flujoPorBandas(melDb, n, grupos) {
  const salida = grupos.map(() => new Float64Array(n));
  const refPrevia = new Float64Array(N_MEL);
  const fila = new Float64Array(N_MEL);
  for (let f = 0; f < n; f++) {
    for (let b = 0; b < N_MEL; b++) fila[b] = melDb[f * N_MEL + b];
    if (f > 0) {
      grupos.forEach((bandas, g) => {
        let s = 0;
        for (const b of bandas) s += Math.max(0, fila[b] - refPrevia[b]);
        salida[g][f] = s / bandas.length;
      });
    }
    refPrevia.set(filtroMaximo(fila, 3));
  }
  return salida;
}

// --------------------------------------------------------------- onsets y tempo

export function detectarOnsets(env, hopS, delta = 0.06) {
  const preMax = Math.max(1, Math.trunc(0.03 / hopS));
  const preMedia = Math.max(1, Math.trunc(0.1 / hopS));
  const espera = Math.max(1, Math.trunc(0.03 / hopS));
  const maximos = filtroMaximo(env, 2 * preMax + 1);
  const medias = filtroUniforme(env, 2 * preMedia + 1);
  const tiempos = [], fuerzas = [];
  let ultimo = -1e9;
  for (let i = 0; i < env.length; i++) {
    if (env[i] >= maximos[i] && env[i] >= medias[i] + delta && env[i] > 0.08 && i - ultimo >= espera) {
      tiempos.push(i * hopS + CORRECCION_ONSET);
      fuerzas.push(env[i]);
      ultimo = i;
    }
  }
  return [Float64Array.from(tiempos), Float64Array.from(fuerzas)];
}

/** Une los onsets de la envolvente total con los de cada banda. */
function detectarOnsetsPorBanda(env, bandas, hopS, union = 0.025) {
  const todos = [...detectarOnsets(env, hopS)[0]];
  for (const banda of bandas) todos.push(...detectarOnsets(banda, hopS, 0.08)[0]);
  todos.sort((a, b) => a - b);
  const unidos = [];
  for (const t of todos) {
    if (unidos.length && t - unidos[unidos.length - 1] < union) continue;
    unidos.push(t);
  }
  const fuerzas = unidos.map((t) => {
    const i = limitar(Math.round((t - CORRECCION_ONSET) / hopS), 0, env.length - 1);
    return Math.max(env[i], ...bandas.map((b) => b[i]));
  });
  return [Float64Array.from(unidos), Float64Array.from(fuerzas)];
}

function estimarBpmInicial(env, hopS) {
  const fondo = filtroUniforme(env, Math.max(3, Math.trunc(1 / hopS)));
  const centrada = Float64Array.from(env, (v, i) => Math.max(v - fondo[i], 0));
  const ac = autocorrelacion(centrada);
  const lagMin = Math.max(Math.trunc(60 / (BPM_MAX * hopS)), 2);
  const lagMax = Math.min(ac.length - 2, Math.trunc(60 / (BPM_MIN * hopS)) + 1);
  const puntaje = [];
  for (let lag = lagMin; lag < lagMax; lag++) {
    const bpm = 60 / (lag * hopS);
    // Prior log-normal: evita confundir el tempo con su mitad o su doble.
    const prior = Math.exp(-0.5 * (Math.log2(bpm / BPM_PREFERIDO) / 0.6) ** 2);
    puntaje.push(ac[lag] * prior);
  }
  let i = argmax(puntaje);
  // Un tempo lento con un pulso al doble casi igual de marcado (DnB, trap, half-time)
  // se mapea al doble: con la mitad, la rejilla queda demasiado gruesa.
  if (60 / ((lagMin + i) * hopS) < BPM_DOBLE) {
    const medio = Math.round((lagMin + i) / 2) - lagMin;
    let doble = -1;
    for (let j = Math.max(0, medio - 1); j <= Math.min(puntaje.length - 1, medio + 1); j++) {
      if (doble < 0 || puntaje[j] > puntaje[doble]) doble = j;
    }
    if (doble >= 0 && puntaje[doble] >= 0.6 * puntaje[i]) i = doble;
  }
  let desplaz = 0;
  if (i > 0 && i < puntaje.length - 1) {
    const [a, b, c] = [puntaje[i - 1], puntaje[i], puntaje[i + 1]];
    const den = a - 2 * b + c;
    desplaz = Math.abs(den) > 1e-12 ? (0.5 * (a - c)) / den : 0;
  }
  const lag = lagMin + i + limitar(desplaz, -0.5, 0.5);
  return 60 / (lag * hopS);
}

/** Suma de la envolvente (interpolada) sobre una rejilla de pulsos, para cada fase. */
function puntajeRejilla(env, periodo, fases) {
  const ultimaFase = fases[fases.length - 1];
  const nPulsos = Math.trunc((env.length - 1 - ultimaFase) / periodo);
  const salida = new Float64Array(fases.length);
  if (nPulsos < 2) return salida;
  const interpolar = (x) => {
    const base = Math.min(Math.floor(x), env.length - 2);
    const frac = x - base;
    return env[base] * (1 - frac) + env[base + 1] * frac;
  };
  for (let k = 0; k < fases.length; k++) {
    let s = 0, sMedio = 0;
    for (let p = 0; p < nPulsos; p++) {
      const x = fases[k] + periodo * p;
      const base = Math.floor(x);
      const frac = x - base;
      s += env[base] * (1 - frac) + env[Math.min(base + 1, env.length - 1)] * frac;
      // Medio pulso con peso menor: ayuda a no fijarse en los contratiempos.
      sMedio += interpolar(x + periodo / 2);
    }
    salida[k] = (s + 0.25 * sMedio) / nPulsos;
  }
  return salida;
}

function rango(desde, hasta, paso) {
  const salida = [];
  for (let v = desde; v < hasta - 1e-12; v += paso) salida.push(v);
  return salida;
}

/** Afina BPM y fase buscando la rejilla constante que mejor calza con los onsets. */
function ajustarRejilla(env, hopS, bpmInicial, ancho = 0.03) {
  let mejor = [-1, bpmInicial, 0];
  for (let i = 0; i < 121; i++) {
    const bpm = bpmInicial * (1 - ancho + (2 * ancho * i) / 120);
    const periodo = 60 / (bpm * hopS);
    const fases = rango(0, periodo, 0.25);
    const puntajes = puntajeRejilla(env, periodo, fases);
    const j = argmax(puntajes);
    if (puntajes[j] > mejor[0]) mejor = [puntajes[j], bpm, fases[j]];
  }
  let bpm = mejor[1];
  // La mayoría de la música producida usa BPM enteros o .5: si estamos cerca, se fija.
  for (const paso of [1, 0.5]) {
    const redondeado = redondear(bpm / paso) * paso;
    if (Math.abs(redondeado - bpm) <= 0.12 * paso * 2) { bpm = redondeado; break; }
  }
  const periodo = 60 / (bpm * hopS);
  const fases = rango(0, periodo, 0.1);
  const fase = fases[argmax(puntajeRejilla(env, periodo, fases))];
  return [bpm, fase * hopS];
}

/** Elige cuál de los `compas` pulsos posibles es el primer tiempo del compás. */
function elegirTiempoFuerte(envBajo, env, hopS, bpm, fase, compas = 4) {
  const periodo = 60 / bpm;
  const sumas = new Array(compas).fill(0), cuentas = new Array(compas).fill(0);
  let k = 0;
  for (let t = fase; t < env.length * hopS; t += periodo, k++) {
    const i = limitar(Math.round(t / hopS), 0, env.length - 1);
    sumas[k % compas] += envBajo[i] + 0.3 * env[i];
    cuentas[k % compas] += 1;
  }
  const puntajes = sumas.map((s, m) => (cuentas[m] ? s / cuentas[m] : 0));
  return fase + argmax(puntajes) * periodo;
}

// --------------------------------------------------------------- melodía, intensidad, secciones

function contornoMelodico(saliencia, midis, n, hopS) {
  const nm = midis.length;
  const mejorMidi = new Float64Array(n);
  const confianza = new Float64Array(n);
  const fila = new Float64Array(nm);
  for (let f = 0; f < n; f++) {
    let mejor = 0;
    for (let m = 0; m < nm; m++) {
      fila[m] = saliencia[f * nm + m];
      if (fila[m] > fila[mejor]) mejor = m;
    }
    const pico = fila[mejor];
    fila.sort();
    const mediana = nm % 2 ? fila[(nm - 1) / 2] : 0.5 * (fila[nm / 2 - 1] + fila[nm / 2]);
    confianza[f] = (pico - mediana) / (pico + 1e-6);
    mejorMidi[f] = midis[mejor];
  }
  const tam = Math.max(3, Math.trunc(0.06 / hopS) | 1);
  const altura = Float32Array.from(filtroMediana(mejorMidi, tam));
  const suave = normalizar(filtroUniforme(confianza, tam), 98);
  return [altura, Float32Array.from(suave, (v) => limitar(v, 0, 1))];
}

function curvaIntensidad(energia, hopS) {
  const db = filtroUniforme(Float64Array.from(energia, (e) => 10 * Math.log10(e + 1e-10)),
    Math.max(3, Math.trunc(0.4 / hopS)));
  const bajo = percentil(db, 5), alto = percentil(db, 98);
  if (alto - bajo < 1e-6) return new Float32Array(db.length).fill(0.5);
  return Float32Array.from(db, (v) => limitar((v - bajo) / (alto - bajo), 0, 1));
}

function crearSeccion(inicio, fin, intensidad, hopS, todasLasMedias) {
  const a = Math.trunc(inicio / hopS);
  const b = Math.max(Math.trunc(fin / hopS), a + 1);
  const valor = media(intensidad, a, Math.min(b, intensidad.length));
  const maximo = todasLasMedias.length ? Math.max(...todasLasMedias) : valor;
  const relativo = maximo > 0 ? valor / maximo : 0;
  let etiqueta;
  if (valor < 0.25) etiqueta = "tranquila";
  else if (relativo >= 0.9 && valor >= 0.6) etiqueta = "clímax";
  else if (valor >= 0.55) etiqueta = "intensa";
  else etiqueta = "media";
  return { inicio, fin, intensidad: valor, etiqueta, kiai: etiqueta === "clímax" };
}

function detectarSecciones(melDb, n, intensidad, env, hopS, offset, bpm, duracion, compas = 4) {
  const duracionCompas = (compas * 60) / bpm;
  const primero = offset - Math.floor(offset / duracionCompas) * duracionCompas;
  const bordesSet = new Set([0, duracion]);
  for (let t = primero; t < duracion; t += duracionCompas) if (t > 1e-3) bordesSet.add(t);
  const bordes = [...bordesSet].sort((a, b) => a - b);
  if (bordes.length < 3) return [crearSeccion(0, duracion, intensidad, hopS, [0.5])];

  const indices = bordes.map((t) => limitar(Math.round(t / hopS), 0, n));
  const rasgos = [];
  for (let k = 0; k < indices.length - 1; k++) {
    const a = indices[k], b = Math.max(indices[k + 1], a + 1);
    const hasta = Math.min(b, n);
    const v = new Float64Array(N_MEL + 2);
    for (let f = a; f < hasta; f++) for (let m = 0; m < N_MEL; m++) v[m] += melDb[f * N_MEL + m];
    const cuenta = Math.max(1, hasta - a);
    for (let m = 0; m < N_MEL; m++) v[m] /= cuenta * 10;
    v[N_MEL] = media(intensidad, a, hasta) * 8;
    v[N_MEL + 1] = media(env, a, hasta) * 8;
    rasgos.push(v);
  }
  const dims = N_MEL + 2;
  const promedio = new Float64Array(dims);
  for (const v of rasgos) for (let d = 0; d < dims; d++) promedio[d] += v[d] / rasgos.length;
  const unitarios = rasgos.map((v) => {
    const c = v.map((x, d) => x - promedio[d]);
    const norma = Math.sqrt(c.reduce((s, x) => s + x * x, 0)) + 1e-9;
    return c.map((x) => x / norma);
  });
  const N = unitarios.length;
  const sim = (i, j) => { let s = 0; for (let d = 0; d < dims; d++) s += unitarios[i][d] * unitarios[j][d]; return s; };
  const S = Array.from({ length: N }, (_, i) => Float64Array.from({ length: N }, (_, j) => sim(i, j)));
  const bloque = (i0, i1, j0, j1) => {
    let s = 0;
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) s += S[i][j];
    return s / ((i1 - i0) * (j1 - j0));
  };
  const L = 4;
  const novedad = new Float64Array(N);
  for (let i = L; i < N - L + 1; i++) {
    novedad[i] = bloque(i - L, i, i - L, i) + bloque(i, i + L, i, i + L) - 2 * bloque(i - L, i, i, i + L);
  }
  const cortes = [0];
  if (maximoEn(novedad) > 0) {
    const m = media(novedad);
    const desv = Math.sqrt(novedad.reduce((s, x) => s + (x - m) ** 2, 0) / N);
    const umbral = m + 0.5 * desv;
    for (let i = 1; i < N - 1; i++) {
      const vecinos = maximoEn(novedad, Math.max(0, i - 3), Math.min(N, i + 4));
      if (novedad[i] >= umbral && novedad[i] === vecinos && i - cortes[cortes.length - 1] >= 4) cortes.push(i);
    }
  }
  if (N - cortes[cortes.length - 1] < 4 && cortes.length > 1) cortes.pop();
  cortes.push(N);

  const tramos = [];
  for (let k = 0; k < cortes.length - 1; k++) tramos.push([bordes[cortes[k]], bordes[cortes[k + 1]]]);
  const medias = tramos.map(([a, b]) => {
    const i = Math.trunc(a / hopS);
    return media(intensidad, i, Math.min(Math.max(Math.trunc(b / hopS), i + 1), intensidad.length));
  });
  return tramos.map(([a, b]) => crearSeccion(a, b, intensidad, hopS, medias));
}

// --------------------------------------------------------------- punto de entrada

/**
 * Analiza la canción completa (señal mono a 22 050 Hz). `bpm`/`offset` (s)
 * permiten forzar la rejilla. `alAvanzar(fraccion, etapa)` informa el progreso.
 */
export function analizar(senal, { sr = SR, bpm = null, offset = null, compas = 4, alAvanzar = null } = {}) {
  const hopS = HOP / sr;
  const duracion = senal.length / sr;
  const avance = (f, etapa) => alAvanzar && alAvanzar(f, etapa);
  const e = espectros(senal, sr, (f) => avance(0.6 * f, "Espectro"));
  avance(0.6, "Separando instrumentos");
  const capas = separar(e.melFino, e.n, e.centrosFinos, hopS, detectarOnsets);
  avance(0.85, "Ritmo y secciones");

  const grupos = [[], [], []];
  e.centros.forEach((c, b) => grupos[c < 200 ? 0 : c > 2500 ? 2 : 1].push(b));
  const [fBajo, fMedio, fAlto] = flujoPorBandas(e.melDb, e.n, grupos);
  const envBajo = normalizar(fBajo), envMedio = normalizar(fMedio), envAlto = normalizar(fAlto);
  // Cada banda pesa lo mismo: si no, los agudos (muchas bandas mel) dominan.
  const env = normalizar(Float64Array.from(envBajo, (v, i) => (v + envMedio[i] + envAlto[i]) / 3));
  const [onsets, fuerzas] = detectarOnsetsPorBanda(env, [envBajo, envMedio, envAlto], hopS);
  // Los graves (bombo) marcan el pulso con más fiabilidad que los platillos.
  const envPulso = normalizar(Float64Array.from(env, (v, i) => v + 1.5 * envBajo[i]));

  let bpmFinal, fase;
  if (bpm) {
    bpmFinal = Number(bpm);
    if (offset === null || offset === undefined) {
      const periodo = 60 / (bpmFinal * hopS);
      const fases = rango(0, periodo, 0.1);
      fase = fases[argmax(puntajeRejilla(envPulso, periodo, fases))] * hopS;
    } else {
      fase = Number(offset);
    }
  } else {
    [bpmFinal, fase] = ajustarRejilla(envPulso, hopS, estimarBpmInicial(envPulso, hopS));
    if (offset !== null && offset !== undefined) fase = Number(offset);
  }
  if (offset === null || offset === undefined) {
    fase = elegirTiempoFuerte(envBajo, env, hopS, bpmFinal, fase, compas) + CORRECCION_ONSET;
  }

  const intensidad = curvaIntensidad(e.energia, hopS);
  const [altura, confianzaMelodia] = contornoMelodico(e.saliencia, e.midis, e.n, hopS);
  const [alturaBajo, confianzaBajo] = contornoMelodico(e.salienciaBajo, e.midisBajo, e.n, hopS);
  const energiaTonalDb = Float32Array.from(
    filtroUniforme(Float64Array.from(e.energiaTonal, (v) => 10 * Math.log10(v + 1e-10)), 5));
  const secciones = detectarSecciones(e.melDb, e.n, intensidad, env, hopS, fase, bpmFinal, duracion, compas);
  avance(1, "Listo");

  return new Analisis({
    sr, duracion, hopS, env, envBajo, envMedio, envAlto, onsets, fuerzas,
    bpm: bpmFinal, offset: fase, compas, intensidad, altura, confianzaMelodia, energiaTonalDb,
    secciones, capas, alturaBajo, confianzaBajo,
  });
}

export { DEFINICION };
