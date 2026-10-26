import assert from "node:assert/strict";
import { test } from "node:test";

import { analizar } from "../js/motor/analisis.js";
import { cancion, clics } from "./sintetico.js";

for (const [bpm, offset] of [[128, 0.3], [150, 0.5], [174, 1.0], [200, 0.4]]) {
  test(`detecta BPM y fase (${bpm} BPM)`, () => {
    const a = analizar(cancion(bpm, 30, offset));
    assert.ok(Math.abs(a.bpm - bpm) <= 0.05, `BPM ${a.bpm}`);
    const periodo = 60 / bpm;
    const fase = ((((a.offset - offset) / periodo) % 1) + 1) % 1;
    assert.ok(Math.min(fase, 1 - fase) * periodo < 0.010); // menos de 10 ms
  });
}

test("el offset cae en el tiempo fuerte", () => {
  const a = analizar(cancion(150, 30, 0.5));
  const compas = (4 * 60) / 150;
  const distancia = ((((a.offset - 0.5) / compas) % 1) + 1) % 1;
  assert.ok(Math.min(distancia, 1 - distancia) * compas < 0.010);
});

test("onsets precisos", () => {
  const tiempos = [];
  for (let t = 0.5; t < 15; t += 0.37) tiempos.push(t);
  const a = analizar(clics(tiempos, 16));
  assert.equal(a.onsets.length, tiempos.length);
  for (const t of tiempos) {
    const error = Math.min(...Array.from(a.onsets, (o) => Math.abs(o - t)));
    assert.ok(error < 0.012, `error ${error}`);
  }
});

test("BPM forzado", () => {
  assert.equal(analizar(cancion(150, 20, 0.5), { bpm: 75 }).bpm, 75);
});

test("resumen serializable", () => {
  const a = analizar(cancion(140, 20, 0.2));
  const resumen = JSON.parse(JSON.stringify(a.resumen()));
  assert.equal(resumen.secciones[0].inicio, 0);
  assert.ok(Math.abs(resumen.secciones.at(-1).fin - a.duracion) < 1e-3);
  assert.deepEqual(Object.keys(resumen.capas), ["bombo", "caja", "platillos", "bajo", "melodia"]);
});
