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


# Coro "sostenido": bombo en negras, melodía en notas largas y casi sin platillos.
SECCIONES_SOSTENIDAS = [
    ("intro", 4, [], [], [0, 8], []),
    ("verso", 8, [0, 7, 10], [4, 12], list(range(0, 16, 2)),
     [(0, 0, 3), (3, 2, 3), (6, 4, 2), (8, 5, 4), (12, 4, 2), (14, 2, 2)]),
    ("coro", 8, [0, 4, 8, 12], [], [], [(0, 12, 8), (8, 11, 4), (12, 9, 4)]),
    ("verso", 4, [0, 7, 10], [4, 12], list(range(0, 16, 2)), [(0, 0, 3), (3, 2, 3), (6, 4, 2)]),
]


def cancion_realista(bpm=170.0, offset=0.6, sr=SR, humano=0.0, semilla=5, secciones=None):
    """Devuelve (señal, eventos). `eventos` es una lista (tiempo, instrumento, sección, paso).

    `humano` (s) desplaza al azar cada golpe y agrega reverberación y ruido de fondo,
    para parecerse más a una grabación real.
    """
    rng = np.random.default_rng(semilla)
    secciones = secciones or _SECCIONES
    paso = 60.0 / bpm / 4
    compases = sum(s[1] for s in secciones)
    n = int((offset + compases * 16 * paso + 1.0) * sr)
    senal = np.zeros(n)
    eventos = []
    k, s, p = bombo(sr), caja(sr), platillo(sr)
    t_compas = offset
    for nombre, cantidad, bombos, cajas, platillos, melodia in secciones:
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
        respuesta = rng.standard_normal(t.size) * np.exp(-t * 6) * 0.004
        respuesta[0] = 1.0
        senal = fftconvolve(senal, respuesta)[:n]
        senal += rng.standard_normal(n) * 0.01 * np.abs(senal).max()
    senal = senal / np.abs(senal).max()
    return senal.astype(np.float32), sorted(eventos)


# ---------------------------------------------------------------------------
# Canción con instrumentos que se turnan el protagonismo
# ---------------------------------------------------------------------------

def bajo(midi, dur, sr=SR):
    t = np.arange(int(sr * dur)) / sr
    f = 440.0 * 2 ** ((midi - 69) / 12)
    onda = np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * 2 * f * t) + 0.25 * np.sin(2 * np.pi * 3 * f * t)
    envolvente = np.minimum(1, t / 0.005) * np.exp(-t * 2.0)
    return _desvanecer(0.6 * onda * envolvente)


def voz(midi, dur, sr=SR):
    """Nota cantada: ataque suave, se sostiene toda la duración, con vibrato."""
    t = np.arange(int(sr * dur)) / sr
    f = 440.0 * 2 ** ((midi - 69) / 12) * (1 + 0.006 * np.sin(2 * np.pi * 5.5 * t))
    fase = 2 * np.pi * np.cumsum(f) / sr
    onda = sum((0.7 ** h) * np.sin(fase * (h + 1)) for h in range(5))
    envolvente = np.minimum(1, t / 0.03) * np.minimum(1, (dur - t) / 0.05)
    return _desvanecer(0.3 * onda * envolvente)


def cancion_capas(bpm=150.0, offset=0.5, sr=SR):
    """Tres partes de 8 compases: solo de bajo, batería fuerte y voz con notas largas.

    Devuelve (señal, eventos, partes) con partes = {nombre: (inicio, fin)}; los
    eventos de la voz llevan su duración: (tiempo, "voz", duración).
    """
    paso = 60.0 / bpm / 4
    compas = 16 * paso
    total = offset + 24 * compas + 1.0
    senal = np.zeros(int(total * sr))
    eventos = []
    k, s, p = bombo(sr), caja(sr), platillo(sr)
    linea_bajo = [(0, 36, 2), (2, 38, 2), (4, 40, 2), (6, 43, 2), (8, 45, 2), (10, 43, 2), (12, 40, 2), (14, 38, 2)]
    voz_larga = [(0, 72, 8), (8, 74, 4), (12, 76, 4)]

    def poner(t, sonido, ganancia):
        a = int(t * sr)
        senal[a:a + sonido.size] += ganancia * sonido[: max(0, senal.size - a)]

    partes = {}
    for parte, compases in (("bajo", range(0, 8)), ("bateria", range(8, 16)), ("voz", range(16, 24))):
        partes[parte] = (offset + compases[0] * compas, offset + (compases[-1] + 1) * compas)
        for c in compases:
            t0 = offset + c * compas
            for paso_i in range(16):
                t = t0 + paso_i * paso
                if parte == "bajo":
                    if paso_i % 8 == 0:
                        poner(t, k, 0.35)
                        eventos.append((t, "bombo", 0))
                elif parte == "bateria":
                    if paso_i in (0, 3, 8, 11):
                        poner(t, k, 1.0)
                        eventos.append((t, "bombo", 0))
                    if paso_i in (4, 12):
                        poner(t, s, 0.9)
                        eventos.append((t, "caja", 0))
                    poner(t, p, 0.6)
                    eventos.append((t, "platillo", 0))
                else:
                    if paso_i % 4 == 0:
                        poner(t, k, 0.4)
                        eventos.append((t, "bombo", 0))
            if parte == "bajo":
                for paso_i, nota, dur in linea_bajo:
                    poner(t0 + paso_i * paso, bajo(nota, dur * paso * 0.95), 1.0)
                    eventos.append((t0 + paso_i * paso, "bajo", nota))
            elif parte == "voz":
                for paso_i, nota, dur in voz_larga:
                    poner(t0 + paso_i * paso, voz(nota, dur * paso * 0.97), 1.0)
                    eventos.append((t0 + paso_i * paso, "voz", dur * paso))
            else:
                poner(t0, pad([48, 55, 64], 16 * paso), 0.5)
    senal = senal / np.abs(senal).max()
    return senal.astype(np.float32), sorted(eventos), partes
