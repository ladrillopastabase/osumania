// Descarga desde YouTube a través del ayudante (ayudante/youtube.py), que corre
// yt-dlp en el equipo del usuario o en un servidor propio. La página sola no puede:
// YouTube no permite leer su audio desde otra web (CORS) y cifra los enlaces.

export const AYUDANTE_LOCAL = "http://127.0.0.1:8787";
const CLAVE_SERVIDOR = "servidorYoutube";
const DOMINIOS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

export function esUrlYoutube(texto) {
  try {
    const url = new URL(String(texto).trim());
    return ["http:", "https:"].includes(url.protocol) && DOMINIOS.has(url.hostname.toLowerCase());
  } catch (error) {
    return false;
  }
}

export function servidorGuardado() {
  try { return localStorage.getItem(CLAVE_SERVIDOR) || ""; } catch (error) { return ""; }
}

export function guardarServidor(url) {
  try {
    if (url) localStorage.setItem(CLAVE_SERVIDOR, url);
    else localStorage.removeItem(CLAVE_SERVIDOR);
  } catch (error) { /* sin almacenamiento: dura lo que dure la página */ }
}

const limpiar = (url) => url.trim().replace(/\/+$/, "");

/** Candidatos en orden: el ayudante local y, si hay, el servidor propio. */
function candidatos() {
  const lista = [{ base: AYUDANTE_LOCAL, espera: 3000 }];
  const propio = limpiar(servidorGuardado());
  // Un servidor gratuito dormido tarda en despertar: se le da más tiempo.
  if (propio && propio !== AYUDANTE_LOCAL) lista.push({ base: propio, espera: 60000 });
  return lista;
}

let encontrado = null;

/** Devuelve {base, version} del primer ayudante que responde, o null. */
export async function buscarAyudante(alProbar = null) {
  for (const { base, espera } of candidatos()) {
    alProbar?.(base);
    try {
      const respuesta = await fetch(`${base}/estado`, { signal: AbortSignal.timeout(espera) });
      const datos = await respuesta.json();
      if (respuesta.ok && datos.ok) {
        encontrado = { base, version: datos.version, js: datos.js || [] };
        return encontrado;
      }
    } catch (error) {
      // no responde: se prueba el siguiente
    }
  }
  encontrado = null;
  return null;
}

async function errorDe(respuesta) {
  try {
    return (await respuesta.json()).error || `Error ${respuesta.status}`;
  } catch (error) {
    return `Error ${respuesta.status}`;
  }
}

/** Lee el cuerpo informando el avance (si se conoce el tamaño). */
async function leerConAvance(respuesta, alAvanzar) {
  const total = Number(respuesta.headers.get("Content-Length")) || 0;
  if (!respuesta.body) return new Uint8Array(await respuesta.arrayBuffer());
  const lector = respuesta.body.getReader();
  const trozos = [];
  let recibido = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    trozos.push(value);
    recibido += value.length;
    if (total) alAvanzar?.(Math.min(1, recibido / total));
  }
  return new Uint8Array(await new Blob(trozos).arrayBuffer());
}

/**
 * Baja el audio de un video. Devuelve {archivo: File, titulo, artista, miniatura: Blob | null}.
 * `alAvanzar(etapa, fraccion)` informa: "buscando", "descargando" (el ayudante baja
 * el audio de YouTube) y "recibiendo" (la página lo recibe del ayudante).
 */
export async function descargarDeYoutube(url, alAvanzar = null) {
  if (!esUrlYoutube(url)) throw new Error("El enlace no es de YouTube.");
  const ayudante = encontrado || (alAvanzar?.("buscando", null), await buscarAyudante());
  if (!ayudante) {
    throw new Error("No se encontró el ayudante de YouTube. Ábrelo en tu computador (ver «Cómo activar la descarga de YouTube») o sube el audio.");
  }
  const consulta = `url=${encodeURIComponent(url.trim())}`;
  alAvanzar?.("descargando", null);
  let respuesta;
  try {
    respuesta = await fetch(`${ayudante.base}/audio?${consulta}`);
  } catch (error) {
    encontrado = null;
    throw new Error("Se perdió la conexión con el ayudante de YouTube. ¿Sigue abierto?");
  }
  if (!respuesta.ok) throw new Error(await errorDe(respuesta));
  let meta = {};
  try { meta = JSON.parse(decodeURIComponent(respuesta.headers.get("X-Metadatos") || "{}")); } catch (error) { /* sin metadatos */ }
  const bytes = await leerConAvance(respuesta, (f) => alAvanzar?.("recibiendo", f));
  const extension = meta.extension || "m4a";
  const tipo = respuesta.headers.get("Content-Type") || "audio/mp4";
  const nombre = `${meta.artista ? `${meta.artista} - ` : ""}${meta.titulo || "YouTube"}.${extension}`;
  let miniatura = null;
  if (meta.miniatura) {
    try {
      const imagen = await fetch(`${ayudante.base}/miniatura?${consulta}`);
      if (imagen.ok) miniatura = await imagen.blob();
    } catch (error) { /* sin miniatura: se usa la carátula, si hay */ }
  }
  return { archivo: new File([bytes], nombre, { type: tipo }), titulo: meta.titulo, artista: meta.artista, miniatura };
}
