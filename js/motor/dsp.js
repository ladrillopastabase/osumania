// Utilidades numéricas: FFT real, ventanas, filtros 1D/2D (con el mismo borde
// "reflect" que scipy.ndimage), percentiles y estadísticas básicas.

export function hann(n) {
  // Ventana de Hann simétrica, igual que numpy.hanning.
  const w = new Float64Array(n);
  if (n === 1) { w[0] = 1; return w; }
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** FFT compleja radix-2 en el lugar (n potencia de 2). */
export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error("FFT: n debe ser potencia de 2");
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    let bits = 0;
    while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  transformar(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let tam = 2; tam <= n; tam <<= 1) {
      const mitad = tam >> 1;
      const paso = n / tam;
      for (let i = 0; i < n; i += tam) {
        for (let j = 0, k = 0; j < mitad; j++, k += paso) {
          const a = i + j, b = a + mitad;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
          const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

/**
 * FFT de una señal real de largo n usando una FFT compleja de n/2.
 * Devuelve |X[k]|² en `potencia` (n/2 + 1 valores).
 */
export class FFTReal {
  constructor(n) {
    this.n = n;
    this.m = n / 2;
    this.fft = new FFT(this.m);
    this.re = new Float64Array(this.m);
    this.im = new Float64Array(this.m);
    this.cos = new Float64Array(this.m);
    this.sin = new Float64Array(this.m);
    for (let k = 0; k < this.m; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
  }

  potencia(x, salida) {
    const { m, re, im } = this;
    for (let i = 0; i < m; i++) { re[i] = x[2 * i]; im[i] = x[2 * i + 1]; }
    this.fft.transformar(re, im);
    salida[0] = (re[0] + im[0]) ** 2;
    salida[m] = (re[0] - im[0]) ** 2;
    for (let k = 1; k < m; k++) {
      const zr = re[k], zi = im[k], cr = re[m - k], ci = -im[m - k];
      const er = 0.5 * (zr + cr), ei = 0.5 * (zi + ci);   // parte par
      const or = 0.5 * (zi - ci), oi = -0.5 * (zr - cr);  // parte impar (÷ i)
      // X[k] = E + e^{-2πik/n} O
      const xr = er + this.cos[k] * or + this.sin[k] * oi;
      const xi = ei + this.cos[k] * oi - this.sin[k] * or;
      salida[k] = xr * xr + xi * xi;
    }
    return salida;
  }
}

/** Autocorrelación normalizada (como la versión por FFT de numpy). */
export function autocorrelacion(x) {
  let n = 1;
  while (n < 2 * x.length) n <<= 1;
  const fft = new FFT(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  fft.transformar(re, im);
  for (let i = 0; i < n; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  // IFFT de un espectro real y simétrico = FFT / n
  fft.transformar(re, im);
  const ac = new Float64Array(x.length);
  const cero = re[0] / n + 1e-9;
  for (let i = 0; i < x.length; i++) ac[i] = re[i] / n / cero;
  return ac;
}

// --------------------------------------------------------------- filtros 1D

function reflejar(i, n) {
  // Borde "reflect" de scipy.ndimage: d c b a | a b c d | d c b a
  if (n === 1) return 0;
  const periodo = 2 * n;
  i = ((i % periodo) + periodo) % periodo;
  return i < n ? i : periodo - 1 - i;
}

export function filtroUniforme(x, tam) {
  const n = x.length;
  const salida = new Float64Array(n);
  const izq = Math.floor(tam / 2);
  let suma = 0;
  for (let j = -izq; j < tam - izq; j++) suma += x[reflejar(j, n)];
  for (let i = 0; i < n; i++) {
    salida[i] = suma / tam;
    suma += x[reflejar(i + tam - izq, n)] - x[reflejar(i - izq, n)];
  }
  return salida;
}

export function filtroMaximo(x, tam) {
  const n = x.length;
  const salida = new Float64Array(n);
  const izq = Math.floor(tam / 2);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let j = i - izq; j < i - izq + tam; j++) {
      const v = x[reflejar(j, n)];
      if (v > m) m = v;
    }
    salida[i] = m;
  }
  return salida;
}

/**
 * Mediana deslizante de `tam` (impar) sobre una secuencia leída con `leer(i)`,
 * escrita con `escribir(i, v)`. Mantiene la ventana ordenada: O(n · tam).
 */
function medianaDeslizante(n, tam, leer, escribir, borde = reflejar) {
  const izq = Math.floor(tam / 2);
  const ventana = new Float64Array(tam);
  for (let j = 0; j < tam; j++) ventana[j] = leer(borde(j - izq, n));
  ventana.sort();
  for (let i = 0; i < n; i++) {
    escribir(i, ventana[izq]);
    if (i === n - 1) break;
    const sale = leer(borde(i - izq, n));
    const entra = leer(borde(i - izq + tam, n));
    // quitar `sale`
    let p = 0;
    while (p < tam - 1 && ventana[p] !== sale) p++;
    for (let q = p; q < tam - 1; q++) ventana[q] = ventana[q + 1];
    // insertar `entra` en orden
    let q = tam - 1;
    while (q > 0 && ventana[q - 1] > entra) { ventana[q] = ventana[q - 1]; q--; }
    ventana[q] = entra;
  }
}

// Borde "nearest" de scipy.ndimage: a a a | a b c d | d d d
const cercano = (i, n) => (i < 0 ? 0 : i >= n ? n - 1 : i);
const BORDES = { reflect: reflejar, nearest: cercano };

export function filtroMediana(x, tam) {
  const salida = new Float64Array(x.length);
  medianaDeslizante(x.length, tam, (i) => x[i], (i, v) => { salida[i] = v; });
  return salida;
}

/** Mediana a lo largo del tiempo (filas) de una matriz frames × columnas. */
export function medianaEnTiempo(datos, filas, columnas, tam, modo = "reflect") {
  const salida = new Float32Array(datos.length);
  for (let c = 0; c < columnas; c++) {
    medianaDeslizante(filas, tam, (i) => datos[i * columnas + c], (i, v) => { salida[i * columnas + c] = v; },
      BORDES[modo]);
  }
  return salida;
}

/** Mediana a lo largo de las columnas (bandas) en cada fila. */
export function medianaEnColumnas(datos, filas, columnas, tam, modo = "reflect") {
  const salida = new Float32Array(datos.length);
  for (let f = 0; f < filas; f++) {
    const base = f * columnas;
    medianaDeslizante(columnas, tam, (i) => datos[base + i], (i, v) => { salida[base + i] = v; }, BORDES[modo]);
  }
  return salida;
}

// --------------------------------------------------------------- estadística

/** Percentil con interpolación lineal (el método por defecto de numpy). */
export function percentil(x, p) {
  const n = x.length;
  if (n === 0) return 0;
  const orden = Float64Array.from(x).sort();
  const rango = (p / 100) * (n - 1);
  const i = Math.floor(rango);
  const f = rango - i;
  return i + 1 < n ? orden[i] * (1 - f) + orden[i + 1] * f : orden[n - 1];
}

export function media(x, desde = 0, hasta = x.length) {
  if (hasta <= desde) return 0;
  let s = 0;
  for (let i = desde; i < hasta; i++) s += x[i];
  return s / (hasta - desde);
}

export function maximoEn(x, desde = 0, hasta = x.length) {
  let m = -Infinity;
  for (let i = desde; i < hasta; i++) if (x[i] > m) m = x[i];
  return m;
}

export function argmax(x) {
  let mejor = 0;
  for (let i = 1; i < x.length; i++) if (x[i] > x[mejor]) mejor = i;
  return mejor;
}

export function limitar(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** Redondeo al par más cercano, como `round` de Python. */
export function redondear(v) {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Normaliza por el percentil `p` y limita a [0, 1.5]. */
export function normalizar(curva, p = 99.5) {
  const escala = percentil(curva, p);
  const salida = new Float32Array(curva.length);
  if (escala <= 1e-9) return salida;
  for (let i = 0; i < curva.length; i++) salida[i] = limitar(curva[i] / escala, 0, 1.5);
  return salida;
}

/** Búsqueda binaria: primer índice con lista[i] >= v. */
export function bisectIzq(lista, v) {
  let a = 0, b = lista.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (lista[m] < v) a = m + 1; else b = m;
  }
  return a;
}

export function insertarOrdenado(lista, v) {
  lista.splice(bisectIzq(lista, v), 0, v);
}
