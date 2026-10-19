"""Generación de canciones sintéticas para las pruebas."""

import numpy as np

SR = 22050


def _desvanecer(x):
    cola = min(x.size, 64)
    x[-cola:] *= np.linspace(1, 0, cola)
    return x


def bombo(sr=SR, dur=0.2):
    t = np.arange(int(sr * dur)) / sr
    frecuencia = 60 + 90 * np.exp(-t * 40)
    return _desvanecer(np.sin(2 * np.pi * np.cumsum(frecuencia) / sr) * np.exp(-t * 25))


def platillo(sr=SR, dur=0.05, semilla=0):
    rng = np.random.default_rng(semilla)
    t = np.arange(int(sr * dur)) / sr
    ruido = rng.standard_normal(t.size)
    ruido = np.diff(ruido, prepend=0)  # brillo
    return _desvanecer(0.25 * ruido * np.exp(-t * 80))


def tono(midi, dur, sr=SR):
    t = np.arange(int(sr * dur)) / sr
    f = 440.0 * 2 ** ((midi - 69) / 12)
    onda = sum((0.6 ** h) * np.sin(2 * np.pi * f * (h + 1) * t) for h in range(4))
    envolvente = np.minimum(1, t / 0.01) * np.exp(-t * 1.2)
    return _desvanecer(0.35 * onda * envolvente)


def cancion(bpm=150.0, segundos=40.0, offset=0.5, sr=SR, melodia=True, semilla=1):
    """Bombo en cada tiempo, platillo en contratiempos y una melodía en corcheas.

    La segunda mitad tiene más energía (doble platillo) para simular un estribillo.
    """
    rng = np.random.default_rng(semilla)
    n = int(segundos * sr)
    senal = np.zeros(n + sr)
    periodo = 60.0 / bpm
    k = bombo(sr)
    p = platillo(sr)
    escala = [60, 62, 64, 65, 67, 69, 71, 72]
    t = offset
    i = 0
    while t < segundos:
        a = int(t * sr)
        senal[a:a + k.size] += (1.0 if i % 4 == 0 else 0.8) * k
        medio = int((t + periodo / 2) * sr)
        senal[medio:medio + p.size] += p
        if t > segundos / 2:
            cuarto = int((t + periodo / 4) * sr)
            senal[cuarto:cuarto + p.size] += 0.7 * p
        if melodia and i % 2 == 0:
            nota = tono(escala[rng.integers(len(escala))], periodo * 2, sr)
            senal[a:a + nota.size] += nota
        t += periodo
        i += 1
    senal = senal[:n]
    return (senal / np.abs(senal).max()).astype(np.float32)


def clics(tiempos, segundos, sr=SR):
    senal = np.zeros(int(segundos * sr))
    k = bombo(sr)
    for t in tiempos:
        a = int(t * sr)
        senal[a:a + k.size] += k[: senal.size - a]
    return senal.astype(np.float32)
