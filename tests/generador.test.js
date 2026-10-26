import assert from "node:assert/strict";
import { test } from "node:test";

import { dobleEscenario, NOMBRES, perfil, TECLAS_VALIDAS } from "../js/motor/dificultades.js";
import { generarMapa, holdMaximo, OpcionesGeneracion } from "../js/motor/generador.js";
import { validar } from "../js/motor/validador.js";
import { cancion, cancionRealista, SECCIONES_SOSTENIDAS } from "./sintetico.js";
import { analisisDe, distanciaMinima, esHold, huecoMaximo, promedio } from "./util.js";

const simple = () => analisisDe("simple", () => ({ senal: cancion(160, 45, 0.4) })).analisis;
const realista = () => analisisDe("realista", () => cancionRealista());
const mapa = (a, opciones) => generarMapa(a, new OpcionesGeneracion(opciones));

for (const teclas of [4, 7]) {
  for (const dificultad of NOMBRES) {
    for (const [percusion, melodia] of [[0.5, 0.5], [1, 0], [0, 1]]) {
      test(`mapa válido ${teclas}K ${dificultad} (${percusion}/${melodia})`, () => {
        const a = simple();
        const m = mapa(a, { teclas, dificultad, percusion, melodia });
        const informe = validar(m, a.duracion);
        assert.ok(informe.valido, informe.errores.join("; "));
        assert.ok(informe.estadisticas.notas > 40);
        assert.ok(m.notas.every((n) => n.columna >= 0 && n.columna < teclas));
      });
    }
  }
  test(`dificultad creciente ${teclas}K`, () => {
    const cantidades = NOMBRES.map((dificultad) => mapa(simple(), { teclas, dificultad }).notas.length);
    assert.deepEqual(cantidades, [...cantidades].sort((a, b) => a - b));
    assert.ok(cantidades.at(-1) > 2 * cantidades[0]);
  });
}

test("notas en la rejilla", () => {
  const a = simple();
  const medio = a.periodo / 2;
  for (const n of mapa(a, { teclas: 4, dificultad: "Normal" }).notas) {
    const pasos = (n.tiempo - a.offset) / medio;
    assert.ok(Math.abs(pasos - Math.round(pasos)) < 1e-6);
  }
});

test("determinista con la semilla", () => {
  const notas = (semilla) => JSON.stringify(mapa(simple(), { teclas: 7, dificultad: "Hard", semilla }).notas);
  assert.equal(notas(3), notas(3));
  assert.notEqual(notas(3), notas(4));
});

test("columnas repartidas", () => {
  const uso = validar(mapa(simple(), { teclas: 4, dificultad: "Hard" })).estadisticas.columnas;
  assert.ok(Math.min(...uso) > 0.6 * Math.max(...uso), uso.join(","));
});

test("hay holds y acordes", () => {
  const m = mapa(simple(), { teclas: 4, dificultad: "Insane", holds: 2 });
  assert.ok(m.notas.some(esHold));
  assert.ok(Object.keys(validar(m).estadisticas.acordes).some((t) => Number(t) > 1));
});

test("Easy 4K sin acordes", () => {
  assert.deepEqual(Object.keys(validar(mapa(simple(), { teclas: 4, dificultad: "Easy" })).estadisticas.acordes), ["1"]);
});

test("opciones inválidas", () => {
  for (const teclas of [0, 11, 13, 19, 4.5]) assert.throws(() => new OpcionesGeneracion({ teclas }));
  assert.throws(() => new OpcionesGeneracion({ percusion: 0, melodia: 0 }));
});

// --- calidad rítmica sobre una canción con ritmo conocido ---------------------

for (const teclas of [4, 7]) {
  for (const dificultad of NOMBRES) {
    test(`sin notas fantasma ${teclas}K ${dificultad}`, () => {
      const { analisis: a, eventos } = realista();
      const verdad = eventos.map((e) => e[0]);
      for (const n of mapa(a, { teclas, dificultad }).notas) {
        // Toda nota coincide con algo que suena, o es relleno justo en el pulso.
        const fase = ((((n.tiempo - a.offset) / a.periodo) % 1) + 1) % 1;
        const enPulso = Math.abs(fase - 0.5) > 0.5 - 1e-4;
        assert.ok(distanciaMinima(verdad, n.tiempo) < 0.025 || enPulso, `nota en ${n.tiempo}`);
      }
    });
  }
}

for (const dificultad of ["Hard", "Insane"]) {
  test(`cubre los golpes y arma patrones largos (${dificultad})`, () => {
    const { analisis: a, eventos } = realista();
    const m = mapa(a, { teclas: 4, dificultad });
    const tiempos = m.notas.map((n) => n.tiempo);
    const fuertes = eventos.filter((e) => e[1] !== "platillo").map((e) => e[0]);
    assert.ok(promedio(fuertes.map((t) => distanciaMinima(tiempos, t) < 0.02)) > 0.9);
    assert.ok(promedio(m.frases.filter(([tipo]) => tipo !== "suelta").map(([, n]) => n)) >= 8);
  });
}

test("un ritmo repetido conserva el ritmo", () => {
  const { analisis: a } = realista();
  const m = mapa(a, { teclas: 4, dificultad: "Hard" });
  const compas = 4 * a.periodo;
  const ritmo = (indice) => {
    const inicio = a.offset + indice * compas;
    return JSON.stringify([...new Set(m.notas.filter((n) => n.tiempo >= inicio - 1e-3 && n.tiempo < inicio + compas - 1e-3)
      .map((n) => Math.round((n.tiempo - inicio) / (a.periodo / 4))))].sort((x, y) => x - y));
  };
  const coro = [13, 14, 15, 16, 17, 18].map(ritmo);
  assert.ok(coro.slice(1).filter((r, i) => r === coro[i]).length >= 4);
});

test("controles de percusión y melodía", () => {
  const { analisis: a, eventos } = realista();
  const melodia = eventos.filter((e) => e[1] === "melodia").map((e) => e[0]);
  const soloBateria = eventos.filter((e) => e[1] !== "melodia" && distanciaMinima(melodia, e[0]) > 0.03).map((e) => e[0]);
  const medir = (percusion, pesoMelodia) => {
    const m = mapa(a, { teclas: 4, dificultad: "Hard", percusion, melodia: pesoMelodia });
    const tiempos = [...new Set(m.notas.map((n) => n.tiempo))];
    return [promedio(tiempos.map((t) => distanciaMinima(soloBateria, t) < 0.025)), m.notas.length - tiempos.length];
  };
  const [bateriaP, acordesP] = medir(1, 0);
  const [bateriaM, acordesM] = medir(0, 1);
  assert.ok(bateriaP > 2 * bateriaM);
  assert.equal(acordesM, 0);
  assert.ok(acordesP > 20);
});

test("capas detectadas", () => {
  const { analisis: a, eventos } = realista();
  assert.deepEqual(Object.keys(a.capas).sort(), ["bajo", "bombo", "caja", "melodia", "platillos"]);
  const bombos = eventos.filter((e) => e[1] === "bombo").map((e) => e[0]);
  const capa = a.capas.bombo;
  const fuertes = Array.from(capa.onsets).filter((_, i) => capa.fuerzas[i] > 0.25);
  assert.ok(promedio(bombos.map((t) => distanciaMinima(fuertes, t) < 0.03)) > 0.95);
  assert.ok(promedio(fuertes.map((t) => distanciaMinima(bombos, t) < 0.03)) > 0.9);
});

// --- huecos, clímax y holds ---------------------------------------------------

for (const dificultad of ["Normal", "Hard", "Insane"]) {
  test(`sin huecos con música (${dificultad})`, () => {
    const { analisis: a } = realista();
    const m = mapa(a, { teclas: 4, dificultad });
    const inicio = a.offset + 16 * a.periodo; // después de la intro
    assert.ok(huecoMaximo(m, inicio, a.duracion - 1.5) <= 2.05 * a.periodo);
  });

  test(`control de holds (${dificultad})`, () => {
    const { analisis: a } = realista();
    const proporcion = (holds) => {
      const m = mapa(a, { teclas: 4, dificultad, holds });
      assert.ok(validar(m, a.duracion).valido);
      return m.notas.filter(esHold).length / m.notas.length;
    };
    const [sin, normal, ln] = [proporcion(0), proporcion(1), proporcion(2.5)];
    assert.equal(sin, 0);
    assert.ok(normal > 0 && normal < ln);
    assert.ok(ln >= 0.05);
  });
}

test("un coro sostenido no queda vacío", () => {
  const { analisis: a } = analisisDe("sostenida", () => cancionRealista({ secciones: SECCIONES_SOSTENIDAS }));
  const paso = a.periodo / 4;
  const inicioCoro = 0.6 + 12 * 16 * paso;
  const finCoro = inicioCoro + 8 * 16 * paso;
  const m = mapa(a, { teclas: 4, dificultad: "Hard" });
  assert.ok(huecoMaximo(m, inicioCoro, finCoro) <= 1.05 * a.periodo);
  assert.ok(m.notas.filter((n) => esHold(n) && n.tiempo >= inicioCoro && n.tiempo < finCoro).length >= 4);
});

test("los holds terminan en puntos musicales", () => {
  const { analisis: a } = realista();
  for (const dificultad of ["Normal", "Hard", "Insane"]) {
    const m = mapa(a, { teclas: 4, dificultad, holds: 2 });
    const inicios = [...new Set(m.notas.map((n) => n.tiempo))];
    const bien = m.notas.filter(esHold).map((n) => {
      const r = (n.fin - a.offset) / (a.periodo / 2);
      return distanciaMinima(inicios, n.fin) < 1e-3 || Math.abs(r - Math.round(r)) < 1e-3;
    });
    assert.ok(promedio(bien) >= 0.95);
  }
});

for (const dificultad of NOMBRES) {
  test(`holds variados y acotados (${dificultad})`, () => {
    const { analisis: a } = realista();
    const m = mapa(a, { teclas: 4, dificultad });
    const holds = m.notas.filter(esHold);
    const tope = holdMaximo(perfil(dificultad, 4), a.periodo, 1);
    assert.ok(holds.every((n) => n.fin - n.tiempo <= tope + 1e-6));
    let activo = 0, total = 0;
    for (let t = m.notas[0].tiempo; t < m.notas.at(-1).tiempo; t += 0.01) {
      total++;
      if (holds.some((n) => t >= n.tiempo && t < n.fin)) activo++;
    }
    assert.ok(activo / total <= 0.35); // la mayor parte del tiempo no hay un hold apretado
    const conHold = new Set(holds.map((n) => n.tiempo));
    let racha = 0, maxima = 0;
    for (const t of [...new Set(m.notas.map((n) => n.tiempo))]) {
      racha = conHold.has(t) ? racha + 1 : 0;
      maxima = Math.max(maxima, racha);
    }
    assert.ok(maxima <= 2); // nunca una seguidilla de holds
  });
}

// --- cualquier cantidad de teclas (1K–10K, 12K–18K) ------------------------------

for (const teclas of TECLAS_VALIDAS.filter((k) => k !== 4 && k !== 7)) {
  test(`mapas válidos en ${teclas}K`, () => {
    const { analisis: a } = realista();
    const cantidades = [];
    for (const dificultad of NOMBRES) {
      const m = mapa(a, { teclas, dificultad });
      const informe = validar(m, a.duracion);
      assert.ok(informe.valido, `${dificultad}: ${informe.errores.join("; ")}`);
      assert.ok(m.notas.every((n) => Number.isInteger(n.columna) && n.columna >= 0 && n.columna < teclas));
      assert.ok(Math.max(...Object.keys(informe.estadisticas.acordes).map(Number)) <= perfil(dificultad, teclas).acordeMax);
      cantidades.push(new Set(m.notas.map((n) => n.tiempo)).size);
      if (teclas >= 4 && dificultad !== "Easy") {
        // Se usa todo el teclado, no solo una parte.
        assert.ok(informe.estadisticas.columnas.every((v) => v > 0), `${dificultad}: ${informe.estadisticas.columnas}`);
      }
    }
    assert.ok(cantidades[3] > cantidades[0], cantidades.join(","));
  });
}

test("perfiles: 4K y 7K de referencia, el resto crece con las teclas", () => {
  assert.equal(perfil("Insane", 4).acordeMax, 3);
  assert.equal(perfil("Insane", 7).acordeMax, 5);
  assert.equal(perfil("Hard", 7).nps, 6.0);
  for (const nombre of NOMBRES) {
    const nps = TECLAS_VALIDAS.map((k) => perfil(nombre, k).nps);
    assert.deepEqual(nps, [...nps].sort((x, y) => x - y));
    for (const k of TECLAS_VALIDAS) assert.ok(perfil(nombre, k).acordeMax <= Math.min(k, 8));
  }
  assert.ok(dobleEscenario(12) && !dobleEscenario(10));
});
