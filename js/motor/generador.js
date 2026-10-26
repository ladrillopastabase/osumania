// Motor de generación híbrida.
//
// Convierte un `Analisis` en notas de osu!mania en cuatro etapas:
//
// 1. Eventos: cada onset detectado se ajusta a la rejilla permitida por la
//    dificultad (1/1 y 1/2 en Easy/Normal; 1/4 o 1/3 en Hard/Insane). Si un
//    onset no cae cerca de ningún punto permitido se descarta: nunca se mueve un
//    golpe a otro lugar ni se inventan notas donde no suena nada.
// 2. Selección: cada evento tiene una saliencia según qué instrumento suena
//    (bombo/graves, caja/medios, platillos/agudos, cambio melódico). Por sección
//    se toman los eventos más salientes hasta la densidad objetivo; el umbral es
//    el mismo para toda la sección, así cada compás sigue las mismas capas de la
//    música. Luego se regulariza: los golpes que se repiten en los compases
//    vecinos se incluyen y los aislados débiles se quitan.
// 3. Frases y patrones: los eventos se agrupan en frases de ritmo constante
//    (ráfagas de 1/4, corcheas, etc.). Cada frase recibe un patrón completo
//    —escalera, trino, celda repetida, jumptrill, brackets, chordjack, manos
//    alternas o contorno melódico— que se mantiene toda la frase. Si el mismo
//    ritmo vuelve a aparecer, se repite el patrón (en espejo una vez sí y otra
//    no), como hacen los mapeadores.
// 4. Jugabilidad: cada nota del patrón se coloca si la columna está libre
//    (sin jacks más rápidos que el mínimo ni holds activos); si no, se usa la
//    columna libre más cercana. Los golpes fuertes en tiempo (bombo, caja) se
//    vuelven acordes y las notas sostenidas, holds.
//
// Todo es determinista para una misma semilla.

import { Azar } from "./azar.js";
import { MELODIA, PERCUSION } from "./capas.js";
import { perfil as obtenerPerfil } from "./dificultades.js";
import { bisectIzq, insertarOrdenado, limitar, media, percentil, redondear } from "./dsp.js";

// Importancia por defecto de cada capa (el usuario puede cambiarla, 0..1).
export const PESOS_CAPA_DEFECTO = { bombo: 1.0, caja: 0.9, platillos: 0.5, bajo: 0.6, melodia: 1.0 };
// El instrumento destacado del compás pesa más; el resto, un poco menos.
const REFUERZO_DESTACADO = 1.6;
const ATENUACION_RESTO = 0.8;
const ATAQUES_PLENOS = 4.0; // fuerza de ataques por segundo que cuenta como actividad plena
const PESO_CAMBIO_MELODICO = 0.6;
const BONO_NIVEL = [0.15, 0.1, 0.05, 0.0];
const FACTOR_SECCION = { tranquila: 0.55, media: 0.9, intensa: 1.15, "clímax": 1.45 };
// Hueco máximo (en pulsos) con música sonando, antes de rellenar; se escala por sección.
const HUECO_MAXIMO = { Easy: 4.0, Normal: 2.0, Hard: 1.5, Insane: 1.0 };
const FACTOR_HUECO = { tranquila: 2.0, media: 1.0, intensa: 0.75, "clímax": 0.5 };
// Holds: largo máximo y pausa mínima entre holds (en pulsos), y parte del tiempo que
// pueden ocupar en una ventana de 8 pulsos con el control en 1×. Holds largos y
// seguidos se vuelven monótonos: es mejor pocos, en notas que de verdad se sostienen.
const HOLD_MAXIMO = { Easy: 4.0, Normal: 3.0, Hard: 2.0, Insane: 2.0 };
const HOLD_PAUSA = { Easy: 2.0, Normal: 1.5, Hard: 1.0, Insane: 1.0 };
const HOLD_COBERTURA = 0.25;
const HOLD_VENTANA = 8.0;
const UNIDADES_PULSO = 12; // 1/4 = 3 unidades, 1/3 = 4 unidades

/** Largo máximo de un hold en segundos (el estilo LN, sobre 1×, permite algo más). */
export function holdMaximo(perfil, periodo, holds) {
  return HOLD_MAXIMO[perfil.nombre] * periodo * (1.0 + 0.5 * Math.max(0.0, holds - 1.0));
}

// División entera con resto no negativo, como divmod de Python.
function divmod(a, b) {
  const q = Math.floor(a / b);
  return [q, a - q * b];
}

/** Clave de mayor valor (la primera en caso de empate), como max(d, key=d.get). */
function claveMaxima(objeto) {
  let mejor = null;
  for (const [clave, valor] of Object.entries(objeto)) if (mejor === null || valor > objeto[mejor]) mejor = clave;
  return mejor;
}

/** Elemento de menor clave, evaluando la clave una sola vez por elemento y en orden. */
function minimoPor(lista, clave) {
  let mejor = null, valorMejor = Infinity;
  for (const x of lista) {
    const v = clave(x);
    if (mejor === null || v < valorMejor) { mejor = x; valorMejor = v; }
  }
  return mejor;
}

/** Ordena por una clave calculada una vez por elemento (orden estable). */
function ordenarPor(lista, clave) {
  return lista.map((x) => [clave(x), x]).sort((a, b) => a[0] - b[0]).map((par) => par[1]);
}

export class Nota {
  constructor(tiempo, columna, fin = null) {
    this.tiempo = tiempo;
    this.columna = columna;
    this.fin = fin;
  }

  get esHold() {
    return this.fin !== null;
  }
}

export class OpcionesGeneracion {
  constructor({
    teclas = 4, dificultad = "Normal", percusion = 0.5, melodia = 0.5, densidad = 1.0, holds = 1.0,
    semilla = 0, capas = null, capasSecciones = null,
  } = {}) {
    this.teclas = Number(teclas);
    this.dificultad = dificultad;
    // Peso de cada capa, 0..1 (por defecto PESOS_CAPA_DEFECTO).
    this.capas = OpcionesGeneracion.normalizarPesos(capas, PESOS_CAPA_DEFECTO);
    // Pesos distintos por tramo: [{inicio, fin, capas: {capa: 0..1}}, ...].
    // Fuera de esos tramos rigen los pesos globales de `capas`.
    const tramos = [];
    for (const tramo of capasSecciones || []) {
      const inicio = Number(tramo.inicio), fin = Number(tramo.fin);
      if (fin > inicio) tramos.push([inicio, fin, OpcionesGeneracion.normalizarPesos(tramo.capas, this.capas)]);
    }
    tramos.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.capasSecciones = tramos;
    if (this.teclas !== 4 && this.teclas !== 7) throw new Error("Solo se admiten 4K y 7K.");
    this.percusion = limitar(Number(percusion), 0, 1);  // cuánto siguen las notas a la batería
    this.melodia = limitar(Number(melodia), 0, 1);      // cuánto siguen a la melodía y el bajo
    if (this.percusion + this.melodia < 0.05) {
      throw new Error("La percusión y la melodía no pueden estar ambas en cero.");
    }
    const maximoGlobal = Math.max(...Object.keys(this.capas).map((c) => this.peso(c)));
    if (maximoGlobal < 0.02 && !this.capasSecciones.some(([, , p]) => Math.max(...Object.values(p)) >= 0.02)) {
      throw new Error("Todas las capas están en cero.");
    }
    this.densidad = limitar(Number(densidad), 0.3, 2.5);
    this.holds = limitar(Number(holds), 0, 3);
    this.semilla = Math.trunc(Number(semilla)) || 0;
  }

  static normalizarPesos(valores, base) {
    const pesos = { ...base };
    for (const [nombre, valor] of Object.entries(valores || {})) {
      if (!(nombre in pesos)) throw new Error(`Capa desconocida: ${nombre}`);
      pesos[nombre] = limitar(Number(valor), 0, 1);
    }
    return pesos;
  }

  /** Pesos de las capas que rigen en el instante `t` (de su sección o globales). */
  pesosEn(t) {
    if (t !== null && t !== undefined) {
      for (const [inicio, fin, pesos] of this.capasSecciones) if (inicio <= t && t < fin) return pesos;
    }
    return this.capas;
  }

  /** Peso efectivo de una capa en `t`: control de la capa × control de su familia. */
  peso(capa, t = null) {
    const familia = PERCUSION.includes(capa) ? this.percusion : this.melodia;
    return 2.0 * familia * (this.pesosEn(t)[capa] ?? 0);
  }
}

class Evento {
  constructor(tiempo, compas, posicion, nivel, relleno = false) {
    this.tiempo = tiempo;
    this.compas = compas;     // índice de compás relativo al offset
    this.posicion = posicion; // posición dentro del compás en unidades de 1/12 de pulso
    this.nivel = nivel;       // 0 tiempo fuerte, 1 pulso, 2 medio pulso, 3 subdivisión menor
    this.capas = {};          // fuerza del ataque en cada capa
    this.cambio = 0;          // cambio de altura melódica
    this.cambioBajo = 0;      // cambio de altura de la línea de bajo
    this.altura = 60;
    this.confianza = 0;
    this.saliencia = 0;
    this.melodico = 0;        // 0 = solo percusión, 1 = solo melodía
    this.relleno = relleno;   // nota en el pulso para no dejar un hueco con música sonando
    this.lider = null;        // capa que más aporta a este evento
    this.destacado = null;    // instrumento destacado del compás
    this.aportes = {};        // aporte de cada capa a la saliencia
    this.atribuidas = {};     // fuerza por capa tras resolver bombo/bajo
    this.holdHasta = 0;       // si > 0, el relleno de huecos pidió sostenerlo hasta aquí
    this.holdPlan = 0;        // si > 0, el plan de holds decidió sostenerlo hasta aquí
  }

  fuerza(capa) {
    return this.capas[capa] ?? 0;
  }

  /** Capa melódica cuya duración debe seguir un hold que empiece aquí. */
  capaSostenida() {
    if (MELODIA.includes(this.lider)) return this.lider;
    if (MELODIA.includes(this.destacado)) return this.destacado;
    const fuerzas = Object.fromEntries(MELODIA.map((c) => [c, this.fuerza(c)]));
    const mejor = claveMaxima(fuerzas);
    return fuerzas[mejor] > 0 ? mejor : null;
  }
}

// ---------------------------------------------------------------------------
// 1. Eventos ajustados a la rejilla
// ---------------------------------------------------------------------------

function usaTresillos(analisis, inicio, periodo) {
  const fases = [];
  for (let i = 0; i < analisis.onsets.length; i++) {
    const t = analisis.onsets[i];
    if (t > inicio + periodo * 0.08 && t < inicio + periodo * 0.92 && analisis.fuerzas[i] > 0.2) {
      fases.push((t - inicio) / periodo);
    }
  }
  if (fases.length < 2) return false;
  let cuartos = 0, tercios = 0;
  for (const f of fases) {
    cuartos += Math.abs(f * 4 - Math.round(f * 4));
    tercios += Math.abs(f * 3 - Math.round(f * 3));
  }
  return tercios / 3 < 0.5 * (cuartos / 4);
}

function cambioMelodico(analisis, t, bajo = false) {
  const altura = bajo ? analisis.alturaBajo : analisis.altura;
  const confianzas = bajo ? analisis.confianzaBajo : analisis.confianzaMelodia;
  if (!altura) return 0;
  const confianza = analisis.maximo(confianzas, t + 0.02, 0.02);
  if (confianza < 0.25) return 0;
  // La ventana de altura dura ~90 ms: se compara justo antes del ataque con
  // un punto donde la ventana ya cubre casi solo la nota nueva.
  const salto = Math.abs(analisis.valor(altura, t + 0.05) - analisis.valor(altura, t - 0.045));
  if (salto < 0.5) return 0;
  return confianza * Math.min(1, salto / 3);
}

/** [tiempo, capa, fuerza] de todas las capas; sin capas, cae a los onsets globales. */
function* ataques(analisis) {
  const capas = Object.values(analisis.capas || {});
  if (capas.length) {
    for (const capa of capas) {
      for (let i = 0; i < capa.onsets.length; i++) yield [capa.onsets[i], capa.nombre, capa.fuerzas[i]];
    }
  } else {
    for (let i = 0; i < analisis.onsets.length; i++) yield [analisis.onsets[i], "caja", analisis.fuerzas[i]];
  }
}

/** Ajusta el ataque de cada capa al punto permitido más cercano de la rejilla. */
export function construirEventos(analisis, perfil, opciones) {
  const periodo = analisis.periodo;
  const tolerancia = 0.03;
  const tresillosPorPulso = new Map();
  const eventos = new Map();

  for (const [t, capa, fuerza] of ataques(analisis)) {
    const relativo = (t - analisis.offset) / periodo;
    let pulso = Math.floor(relativo + 0.5 / UNIDADES_PULSO);
    const fraccion = relativo - pulso;
    let divisor;
    if (perfil.divisor <= 2) {
      divisor = 2;
    } else {
      if (!tresillosPorPulso.has(pulso)) {
        const inicio = analisis.offset + pulso * periodo;
        tresillosPorPulso.set(pulso, perfil.tresillos && usaTresillos(analisis, inicio, periodo));
      }
      divisor = tresillosPorPulso.get(pulso) ? 3 : 4;
    }
    let k = redondear(fraccion * divisor);
    const tiempo = analisis.offset + (pulso + k / divisor) * periodo;
    if (Math.abs(tiempo - t) > Math.min(tolerancia, (0.45 * periodo) / divisor)) {
      continue; // no cae en la rejilla de esta dificultad: no se mueve, se descarta
    }
    if (k === divisor) { pulso += 1; k = 0; }
    if (tiempo < 0 || tiempo >= analisis.duracion - 0.05) continue;
    const [compas, pulsoEnCompas] = divmod(pulso, analisis.compas);
    const posicion = pulsoEnCompas * UNIDADES_PULSO + k * (UNIDADES_PULSO / divisor);
    let nivel;
    if (k === 0) nivel = pulsoEnCompas === 0 ? 0 : 1;
    else if (2 * k === divisor) nivel = 2;
    else nivel = 3;

    const clave = `${compas}:${posicion}`;
    let evento = eventos.get(clave);
    if (!evento) {
      evento = new Evento(tiempo, compas, posicion, nivel);
      eventos.set(clave, evento);
    }
    evento.cambio = Math.max(evento.cambio, cambioMelodico(analisis, t));
    evento.cambioBajo = Math.max(evento.cambioBajo, cambioMelodico(analisis, t, true));
    evento.capas[capa] = Math.max(evento.capas[capa] ?? 0, fuerza);
  }

  const ordenados = [...eventos.values()].sort((a, b) => a.tiempo - b.tiempo);
  atenuarColas(ordenados);

  // Cada capa aporta según su fuerza, el peso que eligió el usuario y si es el
  // instrumento destacado del compás (que se calcula con una primera pasada).
  for (const e of ordenados) aplicarAportes(analisis, e, opciones, new Map());
  const destacados = instrumentosDestacados(analisis, ordenados, opciones);
  for (const e of ordenados) {
    aplicarAportes(analisis, e, opciones, destacados);
    e.saliencia += BONO_NIVEL[e.nivel] * perfil.pesoMetrico * Math.min(1, e.saliencia * 4);
  }
  return ordenados;
}

export function aplicarAportes(analisis, e, opciones, destacados) {
  const fuerzas = {};
  for (const c of [...PERCUSION, ...MELODIA]) fuerzas[c] = e.fuerza(c);
  // Bombo, cuerpo de la caja y bajo comparten registro. Una nota real de bajo cambia
  // de altura; la cola de un bombo 808 o el cuerpo de una caja no. Así se decide a
  // quién atribuir el ataque grave.
  if (fuerzas.bajo) {
    if (e.cambioBajo >= 0.1) {
      if (fuerzas.bombo && fuerzas.bombo < fuerzas.bajo) fuerzas.bombo *= 0.15; // el "golpe" es la pulsación del bajo
    } else if (Math.max(fuerzas.bombo, fuerzas.caja) >= 0.5 * fuerzas.bajo) {
      fuerzas.bajo *= 0.3;
    }
  }
  // Un cambio de altura sin ataque detectado también es una nota de la melodía.
  fuerzas.melodia = Math.max(fuerzas.melodia, PESO_CAMBIO_MELODICO * e.cambio);
  e.atribuidas = { ...fuerzas };
  const destacado = destacados.get(e.compas) ?? null;
  e.destacado = destacado;
  const aportes = {};
  for (const [capa, fuerza] of Object.entries(fuerzas)) {
    let factor = 1.0;
    if (destacado !== null) {
      // Solo se refuerzan ataques reales: un roce débil del destacado no se vuelve nota.
      if (capa === destacado) factor = fuerza >= 0.2 ? REFUERZO_DESTACADO : 1.0;
      else factor = ATENUACION_RESTO;
    }
    aportes[capa] = opciones.peso(capa, e.tiempo) * fuerza * factor;
  }
  const valores = Object.values(aportes);
  const total = valores.reduce((s, v) => s + v, 0);
  const maximo = Math.max(...valores);
  e.aportes = aportes;
  e.lider = maximo > 0 ? claveMaxima(aportes) : destacado;
  e.saliencia = maximo + 0.25 * (total - maximo);
  e.melodico = total > 0 ? MELODIA.reduce((s, c) => s + aportes[c], 0) / total : 0;
  // Si lidera el bajo (en el evento, o en el compás sin que la melodía lo
  // dispute), el contorno que se dibuja es el de la línea de bajo.
  const sigueBajo = e.lider === "bajo" || (destacado === "bajo" && e.lider !== "melodia");
  if (sigueBajo && analisis.alturaBajo) {
    e.altura = analisis.valor(analisis.alturaBajo, e.tiempo + 0.03);
    e.confianza = analisis.maximo(analisis.confianzaBajo, e.tiempo + 0.02, 0.02);
  } else {
    e.altura = analisis.valor(analisis.altura, e.tiempo + 0.03);
    e.confianza = analisis.maximo(analisis.confianzaMelodia, e.tiempo + 0.02, 0.02);
  }
}

/**
 * Capa que lleva la música en cada compás: Map {índice de compás: capa}.
 *
 * Se suman los aportes de cada capa en los eventos del compás (ya con el peso
 * del usuario y la atribución bombo/bajo resuelta) y, para las capas
 * melódicas, cuánto suenan sostenidas (una voz larga tiene pocos ataques).
 * Para que no salte de un instrumento a otro, solo se cambia de destacado si
 * el nuevo supera al actual por un 25 %.
 */
export function instrumentosDestacados(analisis, eventos, opciones) {
  const destacados = new Map();
  const nombres = Object.keys(analisis.capas || {});
  if (!nombres.length) return destacados;
  const duracionCompas = analisis.periodo * analisis.compas;
  const primero = Math.floor(-analisis.offset / duracionCompas);
  const ultimo = Math.ceil((analisis.duracion - analisis.offset) / duracionCompas);
  const sumas = new Map();
  for (const e of eventos) {
    if (!sumas.has(e.compas)) sumas.set(e.compas, {});
    const suma = sumas.get(e.compas);
    for (const [capa, aporte] of Object.entries(e.aportes)) suma[capa] = (suma[capa] ?? 0) + aporte;
  }

  let actual = null;
  for (let b = primero; b < ultimo; b++) {
    const t0 = analisis.offset + b * duracionCompas;
    const i = analisis.frame(Math.max(t0, 0));
    const j = Math.max(analisis.frame(Math.min(t0 + duracionCompas, analisis.duracion)), i + 1);
    const puntajes = {};
    for (const capa of nombres) {
      const actividad = Math.min(1, ((sumas.get(b) || {})[capa] ?? 0) / duracionCompas / ATAQUES_PLENOS);
      let puntaje = actividad;
      const presencia = analisis.capas[capa].presencia;
      if (MELODIA.includes(capa) && presencia) {
        const medio = t0 + duracionCompas / 2;
        puntaje = 0.5 * actividad + 0.5 * opciones.peso(capa, medio) * media(presencia, i, j);
      }
      puntajes[capa] = puntaje;
    }
    const mejor = claveMaxima(puntajes);
    if (puntajes[mejor] < 0.05) actual = null;
    else if (actual === null || puntajes[mejor] > 1.25 * (puntajes[actual] ?? 0)) actual = mejor;
    destacados.set(b, actual);
  }
  return destacados;
}

/**
 * La cola tonal de un golpe (bombo 808, cuerpo de la caja) pasa a la parte
 * armónica con retraso y parece un ataque melódico. Si un ataque armónico sin
 * cambio de altura llega poco después de un golpe percusivo más fuerte, se atenúa.
 */
function atenuarColas(eventos, ventana = 0.15) {
  for (let i = 0; i < eventos.length; i++) {
    const e = eventos[i];
    const melodica = Math.max(0, ...MELODIA.map((c) => e.fuerza(c)));
    if (melodica <= 0 || e.cambio >= 0.1) continue;
    for (let j = i - 1; j >= 0 && e.tiempo - eventos[j].tiempo <= ventana; j--) {
      const golpe = Math.max(0, ...PERCUSION.map((c) => eventos[j].fuerza(c)));
      if (golpe >= 1.5 * melodica) {
        for (const c of MELODIA) if (c in e.capas) e.capas[c] *= 0.3;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Selección por sección y regularización entre compases
// ---------------------------------------------------------------------------

function hayEspacio(tiempos, t, separacion) {
  const i = bisectIzq(tiempos, t);
  if (i < tiempos.length && tiempos[i] - t < separacion - 1e-6) return false;
  return !(i > 0 && t - tiempos[i - 1] < separacion - 1e-6);
}

export function seleccionarEventos(analisis, eventos, perfil, opciones) {
  const densidad = opciones.densidad;
  const elegidos = new Set();
  const tiempos = [];
  const umbrales = new Map();
  const seccionDe = eventos.map((e) => {
    const s = analisis.seccionEn(e.tiempo);
    return s ? analisis.secciones.indexOf(s) : 0;
  });
  // Piso global: en secciones casi vacías no se rellena con eco ni ruido.
  let piso = 0.08;
  if (eventos.length) {
    const proporcion = { Easy: 0.3, Normal: 0.3, Hard: 0.25, Insane: 0.2 }[perfil.nombre] ?? 0.3;
    piso = Math.max(piso, proporcion * percentil(eventos.map((e) => e.saliencia), 75));
  }

  const secciones = analisis.secciones.length ? analisis.secciones : [null];
  secciones.forEach((seccion, indiceSeccion) => {
    const miembros = [];
    seccionDe.forEach((s, i) => { if (s === indiceSeccion) miembros.push(i); });
    if (!miembros.length) return;
    let duracion, factor, intensidad;
    if (seccion === null) {
      [duracion, factor, intensidad] = [analisis.duracion, 1.0, 0.5];
    } else {
      duracion = seccion.fin - seccion.inicio;
      factor = FACTOR_SECCION[seccion.etiqueta];
      intensidad = seccion.intensidad;
    }
    const objetivo = redondear(perfil.nps * densidad * factor * (0.6 + 0.8 * intensidad) * duracion);
    // En el clímax se aceptan golpes más suaves: es donde más notas se esperan.
    const pisoSeccion = piso * (seccion && seccion.kiai ? 0.6 : 1.0);
    let tomados = 0, umbral = 1.0;
    for (const i of ordenarPor(miembros, (i) => -eventos[i].saliencia)) {
      if (tomados >= objetivo || eventos[i].saliencia < pisoSeccion) break;
      if (!hayEspacio(tiempos, eventos[i].tiempo, perfil.separacionMin)) continue;
      elegidos.add(i);
      insertarOrdenado(tiempos, eventos[i].tiempo);
      tomados++;
      umbral = eventos[i].saliencia;
    }
    umbrales.set(indiceSeccion, umbral);
  });

  // Regularización: lo que se repite en los compases vecinos entra; lo aislado y débil sale.
  const porPosicion = new Map(eventos.map((e, i) => [`${e.compas}:${e.posicion}`, i]));
  const elegidoEn = (compas, posicion) => {
    const j = porPosicion.get(`${compas}:${posicion}`);
    return j !== undefined && elegidos.has(j);
  };

  eventos.forEach((e, i) => {
    const umbral = umbrales.get(seccionDe[i]) ?? 1.0;
    const vecinos = [-2, -1, 1, 2].map((d) => elegidoEn(e.compas + d, e.posicion));
    if (!elegidos.has(i)) {
      const repetido = (vecinos[1] && vecinos[2]) || (vecinos[0] && vecinos[3]);
      // La repetición en los compases vecinos es evidencia suficiente: el piso se relaja.
      if (repetido && e.saliencia >= Math.max(0.5 * piso, 0.5 * umbral)
          && hayEspacio(tiempos, e.tiempo, perfil.separacionMin)) {
        elegidos.add(i);
        insertarOrdenado(tiempos, e.tiempo);
      }
    } else if (!vecinos.some(Boolean) && e.saliencia < 1.3 * umbral && e.nivel >= 2) {
      elegidos.delete(i);
      tiempos.splice(bisectIzq(tiempos, e.tiempo), 1);
    }
  });
  const seleccion = [...elegidos].sort((a, b) => eventos[a].tiempo - eventos[b].tiempo).map((i) => eventos[i]);
  const libres = eventos.filter((_, i) => !elegidos.has(i));
  return rellenarHuecos(analisis, seleccion, libres, perfil, opciones, piso);
}

function huecoMaximo(analisis, perfil, t) {
  const seccion = analisis.seccionEn(t);
  const factor = seccion ? FACTOR_HUECO[seccion.etiqueta] : 1.0;
  // Un pulso sin notas nunca es un hueco: es parte del ritmo.
  return Math.max(1.0, HUECO_MAXIMO[perfil.nombre] * factor) * analisis.periodo;
}

function eventoDePulso(analisis, t) {
  const pulso = analisis.indicePulso(t);
  const [compas, pulsoEnCompas] = divmod(pulso, analisis.compas);
  const e = new Evento(t, compas, pulsoEnCompas * UNIDADES_PULSO, pulsoEnCompas === 0 ? 0 : 1, true);
  e.altura = analisis.valor(analisis.altura, t + 0.03);
  e.confianza = analisis.maximo(analisis.confianzaMelodia, t + 0.02, 0.02);
  e.melodico = e.confianza > 0.3 ? 1.0 : 0.5;
  e.saliencia = 0.05;
  return e;
}

/**
 * Evita espacios vacíos mientras la música suena.
 *
 * Para cada hueco más largo que el máximo de la dificultad (más corto en el
 * clímax), en este orden:
 *   1. si el sonido del evento anterior se sostiene, ese evento será un hold
 *      que cubre el hueco;
 *   2. se agregan los golpes reales más fuertes que habían quedado fuera;
 *   3. si aún queda hueco y la música está fuerte, notas en los pulsos.
 */
export function rellenarHuecos(analisis, seleccion, libres, perfil, opciones, piso = 0.08) {
  if (seleccion.length < 2) return seleccion;
  const periodo = analisis.periodo;
  libres = [...libres].sort((a, b) => a.tiempo - b.tiempo);
  const tiemposLibres = libres.map((e) => e.tiempo);
  const usados = new Set();
  const nuevos = [];
  const separacion = perfil.separacionMin;
  // Holds de relleno ya pedidos, para respetar la misma pausa y el mismo tope de
  // tiempo cubierto que los holds normales.
  const holdsRelleno = [];
  const pausaHold = (HOLD_PAUSA[perfil.nombre] * periodo) / Math.max(1.0, opciones.holds);

  const cabeHold = (t) => {
    if (holdsRelleno.length && t < holdsRelleno[holdsRelleno.length - 1][1] + pausaHold) return false;
    const ventana = HOLD_VENTANA * periodo;
    let cubierto = 0;
    for (const [i, f] of holdsRelleno) cubierto += Math.max(0, Math.min(f, t) - Math.max(i, t - ventana));
    return cubierto / ventana < HOLD_COBERTURA * Math.min(opciones.holds, 2.5);
  };

  const intensidadMedia = (a, b) => {
    const i = analisis.frame(a);
    return media(analisis.intensidad, i, Math.max(analisis.frame(b), i + 1));
  };

  // ¿Suena algún instrumento al que el usuario le dio influencia (en este tramo)?
  const nombres = Object.keys(analisis.capas || {});
  const suenaLoElegido = (a, b) => {
    if (!nombres.length) return true;
    const medio = (a + b) / 2;
    const pesoMaximo = Math.max(...Object.keys(opciones.capas).map((c) => opciones.peso(c))) || 1.0;
    const i = analisis.frame(a);
    const j = Math.max(analisis.frame(b), i + 1);
    return nombres.some((c) => {
      const presencia = analisis.capas[c].presencia;
      return presencia && (opciones.peso(c, medio) / pesoMaximo) * media(presencia, i, j) >= 0.2;
    });
  };

  const rellenar = (a, t0, t1, profundidad = 0) => {
    const maximo = huecoMaximo(analisis, perfil, (t0 + t1) / 2);
    if (t1 - t0 <= maximo * 1.05 || intensidadMedia(t0, t1) < 0.25 || profundidad > 64) return;
    // 1. Hold sobre un sonido sostenido.
    const capaHold = a ? a.capaSostenida() : null;
    if (a && opciones.holds > 0 && profundidad === 0 && cabeHold(a.tiempo)
        && (capaHold === null || opciones.peso(capaHold, a.tiempo) > 0)) {
      const sostenido = analisis.sostenido(a.tiempo, 4.0, capaHold);
      const tope = holdMaximo(perfil, periodo, opciones.holds);
      if (sostenido >= 0.6 * Math.min(t1 - t0, tope) && sostenido >= perfil.holdMinPulsos * periodo) {
        // El hold cubre hasta su largo máximo; lo que sobra se rellena con notas.
        a.holdHasta = Math.min(t1, t0 + Math.min(sostenido, tope));
        holdsRelleno.push([a.tiempo, a.holdHasta]);
        if (t1 - a.holdHasta > maximo) rellenar(null, a.holdHasta, t1, profundidad + 1);
        return;
      }
    }
    // 2. El golpe real más fuerte que quedó afuera dentro del hueco.
    const i0 = bisectIzq(tiemposLibres, t0 + separacion - 1e-6);
    const i1 = bisectIzq(tiemposLibres, t1 - separacion + 1e-6);
    let mejor = null;
    for (let j = i0; j < i1; j++) {
      // Golpes más suaves que los elegidos, pero no roces de capas sin influencia.
      if (usados.has(j) || libres[j].saliencia < Math.max(0.03, 0.4 * piso)) continue;
      const puntaje = libres[j].saliencia + BONO_NIVEL[libres[j].nivel];
      if (mejor === null || puntaje > mejor[0]) mejor = [puntaje, j];
    }
    if (mejor !== null) {
      const j = mejor[1];
      usados.add(j);
      nuevos.push(libres[j]);
      rellenar(null, t0, libres[j].tiempo, profundidad + 1);
      rellenar(libres[j], libres[j].tiempo, t1, profundidad + 1);
      return;
    }
    // 3. Pulsos, solo si la música está claramente sonando (y es música elegida).
    if (intensidadMedia(t0, t1) < 0.45 || !suenaLoElegido(t0, t1)) return;
    const paso = Math.max(1, redondear(maximo / periodo)) * periodo;
    let t = analisis.offset + Math.ceil((t0 + separacion - analisis.offset) / periodo) * periodo;
    while (t < t1 - Math.max(separacion, 0.5 * periodo)) {
      nuevos.push(eventoDePulso(analisis, t));
      t += paso;
    }
  };

  for (let i = 0; i + 1 < seleccion.length; i++) {
    rellenar(seleccion[i], seleccion[i].tiempo, seleccion[i + 1].tiempo);
  }
  return [...seleccion, ...nuevos].sort((a, b) => a.tiempo - b.tiempo);
}

// ---------------------------------------------------------------------------
// 3. Frases de ritmo constante
// ---------------------------------------------------------------------------

export function intervaloMinimo(frase) {
  if (frase.length < 2) return 0;
  let minimo = Infinity;
  for (let i = 1; i < frase.length; i++) minimo = Math.min(minimo, frase[i].tiempo - frase[i - 1].tiempo);
  return minimo;
}

/**
 * Agrupa eventos en frases de velocidad parecida.
 *
 * Una frase admite intervalos entre su mínimo y el doble (una ráfaga con un
 * golpe faltante o un ritmo 3-3-2 siguen siendo la misma frase); se corta en
 * silencios de más de un pulso (dos en frases lentas), cuando el ritmo cambia
 * de velocidad o, en frases largas, al llegar a un tiempo del compás.
 */
export function agruparFrases(eventos, periodo, maximo = 16) {
  const frases = [];
  let actual = [];
  let minimo = null;
  for (const e of eventos) {
    if (actual.length) {
      const dt = e.tiempo - actual[actual.length - 1].tiempo;
      const lenta = minimo !== null && minimo > periodo * 1.01;
      const silencio = dt > periodo * (lenta || minimo === null ? 2.01 : 1.01);
      const cambia = minimo !== null && (dt > 2.01 * minimo || dt < 0.49 * minimo);
      if (silencio || cambia || (actual.length >= maximo && e.nivel <= 1)) {
        frases.push(actual);
        actual = [];
        minimo = null;
      } else {
        minimo = minimo === null ? dt : Math.min(minimo, dt);
      }
    }
    actual.push(e);
  }
  if (actual.length) frases.push(actual);
  return frases;
}

// ---------------------------------------------------------------------------
// Catálogo de patrones (cada patrón: lista de columnas por evento)
// ---------------------------------------------------------------------------

const CELDAS = {
  4: [[0, 1, 2, 3], [3, 2, 1, 0], [0, 2, 1, 3], [3, 1, 2, 0], [0, 1, 3, 2], [1, 0, 2, 3],
    [0, 3, 1, 2], [1, 3, 0, 2]],
  7: [[0, 1, 2, 4, 5, 6], [6, 5, 4, 2, 1, 0], [0, 2, 4, 6, 5, 3, 1], [0, 4, 1, 5, 2, 6],
    [2, 1, 0, 4, 5, 6], [0, 6, 1, 5, 2, 4], [1, 2, 4, 5], [0, 3, 6, 4, 2]],
};
const CELDAS_TERNARIAS = {
  4: [[0, 1, 2], [3, 2, 1], [0, 2, 3], [3, 1, 0], [0, 1, 3, 2, 3, 1]],
  7: [[0, 1, 2], [6, 5, 4], [0, 2, 4], [6, 4, 2], [1, 2, 3, 5, 4, 3]],
};
const JUMPTRILLS = {
  4: [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]],
  7: [[[0, 1], [5, 6]], [[1, 2], [4, 5]], [[0, 2], [4, 6]], [[0, 1, 2], [4, 5, 6]]],
};

function manos(k) {
  const izquierda = [], derecha = [];
  for (let c = 0; c < Math.floor(k / 2); c++) izquierda.push(c);
  for (let c = k - Math.floor(k / 2); c < k; c++) derecha.push(c);
  return [izquierda, derecha];
}

function patronEscalera(n, k, azar) {
  let direccion = azar.random() < 0.5 ? -1 : 1;
  let columna = azar.entero(k);
  const salida = [];
  for (let i = 0; i < n; i++) {
    salida.push([columna]);
    let siguiente = columna + direccion;
    if (siguiente < 0 || siguiente >= k) {
      direccion *= -1;
      siguiente = columna + direccion;
    }
    columna = siguiente;
  }
  return salida;
}

function patronTrino(n, k, azar) {
  const parejas = k === 4
    ? [[1, 2], [0, 3], [0, 1], [2, 3], [0, 2], [1, 3]]
    : [[2, 4], [1, 5], [0, 6], [1, 2], [4, 5], [2, 5], [3, 4]];
  const [a, b] = parejas[azar.entero(parejas.length)];
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? [a] : [b]));
}

function patronCelda(n, k, azar, ternario = false) {
  const celdas = (ternario ? CELDAS_TERNARIAS : CELDAS)[k];
  const celda = celdas[azar.entero(celdas.length)];
  return Array.from({ length: n }, (_, i) => [celda[i % celda.length]]);
}

function patronJumptrill(n, k, azar, acordeMax) {
  const opciones = JUMPTRILLS[k].filter((j) => j[0].length <= acordeMax);
  const [a, b] = opciones[azar.entero(opciones.length)];
  return Array.from({ length: n }, (_, i) => [...(i % 2 === 0 ? a : b)]);
}

function patronBrackets(n, k, azar) {
  const inicio = azar.entero(k - 3);
  const base = [[inicio, inicio + 1], [inicio + 2, inicio + 3], [inicio + 1, inicio + 2]];
  return Array.from({ length: n }, (_, i) => [...base[i % 3]]);
}

function patronChordjack(n, k, azar) {
  const ancla = azar.entero(k);
  const otras = azar.mezclar([...Array(k).keys()].filter((c) => c !== ancla));
  return Array.from({ length: n }, (_, i) => [ancla, otras[i % otras.length]]);
}

function patronManos(n, k, azar, eventos) {
  const [izquierda, derecha] = manos(k);
  let lado = azar.entero(2);
  const salida = [];
  for (let i = 0; i < n; i++) {
    const mano = lado === 0 ? izquierda : derecha;
    let columna;
    if (i > 0 && eventos[i].altura > eventos[i - 1].altura + 0.5) {
      columna = lado === 1 ? mano[mano.length - 1] : mano[Math.min(1, mano.length - 1)];
    } else if (i > 0 && eventos[i].altura < eventos[i - 1].altura - 0.5) {
      columna = lado === 0 ? mano[0] : mano[Math.max(0, mano.length - 2)];
    } else {
      columna = mano[azar.entero(mano.length)];
    }
    salida.push([columna]);
    lado = 1 - lado;
  }
  return salida;
}

/**
 * Dibuja el contorno de la melodía (o del bajo) de forma relativa.
 *
 * Si la nota sube, la columna se mueve a la derecha; si baja, a la izquierda
 * (dos columnas en saltos grandes, si caben). Cada tramo que sube o baja
 * arranca desde una columna que le deje espacio. Una nota repetida rápida se
 * vuelve un trino con la columna vecina.
 */
function patronMelodia(n, k, azar, eventos, jackMin) {
  const alturas = eventos.map((e) => redondear(e.altura));
  if (new Set(alturas).size <= 1) return patronTrino(n, k, azar);
  const saltos = alturas.slice(1).map((h, i) => h - alturas[i]);
  const direcciones = saltos.map(Math.sign);

  // Cuántos movimientos seguidos en `signo` empiezan en el salto i (las repeticiones no cortan).
  const largoTramo = (i, signo) => {
    let largo = 0;
    while (i < direcciones.length && (direcciones[i] === 0 || direcciones[i] === signo)) {
      if (direcciones[i] !== 0) largo++;
      i++;
    }
    return largo;
  };

  const noNulas = direcciones.filter((d) => d !== 0);
  const primera = noNulas.length ? noNulas[0] : 1;
  const largo = largoTramo(0, primera);
  let columna = primera > 0 ? Math.max(0, k - 1 - largo) : Math.min(k - 1, largo);
  if (largo >= k) columna = primera > 0 ? 0 : k - 1;
  const salida = [[columna]];
  let base = columna; // columna "propia" de la nota (sin el desvío del trino)
  saltos.forEach((salto, i) => {
    const previa = salida[salida.length - 1][0];
    if (salto === 0) {
      const dt = eventos[i + 1].tiempo - eventos[i].tiempo;
      if (dt < 2 * jackMin) {
        let vecina = previa + (previa === base && base + 1 < k ? 1 : -1);
        if (previa !== base) vecina = base;
        salida.push([limitar(vecina, 0, k - 1)]);
      } else {
        salida.push([base]);
      }
      return;
    }
    const signo = Math.sign(salto);
    let paso = Math.abs(salto) >= 5 && k > 4 ? 2 : 1;
    if (Math.abs(salto) >= 7 && k === 4) paso = 2;
    let destino = base + signo * paso;
    if (destino < 0 || destino >= k) destino = base + signo;  // el salto grande no cabe: un solo paso
    if (destino < 0 || destino >= k) destino = base - signo;  // tope del teclado: inevitable rebotar
    base = limitar(destino, 0, k - 1);
    salida.push([base]);
  });
  return salida;
}

function espejo(columnas, k) {
  return columnas.map((cols) => cols.map((c) => k - 1 - c).sort((a, b) => a - b));
}

// ---------------------------------------------------------------------------
// 4. Colocación jugable
// ---------------------------------------------------------------------------

class Asignador {
  constructor(analisis, opciones, perfil) {
    this.a = analisis;
    this.o = opciones;
    this.p = perfil;
    this.k = opciones.teclas;
    this.azar = new Azar(opciones.semilla);
    this.ultimo = new Float64Array(this.k).fill(-10);
    this.uso = new Float64Array(this.k);
    this.totalNotas = 0;
    this.finHold = new Float64Array(this.k).fill(-10);
    this.notas = [];
    this.holdsActivos = new Map();
    this.memoria = new Map();
    this.frases = [];
    this.limiteHolds = perfil.nombre === "Easy" && this.k === 4 ? 1 : Math.max(1, Math.floor(this.k / 2));
    this.tiemposEventos = [];
    this.pasoHold = this.a.periodo / (perfil.divisor <= 2 ? 2 : 4);
    this.huecoHold = Math.max(0.06, perfil.jackMin * 0.5); // tras soltar un hold
    this.holdMaximo = holdMaximo(perfil, this.a.periodo, opciones.holds);
    this.holdsHechos = []; // [inicio, fin, columna]
  }

  // -- elección del patrón -------------------------------------------------
  pesosPatrones(frase, dt) {
    const { p, k } = this;
    const pulsos = dt ? dt / this.a.periodo : 1.0;
    const intensidad = media(frase.map((e) => this.a.valor(this.a.intensidad, e.tiempo)));
    const confianza = media(frase.map((e) => e.confianza));
    const movimiento = proporcionMovimiento(frase);
    const agudos = media(frase.map((e) => (e.fuerza("platillos") > Math.max(e.fuerza("bombo"), e.fuerza("caja")) ? 1 : 0)));
    const melodica = media(frase.map((e) => e.melodico));
    const avanzado = p.nombre === "Hard" || p.nombre === "Insane";
    const rapido = pulsos <= 1 / 3 + 0.02;
    const medio = !rapido && pulsos <= 0.5 + 0.02;

    let pesos;
    if (p.nombre === "Easy") {
      pesos = { melodia: 3.0 * (0.3 + confianza), manos: 2.0, escalera: 1.0 };
    } else if (rapido) {
      pesos = { escalera: 2.0, celda: 3.0, trino: 1.0 + 1.5 * Math.max(agudos, 1 - movimiento),
        melodia: 3.0 * confianza * movimiento };
      if (avanzado && intensidad > 0.55 && 2 * dt >= p.jackMin && p.acordeMax >= 2) {
        pesos.jumptrill = p.nombre === "Insane" ? 1.5 : 0.7;
        if (k === 7) pesos.brackets = 1.0;
      }
    } else if (medio) {
      pesos = { celda: 2.0, melodia: 3.5 * confianza * (0.3 + movimiento), manos: 2.0, escalera: 1.0 };
      if (avanzado && intensidad > 0.55 && p.acordeMax >= 2) {
        pesos.jumptrill = 1.0;
        if (k === 7) pesos.brackets = 1.2;
        if (p.nombre === "Insane" && dt >= p.jackMin * 1.1) pesos.chordjack = 1.0;
      }
    } else {
      pesos = { melodia: 3.0 * (0.3 + confianza), manos: 2.0, celda: 1.0 };
    }

    // Una frase llevada por la melodía dibuja su contorno; una llevada por la
    // batería usa patrones rítmicos.
    if ("melodia" in pesos) pesos.melodia *= 0.2 + 4.0 * melodica;
    for (const tipo of ["celda", "trino", "jumptrill", "chordjack", "brackets", "escalera"]) {
      if (tipo in pesos) pesos[tipo] *= 0.3 + 1.7 * (1 - melodica);
    }
    // Los patrones de acordes son percusivos: desaparecen si la percusión está en cero.
    for (const tipo of ["jumptrill", "chordjack", "brackets"]) {
      if (tipo in pesos) pesos[tipo] *= Math.min(1.0, 2 * this.o.percusion);
    }
    return Object.fromEntries(Object.entries(pesos).filter(([, w]) => w > 0));
  }

  generarPatron(tipo, frase, azar) {
    const n = frase.length, k = this.k;
    const dt = intervaloMinimo(frase) || this.a.periodo;
    const ternario = Math.abs(dt / this.a.periodo - 1 / 3) < 0.03;
    switch (tipo) {
      case "escalera": return patronEscalera(n, k, azar);
      case "trino": return patronTrino(n, k, azar);
      case "celda": return patronCelda(n, k, azar, ternario);
      case "jumptrill": return patronJumptrill(n, k, azar, this.p.acordeMax);
      case "brackets": return patronBrackets(n, k, azar);
      case "chordjack": return patronChordjack(n, k, azar);
      case "manos": return patronManos(n, k, azar, frase);
      default: return patronMelodia(n, k, azar, frase, this.p.jackMin);
    }
  }

  patronPara(frase) {
    const n = frase.length;
    const dt = intervaloMinimo(frase);
    const unidad = this.a.periodo / UNIDADES_PULSO;
    const partes = [frase[0].posicion];
    for (let i = 1; i < n; i++) partes.push(redondear((frase[i].tiempo - frase[i - 1].tiempo) / unidad));
    const firma = partes.join(",");
    if (this.memoria.has(firma)) {
      const [tipo, semilla, veces] = this.memoria.get(firma);
      this.memoria.set(firma, [tipo, semilla, veces + 1]);
      const columnas = this.generarPatron(tipo, frase, new Azar(semilla));
      // El contorno no se refleja: subir debe seguir siendo subir.
      if (tipo === "melodia") return [tipo, columnas];
      return [tipo, veces % 2 ? espejo(columnas, this.k) : columnas];
    }
    const melodica = media(frase.map((e) => e.melodico));
    const confianza = media(frase.map((e) => e.confianza));
    const movimiento = proporcionMovimiento(frase);
    let tipo;
    if (n < 3) {
      tipo = "suelta";
    } else if (melodica >= 0.7 && confianza >= 0.25 && movimiento >= 0.3 && this.p.nombre !== "Easy") {
      tipo = "melodia"; // la lleva la melodía o el bajo: se dibuja su contorno
    } else {
      let pesos = this.pesosPatrones(frase, dt);
      if (melodica <= 0.3) delete pesos.melodia; // la lleva la batería: patrones rítmicos
      if (!Object.keys(pesos).length) pesos = { celda: 1.0 };
      const tipos = Object.keys(pesos);
      tipo = tipos[this.azar.elegir(tipos.map((t) => pesos[t]))];
    }
    const semilla = this.azar.entero(1 << 30);
    const columnas = this.generarPatron(tipo === "suelta" ? "melodia" : tipo, frase, new Azar(semilla));
    // Se elige la orientación que mejor empalma con lo anterior (salvo un
    // contorno melódico, que no se refleja).
    const candidatas = tipo === "melodia" ? [columnas] : [columnas, espejo(columnas, this.k)];
    const conflictos = candidatas.map((c) => this.conflictos(frase, c));
    const elegida = conflictos.indexOf(Math.min(...conflictos));
    if (n >= 3) this.memoria.set(firma, [tipo, semilla, elegida]);
    return [tipo, candidatas[elegida]];
  }

  conflictos(frase, columnas) {
    let total = 0;
    for (let i = 0; i < Math.min(4, frase.length, columnas.length); i++) {
      for (const c of columnas[i]) if (!this.libre(c, frase[i].tiempo)) total++;
    }
    return total;
  }

  // -- estado de columnas --------------------------------------------------
  libre(c, t) {
    return this.finHold[c] <= t - this.huecoHold && t - this.ultimo[c] >= this.p.jackMin - 1e-6;
  }

  costoExtra(c, t, cercaDe) {
    let costo = cercaDe !== null ? Math.abs(c - cercaDe) * 0.6 : 0;
    if (t - this.ultimo[c] < this.p.jackMin * 1.8) costo += 1.5;
    if (this.totalNotas > 16) {
      costo += Math.max(0, this.uso[c] / this.totalNotas - 1 / this.k) * this.k * 2.0;
    }
    if (this.k === 7 && c === 3 && (this.p.nombre === "Easy" || this.p.nombre === "Normal")) costo += 0.5;
    return costo + this.azar.uniforme(0, 0.3);
  }

  tamanoAcorde(evento, rapido) {
    const p = this.p;
    if (p.acordeMax <= 1 || evento.nivel > (p.nombre === "Insane" ? 2 : 1)) return 1;
    // Los acordes marcan golpes de bombo y caja, en proporción al peso de la percusión.
    const atribuidas = Object.keys(evento.atribuidas).length ? evento.atribuidas : evento.capas;
    let fuerza = Math.max(atribuidas.bombo ?? 0, 0.85 * (atribuidas.caja ?? 0));
    fuerza *= Math.min(1.0, 2 * this.o.percusion);
    const umbral = { Easy: 0.8, Normal: 0.65, Hard: 0.55, Insane: 0.5 }[p.nombre];
    if (fuerza < umbral) return 1;
    const seccion = this.a.seccionEn(evento.tiempo);
    const intensidad = seccion ? seccion.intensidad : 0.5;
    let extra = (p.acordeMax - 1) * Math.min(1.0, (fuerza - umbral) / (1 - umbral + 1e-6) + 0.3);
    extra *= 0.5 + p.probAcorde + 0.4 * intensidad + (seccion && seccion.kiai ? 0.2 : 0);
    let tamano = 1 + Math.max(1, redondear(extra));
    if (rapido) tamano = Math.min(tamano, this.k === 4 || p.nombre !== "Insane" ? 2 : 3);
    return Math.min(tamano, p.acordeMax);
  }

  colocar(evento, deseadas, tamano) {
    const t = evento.tiempo;
    const colocadas = [];
    const columnasLibres = () => [...Array(this.k).keys()].filter((x) => this.libre(x, t) && !colocadas.includes(x));
    for (const c of deseadas) {
      if (this.libre(c, t) && !colocadas.includes(c)) {
        colocadas.push(c);
        continue;
      }
      const libres = columnasLibres();
      if (libres.length) colocadas.push(minimoPor(libres, (x) => this.costoExtra(x, t, c)));
    }
    if (colocadas.length && colocadas.length < tamano) {
      const [izquierda] = manos(this.k);
      const ancla = colocadas[0];
      // El acorde se reparte entre ambas manos.
      const libres = ordenarPor(columnasLibres(), (x) => this.costoExtra(x, t, null)
        - (izquierda.includes(x) !== izquierda.includes(ancla) ? 0.8 : 0));
      colocadas.push(...libres.slice(0, tamano - colocadas.length));
    }
    return colocadas.sort((a, b) => a - b);
  }

  // -- holds ---------------------------------------------------------------
  liberarHolds(t) {
    for (const [c, nota] of [...this.holdsActivos]) if (nota.fin <= t) this.holdsActivos.delete(c);
  }

  /**
   * Elige dónde soltar un hold que debería durar hasta `objetivo`.
   *
   * Se prefiere soltar justo cuando empieza otra nota (el gesto natural de un
   * LN); si no hay ninguna cerca, en el tiempo más fuerte de la rejilla antes
   * de que se apague el sonido.
   */
  finMusical(t, objetivo, minimo, limite) {
    const a = this.a;
    const tolerancia = 0.5 * a.periodo;
    const i = bisectIzq(this.tiemposEventos, t + minimo - 1e-6);
    const j = bisectIzq(this.tiemposEventos, Math.min(objetivo + tolerancia, t + limite + 1e-6));
    if (j > i) {
      let fin = this.tiemposEventos[j - 1];
      if (this.p.nombre === "Easy") fin -= this.pasoHold; // en Easy no se suelta y se presiona a la vez
      if (fin - t >= minimo - 1e-6) return fin;
    }
    let mejor = null;
    const paso = this.pasoHold;
    let k = Math.floor((Math.min(objetivo, t + limite) - a.offset) / paso + 1e-6);
    for (;;) {
      const fin = a.offset + k * paso;
      if (fin - t < minimo - 1e-6) break;
      const relativo = (fin - a.offset) / a.periodo;
      const fuerza = Math.abs(relativo - Math.round(relativo)) < 1e-6 ? 2
        : Math.abs(2 * relativo - Math.round(2 * relativo)) < 1e-6 ? 1 : 0;
      if (mejor === null || fuerza > mejor[0]) mejor = [fuerza, fin];
      if (fuerza === 2) break;
      k--;
    }
    return mejor ? mejor[1] : null;
  }

  /** Sostiene una de las notas del evento si el plan de holds lo eligió. */
  quizasHold(evento, nuevas) {
    const a = this.a;
    const t = nuevas[0].tiempo;
    if (evento.holdPlan <= t || this.holdsActivos.size >= this.limiteHolds) return;
    // Se prefiere una columna distinta de la del último hold; si la única posible es
    // la misma y el hold anterior fue hace poco, se deja como nota: variedad.
    const anterior = this.holdsHechos.length ? this.holdsHechos[this.holdsHechos.length - 1] : null;
    let candidatas = nuevas.filter((n) => !anterior || n.columna !== anterior[2]);
    if (!candidatas.length) {
      const relleno = evento.holdHasta > t; // cubre un hueco: se aplica igual
      if (!relleno && anterior && t - anterior[1] < 2 * a.periodo) return;
      candidatas = nuevas;
    }
    const nota = candidatas[this.azar.entero(candidatas.length)];
    const minimo = this.p.holdMinPulsos * a.periodo;
    const fin = this.finMusical(nota.tiempo, Math.min(evento.holdPlan, a.duracion - 0.05), minimo, this.holdMaximo);
    if (fin === null) return;
    nota.fin = fin;
    this.finHold[nota.columna] = fin;
    this.holdsActivos.set(nota.columna, nota);
    this.holdsHechos.push([nota.tiempo, fin, nota.columna]);
  }

  /** Si todas las columnas están ocupadas, acorta el hold que termina antes. */
  recortarHold(t) {
    if (!this.holdsActivos.size) return false;
    const [c, nota] = minimoPor([...this.holdsActivos], (par) => par[1].fin);
    const nuevoFin = t - Math.max(this.huecoHold, this.pasoHold);
    nota.fin = nuevoFin - nota.tiempo >= 0.5 * this.a.periodo ? nuevoFin : null;
    this.finHold[c] = nota.fin !== null ? nota.fin : nota.tiempo;
    this.holdsActivos.delete(c);
    return true;
  }

  // -- recorrido -----------------------------------------------------------
  asignar(eventos) {
    const frases = agruparFrases(eventos, this.a.periodo);
    this.tiemposEventos = eventos.map((e) => e.tiempo);
    for (const frase of frases) {
      const [tipo, columnas] = this.patronPara(frase);
      this.frases.push([tipo, frase.length]);
      const dt = intervaloMinimo(frase) || this.a.periodo;
      const rapido = dt <= this.a.periodo / 3 + 1e-3;
      const conAcordes = !["jumptrill", "brackets", "chordjack"].includes(tipo);
      for (let i = 0; i < Math.min(frase.length, columnas.length); i++) {
        const evento = frase[i], deseadas = columnas[i];
        const t = evento.tiempo;
        this.liberarHolds(t);
        const tamano = Math.max(deseadas.length, conAcordes ? this.tamanoAcorde(evento, rapido) : 1);
        let colocadas = this.colocar(evento, deseadas, tamano);
        if (!colocadas.length && this.recortarHold(t)) colocadas = this.colocar(evento, deseadas.slice(0, 1), 1);
        if (!colocadas.length) continue;
        const nuevas = colocadas.map((c) => new Nota(t, c));
        for (const nota of nuevas) {
          this.ultimo[nota.columna] = t;
          this.uso[nota.columna] += 1;
        }
        this.totalNotas += nuevas.length;
        this.notas.push(...nuevas);
        this.quizasHold(evento, nuevas);
      }
    }
    return this.notas;
  }
}

/** Parte de los saltos de la frase que cambian de altura (redondeada a semitonos). */
function proporcionMovimiento(frase) {
  if (frase.length < 2) return 0;
  let cambios = 0;
  for (let i = 1; i < frase.length; i++) {
    if (redondear(frase[i].altura) !== redondear(frase[i - 1].altura)) cambios++;
  }
  return cambios / (frase.length - 1);
}

// ---------------------------------------------------------------------------
// Plan de holds
// ---------------------------------------------------------------------------

/**
 * Decide qué eventos serán holds, mirando toda la canción a la vez.
 *
 * Cada nota que se sostiene recibe un puntaje: cuánto dura de verdad (en su
 * capa), si es del instrumento destacado y si es melódica. Se eligen de mayor
 * a menor respetando un largo máximo, una pausa entre holds, que no haya dos
 * eventos seguidos con hold y un tope de tiempo cubierto por holds. Así los
 * holds caen en las notas más largas y no tapan la canción.
 */
export function planificarHolds(analisis, eventos, perfil, opciones) {
  if (opciones.holds <= 0 || !eventos.length) return;
  const periodo = analisis.periodo;
  const minimo = perfil.holdMinPulsos * periodo;
  const tope = holdMaximo(perfil, periodo, opciones.holds);
  const pausaBase = (HOLD_PAUSA[perfil.nombre] * periodo) / Math.max(1.0, opciones.holds);
  const cobertura = HOLD_COBERTURA * Math.min(opciones.holds, 2.5);
  const ventana = HOLD_VENTANA * periodo;
  const consecutivos = opciones.holds >= 1.8; // estilo LN marcado: se permiten holds seguidos

  const candidatos = []; // [puntaje, índice, duración, forzado]
  eventos.forEach((e, i) => {
    const rapido = [i - 1, i + 1].some((j) => j >= 0 && j < eventos.length
      && Math.abs(eventos[j].tiempo - e.tiempo) > 0 && Math.abs(eventos[j].tiempo - e.tiempo) < periodo / 3 + 1e-3);
    if (e.holdHasta > e.tiempo) {
      // El relleno de huecos lo pidió (ya respetando pausa y cobertura).
      candidatos.push([100.0, i, e.holdHasta - e.tiempo, true]);
      return;
    }
    const capa = e.capaSostenida();
    if (capa !== null && opciones.peso(capa, e.tiempo) > 0) {
      const sostenido = analisis.sostenido(e.tiempo, 4.0, capa);
      // Margen del 15 %: una nota de un pulso que se apaga un poco antes sigue valiendo.
      if (sostenido >= 0.85 * minimo) {
        const duracion = Math.min(Math.max(sostenido, minimo), tope);
        let puntaje = (duracion / periodo) * (0.4 + e.melodico);
        if (capa === e.destacado) puntaje *= 1.5;
        if (rapido) puntaje *= 0.35;
        candidatos.push([puntaje, i, duracion, false]);
        return;
      }
    }
    if (opciones.holds > 1.0) {
      // Estilo LN: también se alargan notas cortas mientras la otra mano toca.
      candidatos.push([0.3 * (opciones.holds - 1.0), i, Math.min(Math.max(minimo, periodo), tope), false]);
    }
  });

  const azar = new Azar(opciones.semilla + 7);
  const ordenados = ordenarPor(candidatos, (c) => -(c[0] + azar.uniforme(0, 0.05)));
  const elegidos = []; // [inicio, fin]
  const indices = new Set();
  for (const [puntaje, i, duracion, forzado] of ordenados) {
    if (puntaje < 0.25) break;
    const e = eventos[i];
    const inicio = e.tiempo, fin = e.tiempo + duracion;
    if (!forzado) {
      const pausa = pausaBase * (e.capaSostenida() === e.destacado ? 0.5 : 1.0);
      if (elegidos.some(([a, f]) => inicio < f + pausa && fin + pausa > a)) continue;
      if (!consecutivos && (indices.has(i - 1) || indices.has(i + 1))) continue;
      let cubierto = 0;
      for (const [a, f] of elegidos) cubierto += Math.max(0, Math.min(f, fin) - Math.max(a, fin - ventana));
      if ((cubierto + duracion) / ventana > cobertura) continue;
    }
    elegidos.push([inicio, fin]);
    indices.add(i);
    e.holdPlan = fin;
  }
}

// ---------------------------------------------------------------------------
// Punto de entrada
// ---------------------------------------------------------------------------

/**
 * Devuelve {teclas, dificultad, perfil, notas, divisorEditor, frases, destacados}.
 * `destacados`: [inicio, fin, capa] por tramos; `frases`: [tipo de patrón, eventos].
 */
export function generarMapa(analisis, opciones) {
  if (!(opciones instanceof OpcionesGeneracion)) opciones = new OpcionesGeneracion(opciones);
  const perfil = obtenerPerfil(opciones.dificultad, opciones.teclas);
  let eventos = construirEventos(analisis, perfil, opciones);
  const tramos = tramosDestacados(analisis, eventos);
  eventos = seleccionarEventos(analisis, eventos, perfil, opciones);
  planificarHolds(analisis, eventos, perfil, opciones);
  const asignador = new Asignador(analisis, opciones, perfil);
  const notas = asignador.asignar(eventos)
    .filter((n) => n.tiempo >= 0 && n.tiempo < analisis.duracion)
    .sort((a, b) => a.tiempo - b.tiempo || a.columna - b.columna);
  return {
    teclas: opciones.teclas,
    dificultad: opciones.dificultad,
    perfil,
    notas,
    divisorEditor: perfil.divisor >= 4 ? 4 : 2,
    frases: asignador.frases,
    destacados: tramos,
  };
}

/** Une los compases seguidos con el mismo instrumento destacado en tramos. */
export function tramosDestacados(analisis, eventos) {
  const duracionCompas = analisis.periodo * analisis.compas;
  const destacados = new Map();
  for (const e of eventos) destacados.set(e.compas, e.destacado);
  const tramos = [];
  for (const [b, capa] of [...destacados].sort((x, y) => x[0] - y[0])) {
    const inicio = Math.max(0, analisis.offset + b * duracionCompas);
    const fin = Math.min(analisis.duracion, analisis.offset + (b + 1) * duracionCompas);
    if (fin <= inicio || capa === null) continue;
    const ultimo = tramos[tramos.length - 1];
    if (ultimo && ultimo[2] === capa && Math.abs(ultimo[1] - inicio) < 1e-6) ultimo[1] = fin;
    else tramos.push([inicio, fin, capa]);
  }
  return tramos;
}
