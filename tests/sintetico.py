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


# ---------------------------------------------------------------------------
# Canción "realista" con ritmo conocido (para medir la calidad rítmica)
# ---------------------------------------------------------------------------

def caja(sr=SR, dur=0.15, semilla=2):
    rng = np.random.default_rng(semilla)
    t = np.arange(int(sr * dur)) / sr
    cuerpo = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30)
    ruido = rng.standard_normal(t.size) * np.exp(-t * 22)
    return _desvanecer(0.5 * cuerpo + 0.45 * ruido)


def pad(midis, dur, sr=SR):
    t = np.arange(int(sr * dur)) / sr
    onda = sum(np.sin(2 * np.pi * 440.0 * 2 ** ((m - 69) / 12) * t) for m in midis)
    envolvente = np.minimum(1, t / 0.4) * np.minimum(1, (dur - t) / 0.3)
    return _desvanecer(0.08 * onda * envolvente)


# Patrones de 16 semicorcheas por compás.
_SECCIONES = [
    # nombre, compases, bombo, caja, platillo, melodía (paso, nota relativa, duración en pasos)
    ("intro", 4, [], [], [0, 4, 8, 12], []),
    ("verso", 8, [0, 7, 10], [4, 12], list(range(0, 16, 2)),
     [(0, 0, 3), (3, 2, 3), (6, 4, 2), (8, 5, 4), (12, 4, 2), (14, 2, 2)]),
    ("coro", 8, [0, 3, 8, 11], [4, 12], list(range(16)),
     [(0, 7, 2), (2, 5, 2), (4, 4, 2), (6, 2, 2), (8, 0, 1), (9, 2, 1), (10, 4, 1), (11, 5, 1),
      (12, 7, 1), (13, 9, 1), (14, 11, 1), (15, 12, 1)]),
    ("puente", 4, [0], [], [], [(0, 0, 8), (8, 4, 8)]),
    ("coro", 8, [0, 3, 8, 11], [4, 12], list(range(16)),
     [(0, 7, 2), (2, 5, 2), (4, 4, 2), (6, 2, 2), (8, 0, 1), (9, 2, 1), (10, 4, 1), (11, 5, 1),
      (12, 7, 1), (13, 9, 1), (14, 11, 1), (15, 12, 1)]),
]


def cancion_realista(bpm=170.0, offset=0.6, sr=SR, humano=0.0, semilla=5):
    """Devuelve (señal, eventos). `eventos` es una lista (tiempo, instrumento, sección, paso).

    `humano` (s) desplaza al azar cada golpe y agrega reverberación y ruido de fondo,
    para parecerse más a una grabación real.
    """
    rng = np.random.default_rng(semilla)
    paso = 60.0 / bpm / 4
    compases = sum(s[1] for s in _SECCIONES)
    n = int((offset + compases * 16 * paso + 1.0) * sr)
    senal = np.zeros(n)
    eventos = []
    k, s, p = bombo(sr), caja(sr), platillo(sr)
    t_compas = offset
    for nombre, cantidad, bombos, cajas, platillos, melodia in _SECCIONES:
        fuerte = 1.0 if nombre == "coro" else 0.75
        for _ in range(cantidad):
            senal_pad = pad([48, 55, 64], 16 * paso, sr)
            a = int(t_compas * sr)
            senal[a:a + senal_pad.size] += senal_pad
            for paso_i in range(16):
                t = t_compas + paso_i * paso + (rng.normal(0, humano) if humano else 0.0)
                a = int(t * sr)
                if paso_i in bombos:
                    senal[a:a + k.size] += fuerte * k
                    eventos.append((t, "bombo", nombre, paso_i))
                if paso_i in cajas:
                    senal[a:a + s.size] += fuerte * 0.8 * s
                    eventos.append((t, "caja", nombre, paso_i))
                if paso_i in platillos:
                    senal[a:a + p.size] += 0.5 * p
                    eventos.append((t, "platillo", nombre, paso_i))
            for paso_i, nota, duracion in melodia:
                t = t_compas + paso_i * paso + (rng.normal(0, humano) if humano else 0.0)
                a = int(t * sr)
                sonido = tono(67 + nota, duracion * paso * 1.6, sr)
                senal[a:a + sonido.size] += 0.9 * sonido
                eventos.append((t, "melodia", nombre, paso_i))
            t_compas += 16 * paso
    if humano:
        from scipy.signal import fftconvolve
        t = np.arange(int(0.8 * sr)) / sr
        respuesta = rng.standard_normal(t.size) * np.exp(-t * 6) * 0.03
        respuesta[0] = 1.0
        senal = fftconvolve(senal, respuesta)[:n]
        senal += rng.standard_normal(n) * 0.01 * np.abs(senal).max()
    senal = senal / np.abs(senal).max()
    return senal.astype(np.float32), sorted(eventos)
