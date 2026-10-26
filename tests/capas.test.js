// El mapa sigue al instrumento destacado y respeta la influencia de cada capa.

import assert from "node:assert/strict";
import { test } from "node:test";

import { perfil } from "../js/motor/dificultades.js";
import { construirEventos, generarMapa, OpcionesGeneracion } from "../js/motor/generador.js";
import { cancionCapas } from "./sintetico.js";
import { analisisDe, distanciaMinima, esHold, promedio } from "./util.js";

const turnos = () => analisisDe("capas", () => cancionCapas());
const mapa = (a, opciones) => generarMapa(a, new OpcionesGeneracion(opciones));
const enParte = (notas, [inicio, fin]) => notas.filter((n) => n.tiempo >= inicio - 0.01 && n.tiempo < fin - 0.01);
const SIN_NOTAS = { bombo: 0, caja: 0, platillos: 0, bajo: 0, melodia: 0 };

test("destacado por parte", () => {
  const { analisis: a, partes } = turnos();
  const eventos = construirEventos(a, perfil("Hard", 4), new OpcionesGeneracion({ teclas: 4, dificultad: "Hard" }));
  const destacados = new Map(eventos.map((e) => [e.compas, e.destacado]));
  const compas = a.periodo * 4;
  const destacadosEn = ([inicio, fin]) => {
    const conjunto = new Set();
    for (let t = inicio; t < fin - 1e-3; t += compas) conjunto.add(destacados.get(Math.round((t - a.offset) / compas)));
    return [...conjunto];
  };
  assert.deepEqual(destacadosEn(partes.bajo), ["bajo"]);
  assert.ok(destacadosEn(partes.bateria).every((c) => ["bombo", "caja", "platillos"].includes(c)));
  assert.deepEqual(destacadosEn(partes.voz), ["melodia"]);
});

test("controles por capa", () => {
  const { analisis: a, partes } = turnos();
  const soloBajo = mapa(a, { teclas: 4, dificultad: "Hard", capas: { ...SIN_NOTAS, bajo: 1 } });
  const soloBateria = mapa(a, { teclas: 4, dificultad: "Hard", capas: { ...SIN_NOTAS, bombo: 1, caja: 1, platillos: 1 } });
  assert.ok(enParte(soloBajo.notas, partes.bajo).length > 3 * enParte(soloBajo.notas, partes.bateria).length);
  assert.ok(enParte(soloBateria.notas, partes.bateria).length > 2 * enParte(soloBateria.notas, partes.bajo).length);
  assert.throws(() => new OpcionesGeneracion({ capas: SIN_NOTAS }));
  assert.throws(() => new OpcionesGeneracion({ capas: { guitarra: 1 } }));
});

test("las notas siguen al bajo", () => {
  const { analisis: a, eventos, partes } = turnos();
  const bajos = eventos.filter((e) => e[1] === "bajo");
  const m = mapa(a, { teclas: 7, dificultad: "Hard" });
  const columnas = new Map();
  for (const n of enParte(m.notas, partes.bajo)) {
    const t = Math.round(n.tiempo * 1e4) / 1e4;
    if (!columnas.has(t)) columnas.set(t, []);
    columnas.get(t).push(n.columna);
  }
  const secuencia = [];
  for (const [t, cols] of [...columnas].sort((x, y) => x[0] - y[0])) {
    const cercano = bajos.reduce((mejor, e) => (Math.abs(e[0] - t) < Math.abs(mejor[0] - t) ? e : mejor));
    assert.ok(Math.abs(cercano[0] - t) < 0.025); // cada nota cae en una nota del bajo
    secuencia.push([promedio(cols), cercano[2]]);
  }
  const acuerdos = [];
  for (let i = 1; i < secuencia.length; i++) {
    const [c1, a1] = secuencia[i - 1], [c2, a2] = secuencia[i];
    if (a2 !== a1) acuerdos.push(Math.sign(c2 - c1) === Math.sign(a2 - a1));
  }
  assert.ok(promedio(acuerdos) >= 0.8, `acuerdo ${promedio(acuerdos)}`); // la columna sube y baja con el bajo
});

for (const dificultad of ["Normal", "Insane"]) {
  test(`los holds siguen a la voz (${dificultad})`, () => {
    const { analisis: a, eventos, partes } = turnos();
    const voces = eventos.filter((e) => e[1] === "voz").map((e) => [e[0], e[2]]);
    const holds = enParte(mapa(a, { teclas: 4, dificultad }).notas, partes.voz).filter(esHold);
    const errores = [];
    for (const [t, duracion] of voces) {
      const candidato = holds.find((n) => Math.abs(n.tiempo - t) < 0.03);
      if (candidato) errores.push(Math.abs(candidato.fin - candidato.tiempo - duracion) / a.periodo);
    }
    const largas = voces.filter(([, d]) => d >= 1.5 * a.periodo);
    const cortas = voces.filter(([, d]) => d < 1.5 * a.periodo);
    const conHold = (lista) => lista.filter(([t]) => holds.some((n) => Math.abs(n.tiempo - t) < 0.03)).length;
    // Los holds van a las notas más largas de la voz, no a las cortas…
    assert.ok(conHold(largas) >= 0.6 * largas.length);
    assert.ok(conHold(cortas) <= 0.25 * cortas.length);
    // …y duran lo que dura la nota cantada.
    assert.ok(promedio(errores) <= 0.5);
  });
}

test("influencia por sección", () => {
  const { analisis: a, eventos, partes } = turnos();
  const [inicio, fin] = partes.bateria;
  const normal = mapa(a, { teclas: 4, dificultad: "Hard" });
  const silencio = mapa(a, { teclas: 4, dificultad: "Hard", capasSecciones: [{ inicio, fin, capas: SIN_NOTAS }] });
  const soloBajo = mapa(a, { teclas: 4, dificultad: "Hard",
    capasSecciones: [{ inicio, fin, capas: { ...SIN_NOTAS, bajo: 1 } }] });
  assert.ok(enParte(normal.notas, partes.bateria).length > 40);
  assert.ok(enParte(silencio.notas, partes.bateria).length <= 2); // la sección queda vacía
  assert.ok(enParte(silencio.notas, partes.voz).length > 20);     // el resto sigue igual
  // Con solo el bajo en la parte de batería, casi no hay notas en los platillos.
  const platillos = eventos.filter((e) => e[1] === "platillo" && e[0] >= inicio && e[0] < fin);
  const golpes = eventos.filter((e) => ["bombo", "caja"].includes(e[1]) && e[0] >= inicio && e[0] < fin).map((e) => e[0]);
  const soloPlatillo = enParte(soloBajo.notas, partes.bateria).filter((n) => distanciaMinima(golpes, n.tiempo) > 0.03);
  assert.ok(soloPlatillo.length < 0.3 * platillos.length);
});
