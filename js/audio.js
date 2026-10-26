// Audio e imágenes en el navegador: decodificación, señal de análisis, recorte con
// fundido, codificación a MP3 (en un trabajador), etiquetas y carátula incrustadas.

export const FRECUENCIA_ANALISIS = 22050;
export const FRECUENCIA_SALIDA = 44100;
const ANCHO_MAXIMO_FONDO = 1920;

/** Decodifica cualquier formato que entienda el navegador a 44,1 kHz. */
export async function decodificar(bytes) {
  const contexto = new OfflineAudioContext(2, 1, FRECUENCIA_SALIDA);
  try {
    // decodeAudioData se queda con el buffer: se le pasa una copia.
    return await contexto.decodeAudioData(bytes.slice(0));
  } catch (error) {
    throw new Error("El navegador no pudo decodificar el audio. Prueba con MP3, WAV, OGG o FLAC.");
  }
}

/** Señal mono a 22 050 Hz normalizada a [-1, 1], la que usa el análisis. */
export async function senalAnalisis(buffer) {
  const largo = Math.ceil(buffer.duration * FRECUENCIA_ANALISIS);
  const contexto = new OfflineAudioContext(1, largo, FRECUENCIA_ANALISIS);
  const fuente = contexto.createBufferSource();
  fuente.buffer = buffer;
  fuente.connect(contexto.destination); // estéreo → mono: promedio de los canales
  fuente.start();
  const senal = (await contexto.startRendering()).getChannelData(0);
  let pico = 0;
  for (let i = 0; i < senal.length; i++) pico = Math.max(pico, Math.abs(senal[i]));
  if (pico > 0) for (let i = 0; i < senal.length; i++) senal[i] /= pico;
  if (senal.length < FRECUENCIA_ANALISIS) throw new Error("El audio dura menos de un segundo.");
  return senal;
}

/**
 * Canales del tramo [inicio, fin) con un fundido de entrada corto y uno de
 * salida de `fundido` segundos (lineales). Sin tramo, la canción entera tal cual.
 */
export function canalesTramo(buffer, inicio = null, fin = null, fundido = 0) {
  const sr = buffer.sampleRate;
  const canales = [];
  const n = Math.min(buffer.numberOfChannels, 2);
  for (let c = 0; c < n; c++) {
    const datos = buffer.getChannelData(c);
    if (inicio === null) {
      canales.push(Float32Array.from(datos));
      continue;
    }
    const a = Math.max(0, Math.round(inicio * sr));
    const b = Math.min(datos.length, Math.round(fin * sr));
    const tramo = datos.slice(a, b);
    const entrada = Math.min(tramo.length, Math.round(0.02 * sr));
    for (let i = 0; i < entrada; i++) tramo[i] *= i / entrada;
    const salida = Math.min(tramo.length, Math.round(fundido * sr));
    for (let i = 0; i < salida; i++) tramo[tramo.length - salida + i] *= 1 - (i + 1) / salida;
    canales.push(tramo);
  }
  return canales;
}

/** Codifica a MP3 en un trabajador (no bloquea la página). */
export function codificarMp3(canales, sr, alAvanzar = null, kbps = 192) {
  return new Promise((resolver, rechazar) => {
    const trabajador = new Worker(new URL("./mp3.js", import.meta.url));
    trabajador.onmessage = (e) => {
      if (e.data.tipo === "progreso") {
        alAvanzar?.(e.data.fraccion);
        return;
      }
      trabajador.terminate();
      if (e.data.tipo === "listo") resolver(e.data.mp3);
      else rechazar(new Error(`No se pudo codificar el MP3: ${e.data.mensaje}`));
    };
    trabajador.onerror = (e) => {
      trabajador.terminate();
      rechazar(new Error(`No se pudo codificar el MP3: ${e.message}`));
    };
    trabajador.postMessage({ canales, sr, kbps }, canales.map((c) => c.buffer));
  });
}

// ---------------------------------------------------------------- etiquetas

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

function textoId3(bytes, codificacion) {
  let texto;
  if (codificacion === 1 || codificacion === 2) {
    let le = codificacion === 1;
    let inicio = 0;
    if (codificacion === 1 && bytes.length >= 2) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) { le = true; inicio = 2; }
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) { le = false; inicio = 2; }
    }
    texto = new TextDecoder(le ? "utf-16le" : "utf-16be").decode(bytes.subarray(inicio));
  } else {
    texto = (codificacion === 3 ? utf8 : latin1).decode(bytes);
  }
  return texto.split("\0")[0].trim();
}

/** Fin de una cadena terminada en cero (dos ceros alineados en UTF-16). */
function finCadena(bytes, desde, codificacion) {
  if (codificacion === 1 || codificacion === 2) {
    for (let i = desde; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    return bytes.length;
  }
  const i = bytes.indexOf(0, desde);
  return i < 0 ? bytes.length : i;
}

const enteroSeguro = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];
const entero32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

function leerId3(b) {
  const resultado = {};
  const version = b[3];
  const banderas = b[5];
  const fin = Math.min(b.length, 10 + enteroSeguro(b, 6));
  let p = 10;
  if (banderas & 0x40 && version >= 3) p += version === 4 ? enteroSeguro(b, 10) : entero32(b, 10) + 4;
  const portadas = [];
  while (p + (version === 2 ? 6 : 10) <= fin) {
    let id, tamano;
    if (version === 2) {
      id = latin1.decode(b.subarray(p, p + 3));
      tamano = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
      p += 6;
    } else {
      id = latin1.decode(b.subarray(p, p + 4));
      tamano = version === 4 ? enteroSeguro(b, p + 4) : entero32(b, p + 4);
      p += 10;
    }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || tamano <= 0 || p + tamano > fin) break;
    const marco = b.subarray(p, p + tamano);
    p += tamano;
    if (id === "TIT2" || id === "TT2") resultado.titulo = textoId3(marco.subarray(1), marco[0]);
    else if (id === "TPE1" || id === "TP1") resultado.artista = textoId3(marco.subarray(1), marco[0]);
    else if (id === "APIC" || id === "PIC") {
      const codificacion = marco[0];
      let q, tipo;
      if (id === "PIC") {
        const formato = latin1.decode(marco.subarray(1, 4)).toLowerCase();
        tipo = formato === "png" ? "image/png" : "image/jpeg";
        q = 4;
      } else {
        const finTipo = marco.indexOf(0, 1);
        tipo = latin1.decode(marco.subarray(1, finTipo)) || "image/jpeg";
        q = finTipo + 1;
      }
      const clase = marco[q];
      q = finCadena(marco, q + 1, codificacion) + (codificacion === 1 || codificacion === 2 ? 2 : 1);
      portadas.push({ clase, tipo: tipo.includes("/") ? tipo : `image/${tipo}`, datos: marco.slice(q) });
    }
  }
  // La portada frontal (tipo 3) si existe; si no, la primera.
  resultado.portada = portadas.find((x) => x.clase === 3) || portadas[0] || null;
  return resultado;
}

function leerFlac(b) {
  const resultado = { portada: null };
  let p = 4;
  for (;;) {
    if (p + 4 > b.length) break;
    const ultimo = b[p] & 0x80, tipo = b[p] & 0x7f;
    const largo = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    const bloque = b.subarray(p + 4, p + 4 + largo);
    p += 4 + largo;
    if (tipo === 4) {
      const vista = new DataView(bloque.buffer, bloque.byteOffset, bloque.length);
      let q = 4 + vista.getUint32(0, true);
      const cantidad = vista.getUint32(q, true);
      q += 4;
      for (let i = 0; i < cantidad && q + 4 <= bloque.length; i++) {
        const l = vista.getUint32(q, true);
        const comentario = utf8.decode(bloque.subarray(q + 4, q + 4 + l));
        q += 4 + l;
        const [clave, ...valor] = comentario.split("=");
        if (clave.toUpperCase() === "TITLE") resultado.titulo = valor.join("=").trim();
        if (clave.toUpperCase() === "ARTIST") resultado.artista = valor.join("=").trim();
      }
    } else if (tipo === 6) {
      const clase = entero32(bloque, 0);
      const largoTipo = entero32(bloque, 4);
      const mime = latin1.decode(bloque.subarray(8, 8 + largoTipo));
      let q = 8 + largoTipo;
      q += 4 + entero32(bloque, q) + 16;
      const largoDatos = entero32(bloque, q);
      const portada = { clase, tipo: mime || "image/jpeg", datos: bloque.slice(q + 4, q + 4 + largoDatos) };
      if (!resultado.portada || clase === 3) resultado.portada = portada;
    }
    if (ultimo) break;
  }
  return resultado;
}

/** {titulo, artista, portada: {tipo, datos} | null} de un MP3 (ID3v2) o FLAC. */
export function leerEtiquetas(bytes) {
  const b = new Uint8Array(bytes);
  try {
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return leerId3(b);
    if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return leerFlac(b);
  } catch (error) {
    // Etiquetas dañadas: se sigue sin ellas.
  }
  return { portada: null };
}

// ---------------------------------------------------------------- imagen

/** Convierte una imagen a JPG de hasta 1920 px de ancho (lo que osu! espera). */
export async function imagenAJpeg(blob) {
  let mapa;
  try {
    mapa = await createImageBitmap(blob);
  } catch (error) {
    return null;
  }
  const escala = Math.min(1, ANCHO_MAXIMO_FONDO / mapa.width);
  const ancho = Math.max(1, Math.round(mapa.width * escala));
  const alto = Math.max(1, Math.round(mapa.height * escala));
  const lienzo = document.createElement("canvas");
  lienzo.width = ancho;
  lienzo.height = alto;
  const ctx = lienzo.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, ancho, alto);
  ctx.drawImage(mapa, 0, 0, ancho, alto);
  mapa.close?.();
  return new Promise((resolver) => lienzo.toBlob((jpg) => resolver(jpg), "image/jpeg", 0.9));
}
