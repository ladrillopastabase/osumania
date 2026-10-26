// Validación de jugabilidad y estadísticas de un mapa generado.

import { percentil } from "./dsp.js";

const HUECO_MINIMO_HOLD = 0.03; // s entre soltar un hold y la siguiente nota en la columna

const esHold = (n) => n.fin !== null && n.fin !== undefined;

export function validar(mapa, duracion = null) {
  const errores = [];
  const advertencias = [];
  const { notas, teclas: k, perfil } = mapa;

  for (let i = 1; i < notas.length; i++) {
    if (notas[i].tiempo < notas[i - 1].tiempo) {
      errores.push("Las notas no están ordenadas por tiempo.");
      break;
    }
  }

  const porColumna = Array.from({ length: k }, () => []);
  for (const n of notas) {
    if (!(n.columna >= 0 && n.columna < k)) {
      errores.push(`Columna fuera de rango (${n.columna}) en ${n.tiempo.toFixed(3)}s.`);
      continue;
    }
    if (n.tiempo < 0 || (duracion !== null && n.tiempo > duracion)) {
      errores.push(`Nota fuera de la canción en ${n.tiempo.toFixed(3)}s.`);
    }
    if (esHold(n) && n.fin <= n.tiempo) errores.push(`Hold sin duración en ${n.tiempo.toFixed(3)}s.`);
    porColumna[n.columna].push(n);
  }

  let jacksRapidos = 0;
  porColumna.forEach((lista, c) => {
    for (let i = 1; i < lista.length; i++) {
      const previa = lista[i - 1], actual = lista[i];
      const libreDesde = esHold(previa) ? previa.fin : previa.tiempo;
      if (actual.tiempo <= libreDesde + (esHold(previa) ? HUECO_MINIMO_HOLD : 1e-6)) {
        errores.push(`Notas superpuestas en la columna ${c + 1} (${actual.tiempo.toFixed(3)}s).`);
      } else if (!esHold(previa) && actual.tiempo - previa.tiempo < perfil.jackMin - 1e-6) {
        jacksRapidos++;
      }
    }
  });
  if (jacksRapidos) advertencias.push(`${jacksRapidos} jacks más rápidos que el mínimo de ${perfil.nombre}.`);

  const acordes = new Map();
  if (notas.length) {
    let actual = notas[0].tiempo, tamano = 0;
    for (const n of notas) {
      if (Math.abs(n.tiempo - actual) < 1e-4) {
        tamano++;
      } else {
        acordes.set(tamano, (acordes.get(tamano) ?? 0) + 1);
        actual = n.tiempo;
        tamano = 1;
      }
    }
    acordes.set(tamano, (acordes.get(tamano) ?? 0) + 1);
  }
  const mayorAcorde = acordes.size ? Math.max(...acordes.keys()) : 0;
  if (mayorAcorde > perfil.acordeMax) {
    errores.push(`Acorde de ${mayorAcorde} notas supera el máximo de ${perfil.acordeMax}.`);
  }

  const estadisticas = estadisticasMapa(mapa);
  estadisticas.acordes = Object.fromEntries([...acordes].sort((a, b) => a[0] - b[0]).map(([t, v]) => [String(t), v]));
  const patrones = {};
  for (const [tipo, cantidad] of mapa.frases || []) patrones[tipo] = (patrones[tipo] ?? 0) + cantidad;
  estadisticas.patrones = Object.fromEntries(Object.entries(patrones).sort((a, b) => b[1] - a[1]));
  const largas = (mapa.frases || []).filter(([tipo]) => tipo !== "suelta").map(([, c]) => c);
  estadisticas.largo_frase = largas.length ? +(largas.reduce((s, v) => s + v, 0) / largas.length).toFixed(1) : 0;
  if (!notas.length) errores.push("El mapa no tiene notas.");
  else if (estadisticas.notas < 20) advertencias.push("El mapa tiene muy pocas notas.");

  return { valido: !errores.length, errores: errores.slice(0, 20), advertencias, estadisticas };
}

export function estadisticasMapa(mapa) {
  const { notas, teclas } = mapa;
  if (!notas.length) {
    return { notas: 0, holds: 0, nps_medio: 0, nps_max: 0, columnas: new Array(teclas).fill(0), estrellas_aprox: 0 };
  }
  const inicio = notas[0].tiempo;
  const fin = Math.max(notas[notas.length - 1].tiempo, ...notas.map((n) => n.fin || 0));
  const jugable = Math.max(fin - inicio, 1.0);
  // Notas por ventana de 1 s (como np.histogram con bordes inicio, inicio+1, …).
  const bordes = Math.floor(fin + 1 - inicio - 1e-12) + 1;
  let conteo;
  if (bordes > 1) {
    conteo = new Array(bordes - 1).fill(0);
    const ultimoBorde = inicio + (bordes - 1);
    for (const n of notas) {
      if (n.tiempo > ultimoBorde) continue;
      conteo[Math.min(bordes - 2, Math.floor(n.tiempo - inicio))]++;
    }
  } else {
    conteo = [notas.length];
  }
  const columnas = new Array(teclas).fill(0);
  for (const n of notas) columnas[n.columna]++;
  const exigente = percentil(conteo, 95);
  // Estimación muy gruesa (no es el star rating oficial de osu!).
  const estrellas = 0.42 * exigente ** 0.82 * (1.0 + 0.04 * (teclas - 4));
  return {
    notas: notas.length,
    holds: notas.filter(esHold).length,
    nps_medio: +(notas.length / jugable).toFixed(2),
    nps_max: Math.max(...conteo),
    columnas,
    estrellas_aprox: +estrellas.toFixed(2),
  };
}
