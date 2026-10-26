// Parámetros de cada dificultad para 4K y 7K.
//
//   divisor         subdivisión máxima del pulso (2 = corcheas, 4 = semicorcheas)
//   tresillos       permite rejilla 1/3 donde la música lo pide
//   nps             notas por segundo objetivo en una sección de intensidad media
//   acordeMax       notas simultáneas máximas
//   probAcorde      probabilidad base de convertir un golpe fuerte en acorde
//   probHold        probabilidad base de convertir una nota sostenida en hold
//   holdMinPulsos   duración mínima de un hold, en pulsos
//   separacionMin   tiempo mínimo entre eventos consecutivos (s)
//   jackMin         tiempo mínimo entre dos notas en la misma columna (s)
//   pesoMetrico     cuánto se privilegian los tiempos fuertes frente a los onsets

const campos = ["nombre", "divisor", "tresillos", "nps", "acordeMax", "probAcorde", "probHold",
  "holdMinPulsos", "separacionMin", "jackMin", "pesoMetrico", "od", "hp"];
const crear = (valores) => Object.fromEntries(campos.map((c, i) => [c, valores[i]]));

const BASE = {
  Easy: crear(["Easy", 2, false, 1.6, 1, 0.05, 0.30, 1.0, 0.24, 0.45, 2.0, 5.0, 6.0]),
  Normal: crear(["Normal", 2, false, 3.0, 2, 0.15, 0.26, 1.0, 0.13, 0.28, 1.4, 6.5, 7.0]),
  Hard: crear(["Hard", 4, true, 5.2, 2, 0.25, 0.30, 0.75, 0.075, 0.17, 1.0, 7.5, 7.5]),
  Insane: crear(["Insane", 4, true, 7.8, 3, 0.35, 0.26, 0.5, 0.05, 0.11, 0.8, 8.3, 8.0]),
};

// En 7K hay más columnas: más acordes y algo más de densidad por la misma dificultad.
const AJUSTE_7K = {
  Easy: { acordeMax: 2, probAcorde: 0.10, nps: 1.8 },
  Normal: { acordeMax: 3, probAcorde: 0.22, nps: 3.4 },
  Hard: { acordeMax: 4, probAcorde: 0.32, nps: 6.0 },
  Insane: { acordeMax: 5, probAcorde: 0.42, nps: 9.0 },
};

export const NOMBRES = Object.keys(BASE);

// Modos que osu!mania admite: 1K–10K en un escenario y 12K–18K en dos (co-op).
export const TECLAS_VALIDAS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18];
export const dobleEscenario = (teclas) => teclas > 10;

/**
 * Perfil para cualquier cantidad de teclas. 4K y 7K son los de referencia; el resto
 * se interpola en escala logarítmica (de 7K a 14K crece lo mismo que de 4K a 7K, no el
 * doble): con más columnas caben más notas y acordes, pero las manos son las mismas.
 */
export function perfil(nombre, teclas) {
  if (!(nombre in BASE)) throw new Error(`Dificultad desconocida: ${nombre}`);
  const base = BASE[nombre];
  if (teclas === 4) return Object.freeze({ ...base });
  const siete = AJUSTE_7K[nombre];
  if (teclas === 7) return Object.freeze({ ...base, ...siete });
  const t = Math.log2(teclas / 4) / Math.log2(7 / 4); // 0 en 4K, 1 en 7K
  const acorde = base.acordeMax + t * (siete.acordeMax - base.acordeMax);
  return Object.freeze({
    ...base,
    nps: +(base.nps * (siete.nps / base.nps) ** t).toFixed(2),
    acordeMax: Math.max(1, Math.min(teclas, 8, Math.round(acorde))),
    probAcorde: +Math.min(0.6, Math.max(0, base.probAcorde + t * (siete.probAcorde - base.probAcorde))).toFixed(3),
  });
}
