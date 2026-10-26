// Archivo ZIP sin compresión (método "store"): suficiente para un .osz, ya que
// el audio y la imagen ya vienen comprimidos.

const TABLA_CRC = (() => {
  const tabla = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c >>> 0;
  }
  return tabla;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function fechaDos(fecha) {
  const hora = (fecha.getHours() << 11) | (fecha.getMinutes() << 5) | (fecha.getSeconds() >> 1);
  const dia = ((Math.max(1980, fecha.getFullYear()) - 1980) << 9) | ((fecha.getMonth() + 1) << 5) | fecha.getDate();
  return [hora, dia];
}

/**
 * `archivos`: [{nombre, datos}] con `datos` como Uint8Array o texto (se guarda en UTF-8).
 * Devuelve las partes del zip (Uint8Array) para armar un Blob o escribir a disco.
 */
export function partesZip(archivos, fecha = new Date()) {
  const codificador = new TextEncoder();
  const [hora, dia] = fechaDos(fecha);
  const partes = [];
  const central = [];
  let desplazamiento = 0;
  for (const archivo of archivos) {
    const nombre = codificador.encode(archivo.nombre);
    const datos = typeof archivo.datos === "string" ? codificador.encode(archivo.datos) : archivo.datos;
    const crc = crc32(datos);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // nombres en UTF-8
    local.setUint16(8, 0, true);
    local.setUint16(10, hora, true);
    local.setUint16(12, dia, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, datos.length, true);
    local.setUint32(22, datos.length, true);
    local.setUint16(26, nombre.length, true);
    local.setUint16(28, 0, true);
    partes.push(new Uint8Array(local.buffer), nombre, datos);

    const entrada = new DataView(new ArrayBuffer(46));
    entrada.setUint32(0, 0x02014b50, true);
    entrada.setUint16(4, 20, true);
    entrada.setUint16(6, 20, true);
    entrada.setUint16(8, 0x0800, true);
    entrada.setUint16(10, 0, true);
    entrada.setUint16(12, hora, true);
    entrada.setUint16(14, dia, true);
    entrada.setUint32(16, crc, true);
    entrada.setUint32(20, datos.length, true);
    entrada.setUint32(24, datos.length, true);
    entrada.setUint16(28, nombre.length, true);
    entrada.setUint32(42, desplazamiento, true);
    central.push(new Uint8Array(entrada.buffer), nombre);
    desplazamiento += 30 + nombre.length + datos.length;
  }
  const tamanoCentral = central.reduce((s, p) => s + p.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(8, archivos.length, true);
  fin.setUint16(10, archivos.length, true);
  fin.setUint32(12, tamanoCentral, true);
  fin.setUint32(16, desplazamiento, true);
  return [...partes, ...central, new Uint8Array(fin.buffer)];
}

export function crearZip(archivos) {
  return new Blob(partesZip(archivos), { type: "application/octet-stream" });
}
