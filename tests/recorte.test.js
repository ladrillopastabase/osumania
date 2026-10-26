import assert from "node:assert/strict";
import { test } from "node:test";

import { exportarOsu } from "../js/motor/exportador.js";
import { generarMapa } from "../js/motor/generador.js";
import { ajustarACompas, recortarMapa, validarTramo, vistaRecortada } from "../js/motor/recorte.js";
import { cancion } from "./sintetico.js";
import { analisisDe } from "./util.js";

const analisis = () => analisisDe("150-40", () => ({ senal: cancion(150, 40, 0.5) })).analisis;

test("ajustar a compás", () => {
  const a = analisis();
  const compas = a.periodo * 4;
  const t = ajustarACompas(a, 10.3);
  const compases = (t - a.offset) / compas;
  assert.ok(Math.abs(compases - Math.round(compases)) < 1e-6);
  assert.ok(Math.abs(t - 10.3) <= compas / 2);
});

test("vista y mapa recortados", () => {
  const a = analisis();
  const [inicio, fin] = [ajustarACompas(a, 8), ajustarACompas(a, 30)];
  const mapa = generarMapa(a, { teclas: 4, dificultad: "Hard", holds: 2.5 });
  const recortado = recortarMapa(mapa, inicio, fin, a.periodo, 2);
  const vista = vistaRecortada(a, inicio, fin);
  assert.ok(Math.abs(vista.duracion - (fin - inicio)) < 1e-9);
  assert.ok(vista.offset >= 0 && vista.offset < a.periodo * 4);
  assert.equal(vista.periodo, a.periodo);
  // El tiempo fuerte sigue siendo el mismo, solo desplazado.
  const pulsos = (a.offset - inicio - vista.offset) / a.periodo;
  assert.ok(Math.abs(pulsos - Math.round(pulsos)) < 1e-6);
  const originales = mapa.notas.filter((n) => n.tiempo >= inicio && n.tiempo < fin - 1);
  assert.ok(recortado.notas.length && recortado.notas.length >= originales.length);
  for (const n of recortado.notas) {
    assert.ok(n.tiempo >= 0 && n.tiempo < vista.duracion - 0.39);
    assert.ok(n.fin === null || n.fin <= vista.duracion - 0.39);
  }
  const texto = exportarOsu(recortado, vista, {});
  const punto = texto.split("[TimingPoints]")[1].trim().split(/\s+/)[0];
  assert.equal(Number(punto.split(",")[0]), Math.round(vista.offset * 1000));
});

test("tramo demasiado corto", () => {
  assert.throws(() => validarTramo(analisis(), 10, 14), /al menos 10 s/);
});
