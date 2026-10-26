// Trabajador clásico que codifica PCM a MP3 con lamejs (LGPL, ver vendor/).
//
// Entrada: {canales: [Float32Array, …], sr, kbps}. Salida: mensajes
// {tipo: "progreso", fraccion} y al final {tipo: "listo", mp3: Uint8Array}.
//
// Un MP3 sin cabecera LAME se decodifica con 1105 muestras de retraso (576 del
// codificador + 529 del decodificador). Se descartan esas muestras al inicio para
// que el audio que suena en osu! quede alineado con las notas.

importScripts("../vendor/lame.min.js");

const RETRASO = 1105;
const BLOQUE = 1152 * 32;

function aEnteros(canal, desde, hasta) {
  const salida = new Int16Array(hasta - desde);
  for (let i = desde; i < hasta; i++) {
    const v = Math.max(-1, Math.min(1, canal[i]));
    salida[i - desde] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return salida;
}

self.onmessage = (evento) => {
  try {
    const { canales, sr, kbps = 192 } = evento.data;
    const estereo = canales.length > 1;
    const codificador = new lamejs.Mp3Encoder(estereo ? 2 : 1, sr, kbps);
    const n = canales[0].length;
    const trozos = [];
    let ultimoAviso = 0;
    for (let i = Math.min(RETRASO, n); i < n; i += BLOQUE) {
      const fin = Math.min(n, i + BLOQUE);
      const izquierdo = aEnteros(canales[0], i, fin);
      const derecho = estereo ? aEnteros(canales[1], i, fin) : izquierdo;
      const trozo = estereo ? codificador.encodeBuffer(izquierdo, derecho) : codificador.encodeBuffer(izquierdo);
      if (trozo.length) trozos.push(new Uint8Array(trozo));
      if (fin - ultimoAviso > sr * 5) {
        ultimoAviso = fin;
        self.postMessage({ tipo: "progreso", fraccion: fin / n });
      }
    }
    const resto = codificador.flush();
    if (resto.length) trozos.push(new Uint8Array(resto));
    const total = trozos.reduce((s, t) => s + t.length, 0);
    const mp3 = new Uint8Array(total);
    let p = 0;
    for (const t of trozos) { mp3.set(t, p); p += t.length; }
    self.postMessage({ tipo: "listo", mp3 }, [mp3.buffer]);
  } catch (error) {
    self.postMessage({ tipo: "error", mensaje: String(error && error.message || error) });
  }
};
