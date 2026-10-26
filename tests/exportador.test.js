import assert from "node:assert/strict";
import { test } from "node:test";

import { leerEtiquetas } from "../js/audio.js";
import { exportarOsu, leerHitobjects, nombreArchivo, posicionX } from "../js/motor/exportador.js";
import { generarMapa } from "../js/motor/generador.js";
import { crc32, partesZip } from "../js/zip.js";
import { cancion } from "./sintetico.js";
import { analisisDe } from "./util.js";

const analisis = () => analisisDe("150", () => ({ senal: cancion(150, 30, 0.5) })).analisis;

for (const teclas of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18]) {
  test(`posición x ida y vuelta (${teclas}K)`, () => {
    for (let c = 0; c < teclas; c++) assert.equal(Math.floor((posicionX(c, teclas) * teclas) / 512), c);
  });

  if (![4, 7, 18].includes(teclas)) continue;
  test(`.osu válido (${teclas}K)`, () => {
    const a = analisis();
    const mapa = generarMapa(a, { teclas, dificultad: "Hard", holds: 2 });
    const texto = exportarOsu(mapa, a, { titulo: "Canción", artista: "Artista" });
    assert.ok(texto.startsWith("osu file format v14"));
    assert.ok(texto.includes("Mode: 3"));
    assert.ok(texto.includes(`CircleSize:${teclas}`));
    assert.ok(texto.includes(`Version:${teclas}K Hard`));
    assert.ok(texto.includes("Title:Cancion\r\nTitleUnicode:Canción"));
    const puntos = texto.split("[TimingPoints]")[1].split("[HitObjects]")[0].trim().split(/\s+/);
    assert.ok(Math.abs(Number(puntos[0].split(",")[1]) - 400) < 1e-6);
    const leidos = leerHitobjects(texto, teclas);
    assert.equal(leidos.length, mapa.notas.length);
    leidos.forEach(([t, c, fin], i) => {
      const nota = mapa.notas[i];
      assert.equal(t, Math.round(nota.tiempo * 1000));
      assert.equal(c, nota.columna);
      assert.equal(fin === null, nota.fin === null);
    });
  });
}

test("nombre de archivo sin caracteres prohibidos ni acentos", () => {
  assert.equal(nombreArchivo({ titulo: 'Ñandú: "sí"', artista: "AC/DC" }, "4K Easy"),
    "ACDC - Nandu si (Generador osu!mania) [4K Easy].osu");
});

/** Lee un zip sin compresión: {nombre: bytes}, comprobando los CRC. */
function leerZip(bytes) {
  const vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const fin = bytes.length - 22;
  assert.equal(vista.getUint32(fin, true), 0x06054b50);
  const cantidad = vista.getUint16(fin + 10, true);
  let p = vista.getUint32(fin + 16, true);
  const archivos = {};
  for (let i = 0; i < cantidad; i++) {
    assert.equal(vista.getUint32(p, true), 0x02014b50);
    const crc = vista.getUint32(p + 16, true);
    const tamano = vista.getUint32(p + 20, true);
    const largoNombre = vista.getUint16(p + 28, true);
    const nombre = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + largoNombre));
    const local = vista.getUint32(p + 42, true);
    assert.equal(vista.getUint32(local, true), 0x04034b50);
    const inicio = local + 30 + vista.getUint16(local + 26, true);
    const datos = bytes.subarray(inicio, inicio + tamano);
    assert.equal(crc32(datos), crc);
    archivos[nombre] = datos;
    p += 46 + largoNombre;
  }
  return archivos;
}

test("crc32 conocido", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test(".osz con audio, fondo y mapas", () => {
  const a = analisis();
  const contenido = exportarOsu(generarMapa(a, { teclas: 4, dificultad: "Easy" }), a, {}, "audio.mp3", "fondo.jpg");
  const partes = partesZip([
    { nombre: "audio.mp3", datos: new Uint8Array([0x49, 0x44, 0x33]) },
    { nombre: "fondo.jpg", datos: new Uint8Array(1000).fill(7) },
    { nombre: "Ñandú [4K Easy].osu", datos: contenido },
  ]);
  const total = partes.reduce((s, x) => s + x.length, 0);
  const zip = new Uint8Array(total);
  let p = 0;
  for (const x of partes) { zip.set(x, p); p += x.length; }
  const archivos = leerZip(zip);
  assert.deepEqual(Object.keys(archivos), ["audio.mp3", "fondo.jpg", "Ñandú [4K Easy].osu"]);
  assert.equal(new TextDecoder().decode(archivos["Ñandú [4K Easy].osu"]), contenido);
  assert.ok(contenido.includes('0,0,"fondo.jpg",0,0'));
});

// --- etiquetas incrustadas ----------------------------------------------------

const bytesDe = (...partes) => {
  const total = partes.reduce((s, x) => s + x.length, 0);
  const salida = new Uint8Array(total);
  let p = 0;
  for (const x of partes) { salida.set(x, p); p += x.length; }
  return salida;
};
const ascii = (texto) => new TextEncoder().encode(texto);
const be32 = (v) => new Uint8Array([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);

function marcoId3(id, cuerpo) {
  return bytesDe(ascii(id), be32(cuerpo.length), new Uint8Array(2), cuerpo);
}

test("etiquetas ID3v2.3: título UTF-16, artista y portada frontal", () => {
  const titulo = bytesDe(new Uint8Array([1, 0xff, 0xfe]),
    new Uint8Array([...("Ñandú")].flatMap((c) => [c.charCodeAt(0), 0])), new Uint8Array([0, 0]));
  const artista = bytesDe(new Uint8Array([3]), ascii("Artista"));
  const imagen = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
  const otra = bytesDe(new Uint8Array([0]), ascii("image/png\0"), new Uint8Array([0]), ascii("x\0"), new Uint8Array([9]));
  const portada = bytesDe(new Uint8Array([0]), ascii("image/jpeg\0"), new Uint8Array([3]), ascii("desc\0"), imagen);
  const marcos = bytesDe(marcoId3("TIT2", titulo), marcoId3("TPE1", artista), marcoId3("APIC", otra), marcoId3("APIC", portada));
  const n = marcos.length;
  const cabecera = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
  const etiquetas = leerEtiquetas(bytesDe(cabecera, marcos, new Uint8Array(100)).buffer);
  assert.equal(etiquetas.titulo, "Ñandú");
  assert.equal(etiquetas.artista, "Artista");
  assert.equal(etiquetas.portada.tipo, "image/jpeg");
  assert.deepEqual([...etiquetas.portada.datos], [...imagen]);
});

test("etiquetas FLAC: comentarios Vorbis y bloque PICTURE", () => {
  const comentarios = ["TITLE=Canción", "artist=Grupo"].map((c) => ascii(c));
  const le32 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24]);
  const vorbis = bytesDe(le32(3), ascii("abc"), le32(2), ...comentarios.flatMap((c) => [le32(c.length), c]));
  const imagen = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const foto = bytesDe(be32(3), be32(9), ascii("image/png"), be32(0), new Uint8Array(16), be32(imagen.length), imagen);
  const bloque = (tipo, datos, ultimo) => bytesDe(new Uint8Array([(ultimo ? 0x80 : 0) | tipo,
    (datos.length >> 16) & 255, (datos.length >> 8) & 255, datos.length & 255]), datos);
  const flac = bytesDe(ascii("fLaC"), bloque(0, new Uint8Array(34)), bloque(4, vorbis), bloque(6, foto, true));
  const etiquetas = leerEtiquetas(flac.buffer);
  assert.equal(etiquetas.titulo, "Canción");
  assert.equal(etiquetas.artista, "Grupo");
  assert.equal(etiquetas.portada.tipo, "image/png");
  assert.deepEqual([...etiquetas.portada.datos], [...imagen]);
});

test("sin etiquetas", () => {
  assert.deepEqual(leerEtiquetas(new Uint8Array([1, 2, 3, 4]).buffer), { portada: null });
});
