// Generador pseudoaleatorio con semilla (sfc32): mismos mapas para la misma semilla.

export class Azar {
  constructor(semilla = 0) {
    // Mezcla la semilla en cuatro palabras de 32 bits (splitmix32).
    let s = (semilla >>> 0) ^ 0x9e3779b9;
    const siguiente = () => {
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = siguiente(); this.b = siguiente(); this.c = siguiente(); this.d = siguiente();
    for (let i = 0; i < 12; i++) this.random();
  }

  /** Número en [0, 1). */
  random() {
    let { a, b, c, d } = this;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return (t >>> 0) / 4294967296;
  }

  /** Entero en [0, n). */
  entero(n) {
    return Math.floor(this.random() * n);
  }

  uniforme(a, b) {
    return a + (b - a) * this.random();
  }

  /** Índice elegido con probabilidad proporcional a `pesos`. */
  elegir(pesos) {
    const total = pesos.reduce((s, p) => s + p, 0);
    let r = this.random() * total;
    for (let i = 0; i < pesos.length; i++) {
      r -= pesos[i];
      if (r < 0) return i;
    }
    return pesos.length - 1;
  }

  mezclar(lista) {
    for (let i = lista.length - 1; i > 0; i--) {
      const j = this.entero(i + 1);
      [lista[i], lista[j]] = [lista[j], lista[i]];
    }
    return lista;
  }
}
