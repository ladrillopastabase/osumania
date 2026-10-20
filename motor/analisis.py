"""Motor de análisis musical.

A partir de la señal mono obtiene:
  * envolventes de onset (total y por bandas grave/media/aguda) y onsets puntuales,
  * BPM constante, offset del primer tiempo fuerte y rejilla de pulsos,
  * contorno melódico (altura dominante por suma de armónicos) y su confianza,
  * curva de intensidad (energía) y secciones musicales por novedad tímbrica,
  * duración de notas sostenidas, que el generador usa para decidir holds.

Todo se calcula con numpy/scipy, procesando el espectrograma por bloques para
mantener acotado el uso de memoria con canciones largas.
"""

from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import maximum_filter1d, median_filter, uniform_filter1d

from . import capas as modulo_capas

HOP = 256
N_FFT_ONSET = 1024
N_FFT_MELODIA = 2048
N_MEL = 64
BLOQUE = 2048  # frames por bloque de STFT

# Desfase medido entre el pico de flujo espectral y el ataque real (segundos).
# Se calibró con clics sintéticos (ver tests/test_analisis.py).
CORRECCION_ONSET = 0.0116

BPM_MIN = 60.0
BPM_MAX = 250.0
BPM_PREFERIDO = 140.0


@dataclass
class Seccion:
    inicio: float
    fin: float
    intensidad: float
    etiqueta: str
    kiai: bool

    def como_dict(self):
        return {
            "inicio": round(self.inicio, 3),
            "fin": round(self.fin, 3),
            "intensidad": round(self.intensidad, 3),
            "etiqueta": self.etiqueta,
            "kiai": self.kiai,
        }


@dataclass
class Analisis:
    sr: int
    duracion: float
    hop_s: float
    env: np.ndarray
    env_bajo: np.ndarray
    env_medio: np.ndarray
    env_alto: np.ndarray
    onsets: np.ndarray
    fuerzas: np.ndarray
    bpm: float
    offset: float
    compas: int
    intensidad: np.ndarray
    altura: np.ndarray
    confianza_melodia: np.ndarray
    energia_tonal_db: np.ndarray
    secciones: list = field(default_factory=list)
    capas: dict = field(default_factory=dict)  # nombre -> capas.Capa
    altura_bajo: np.ndarray | None = None       # contorno de la línea de bajo (MIDI)
    confianza_bajo: np.ndarray | None = None

    # ---- rejilla rítmica -------------------------------------------------
    @property
    def periodo(self) -> float:
        return 60.0 / self.bpm

    def pulsos(self) -> np.ndarray:
        """Tiempos de todos los pulsos dentro de la canción (incluye anteriores al offset)."""
        primero = self.offset - np.floor(self.offset / self.periodo) * self.periodo
        return np.arange(primero, self.duracion, self.periodo)

    def indice_pulso(self, t: float) -> int:
        """Índice del pulso relativo al offset (0 = primer tiempo fuerte)."""
        return int(round((t - self.offset) / self.periodo))

    # ---- consultas puntuales ----------------------------------------------
    def frame(self, t: float) -> int:
        return int(np.clip(round(t / self.hop_s), 0, self.env.size - 1))

    def maximo(self, curva: np.ndarray, t: float, ventana: float) -> float:
        a = self.frame(t - ventana)
        b = self.frame(t + ventana) + 1
        return float(curva[a:b].max()) if b > a else float(curva[a])

    def valor(self, curva: np.ndarray, t: float) -> float:
        return float(curva[self.frame(t)])

    def seccion_en(self, t: float) -> Seccion | None:
        for s in self.secciones:
            if s.inicio <= t < s.fin:
                return s
        return self.secciones[-1] if self.secciones else None

    def sostenido(self, t: float, maximo: float = 4.0, capa: str | None = None) -> float:
        """Cuánto dura el sonido tonal que empieza en `t` (segundos).

        Se corta cuando la energía cae 7 dB respecto del ataque o cuando aparece
        un ataque nuevo. Con `capa` ("bajo", "melodia") se mide solo ese
        instrumento: un hold sigue al bajo o a la voz, no a la mezcla entera.
        """
        i = self.frame(t)
        fin = min(self.env.size, i + int(maximo / self.hop_s))
        if fin - i < 4:
            return 0.0
        if capa is not None and capa in self.capas and self.capas[capa].energia_db is not None:
            energia = self.capas[capa].energia_db
            ataques = self.capas[capa].env
        else:
            energia = self.energia_tonal_db
            # Solo un ataque armónico nuevo corta la nota: la percusión no.
            ataques = self.capas["melodia"].env if "melodia" in self.capas else self.env_medio
        referencia = float(energia[i:i + 4].max())
        tramo = energia[i + 4:fin]
        golpes = ataques[i + 4:fin]
        corte = (tramo < referencia - 7.0) | (golpes > 0.5)
        if corte.any():
            j = int(np.argmax(corte)) + 4
        else:
            j = fin - i
        return j * self.hop_s

    # ---- serialización ----------------------------------------------------
    def resumen(self, puntos: int = 600) -> dict:
        def reducir(curva):
            if curva.size <= puntos:
                return [round(float(v), 3) for v in curva]
            bordes = np.linspace(0, curva.size, puntos + 1).astype(int)
            return [round(float(curva[a:b].max()), 3) for a, b in zip(bordes[:-1], bordes[1:])]

        return {
            "duracion": round(self.duracion, 3),
            "bpm": round(self.bpm, 3),
            "offset_ms": int(round(self.offset * 1000)),
            "compas": self.compas,
            "onsets": int(self.onsets.size),
            "secciones": [s.como_dict() for s in self.secciones],
            "intensidad": reducir(self.intensidad),
            "onset_env": reducir(self.env),
            # En las capas melódicas también cuenta cuánto suenan sostenidas (una voz
            # larga ataca poco pero se oye todo el tiempo).
            "capas": {nombre: {"familia": c.familia, "onsets": int((c.fuerzas >= 0.2).sum()),
                               "actividad": reducir(np.maximum(c.actividad, c.presencia)
                                                    if c.familia == "melodia" and c.presencia is not None
                                                    else c.actividad)}
                      for nombre, c in self.capas.items()},
        }


# ---------------------------------------------------------------------------
# Utilidades espectrales
# ---------------------------------------------------------------------------

def _hz_a_mel(f):
    return 2595.0 * np.log10(1.0 + np.asarray(f) / 700.0)


def _mel_a_hz(m):
    return 700.0 * (10.0 ** (np.asarray(m) / 2595.0) - 1.0)


def banco_mel(sr: int, n_fft: int, n_mel: int = N_MEL, fmin: float = 30.0, fmax: float | None = None):
    fmax = fmax or sr / 2
    frecuencias = np.fft.rfftfreq(n_fft, 1.0 / sr)
    puntos = _mel_a_hz(np.linspace(_hz_a_mel(fmin), _hz_a_mel(fmax), n_mel + 2))
    banco = np.zeros((n_mel, frecuencias.size), dtype=np.float32)
    for m in range(n_mel):
        izq, centro, der = puntos[m], puntos[m + 1], puntos[m + 2]
        subida = (frecuencias - izq) / max(centro - izq, 1e-9)
        bajada = (der - frecuencias) / max(der - centro, 1e-9)
        banco[m] = np.maximum(0, np.minimum(subida, bajada))
    return banco, puntos[1:-1]


def _matriz_armonicos(sr: int, n_fft: int, midi_min: int = 43, midi_max: int = 87, n_armonicos: int = 6):
    """Índices de bin y pesos para la suma de armónicos de cada candidato a f0.

    Por defecto G2..D#6 (melodía/voz); el bajo usa E1..E3."""
    midis = np.arange(midi_min, midi_max + 1)
    f0 = 440.0 * 2.0 ** ((midis - 69) / 12.0)
    armonicos = np.arange(1, n_armonicos + 1)
    resolucion = sr / n_fft
    bins = np.rint(np.outer(f0, armonicos) / resolucion).astype(int)
    n_bins = n_fft // 2 + 1
    pesos = np.tile(0.84 ** (armonicos - 1), (midis.size, 1)).astype(np.float32)
    pesos[bins >= n_bins] = 0
    bins = np.minimum(bins, n_bins - 1)
    return midis.astype(np.float32), bins, pesos


def _espectros(senal: np.ndarray, sr: int):
    """Calcula por bloques: mel (dB), energía total, y saliencia melódica."""
    n_frames = 1 + senal.size // HOP
    margen = N_FFT_MELODIA // 2
    acolchada = np.pad(senal, (margen, margen + N_FFT_MELODIA))

    ventana_on = np.hanning(N_FFT_ONSET).astype(np.float32)
    ventana_mel = np.hanning(N_FFT_MELODIA).astype(np.float32)
    banco, centros = banco_mel(sr, N_FFT_ONSET)
    midis, bins_arm, pesos_arm = _matriz_armonicos(sr, N_FFT_MELODIA)
    midis_bajo, bins_bajo, pesos_bajo = _matriz_armonicos(sr, N_FFT_MELODIA, 28, 52, 4)
    frecuencias_mel = np.fft.rfftfreq(N_FFT_MELODIA, 1.0 / sr)
    banda_tonal = (frecuencias_mel >= 80) & (frecuencias_mel <= 4000)

    banco_fino, centros_fino = banco_mel(sr, N_FFT_ONSET, modulo_capas.N_MEL_FINO)
    mel = np.zeros((n_frames, N_MEL), dtype=np.float32)
    mel_fino = np.zeros((n_frames, modulo_capas.N_MEL_FINO), dtype=np.float32)
    energia = np.zeros(n_frames, dtype=np.float32)
    energia_tonal = np.zeros(n_frames, dtype=np.float32)
    saliencia = np.zeros((n_frames, midis.size), dtype=np.float32)
    saliencia_bajo = np.zeros((n_frames, midis_bajo.size), dtype=np.float32)

    desplaz_on = margen - N_FFT_ONSET // 2  # centra ambas ventanas en el mismo instante
    for inicio in range(0, n_frames, BLOQUE):
        fin = min(n_frames, inicio + BLOQUE)
        posiciones = np.arange(inicio, fin) * HOP

        idx_on = posiciones[:, None] + desplaz_on + np.arange(N_FFT_ONSET)[None, :]
        cuadros = acolchada[idx_on] * ventana_on
        potencia = np.abs(np.fft.rfft(cuadros, axis=1)) ** 2
        mel[inicio:fin] = potencia @ banco.T
        mel_fino[inicio:fin] = potencia @ banco_fino.T
        energia[inicio:fin] = potencia.sum(axis=1)

        idx_mel = posiciones[:, None] + np.arange(N_FFT_MELODIA)[None, :]
        cuadros = acolchada[idx_mel] * ventana_mel
        magnitud = np.abs(np.fft.rfft(cuadros, axis=1)).astype(np.float32)
        energia_tonal[inicio:fin] = (magnitud[:, banda_tonal] ** 2).sum(axis=1)
        comprimida = np.log1p(magnitud * 10.0)
        saliencia[inicio:fin] = (comprimida[:, bins_arm] * pesos_arm[None]).sum(axis=2)
        saliencia_bajo[inicio:fin] = (comprimida[:, bins_bajo] * pesos_bajo[None]).sum(axis=2)

    mel_db = 10.0 * np.log10(mel + 1e-10)
    mel_db = np.maximum(mel_db, mel_db.max() - 80.0)
    return (mel_db, energia, energia_tonal, saliencia, midis, centros, mel_fino, centros_fino,
            saliencia_bajo, midis_bajo)


def _normalizar(curva: np.ndarray, percentil: float = 99.5) -> np.ndarray:
    escala = np.percentile(curva, percentil)
    if escala <= 1e-9:
        return np.zeros_like(curva)
    return np.clip(curva / escala, 0.0, 1.5).astype(np.float32)


def _flujo(mel_db: np.ndarray) -> np.ndarray:
    # Flujo espectral con máximo local en frecuencia (reduce falsos onsets por vibrato).
    referencia = maximum_filter1d(mel_db, size=3, axis=1)
    diferencia = mel_db[1:] - referencia[:-1]
    flujo = np.maximum(0.0, diferencia)
    return np.vstack([np.zeros((1, mel_db.shape[1]), dtype=np.float32), flujo])


# ---------------------------------------------------------------------------
# Onsets, tempo y pulsos
# ---------------------------------------------------------------------------

def detectar_onsets(env: np.ndarray, hop_s: float, delta: float = 0.06):
    pre_max = max(1, int(0.03 / hop_s))
    pre_media = max(1, int(0.10 / hop_s))
    espera = max(1, int(0.03 / hop_s))
    maximos = maximum_filter1d(env, size=2 * pre_max + 1)
    medias = uniform_filter1d(env, size=2 * pre_media + 1)
    candidatos = np.flatnonzero((env >= maximos) & (env >= medias + delta) & (env > 0.08))
    elegidos = []
    ultimo = -10**9
    for i in candidatos:
        if i - ultimo >= espera:
            elegidos.append(i)
            ultimo = i
    elegidos = np.asarray(elegidos, dtype=int)
    tiempos = elegidos * hop_s + CORRECCION_ONSET
    return tiempos, env[elegidos] if elegidos.size else np.zeros(0)


def detectar_onsets_por_banda(env, bandas, hop_s, union: float = 0.025):
    """Une los onsets de la envolvente total con los de cada banda.

    Un platillo suave entre bombo y caja casi no se nota en la envolvente total,
    pero sí en la de agudos. Los onsets a menos de `union` s se funden en uno.
    """
    tiempos = [detectar_onsets(env, hop_s)[0]]
    for banda in bandas:
        tiempos.append(detectar_onsets(banda, hop_s, delta=0.08)[0])
    todos = np.sort(np.concatenate(tiempos))
    unidos = []
    for t in todos:
        if unidos and t - unidos[-1] < union:
            continue
        unidos.append(t)
    unidos = np.asarray(unidos)
    indices = np.clip(np.rint((unidos - CORRECCION_ONSET) / hop_s).astype(int), 0, env.size - 1)
    fuerzas = np.maximum.reduce([env[indices]] + [b[indices] for b in bandas])
    return unidos, fuerzas


def _autocorrelacion(x: np.ndarray) -> np.ndarray:
    n = 1 << int(np.ceil(np.log2(2 * x.size)))
    espectro = np.fft.rfft(x, n)
    ac = np.fft.irfft(np.abs(espectro) ** 2, n)[: x.size]
    return ac / (ac[0] + 1e-9)


def estimar_bpm_inicial(env: np.ndarray, hop_s: float) -> float:
    centrada = env - uniform_filter1d(env, size=max(3, int(1.0 / hop_s)))
    centrada = np.maximum(centrada, 0)
    ac = _autocorrelacion(centrada)
    lag_min = int(60.0 / (BPM_MAX * hop_s))
    lag_max = min(ac.size - 2, int(60.0 / (BPM_MIN * hop_s)) + 1)
    lags = np.arange(max(lag_min, 2), lag_max)
    bpms = 60.0 / (lags * hop_s)
    # Prior log-normal: evita confundir el tempo con su mitad o su doble.
    prior = np.exp(-0.5 * (np.log2(bpms / BPM_PREFERIDO) / 0.6) ** 2)
    puntaje = ac[lags] * prior
    i = int(np.argmax(puntaje))
    # Interpolación parabólica para obtener un lag fraccionario.
    if 0 < i < lags.size - 1:
        a, b, c = puntaje[i - 1], puntaje[i], puntaje[i + 1]
        denominador = a - 2 * b + c
        desplaz = 0.5 * (a - c) / denominador if abs(denominador) > 1e-12 else 0.0
    else:
        desplaz = 0.0
    lag = lags[i] + float(np.clip(desplaz, -0.5, 0.5))
    return 60.0 / (lag * hop_s)


def _puntaje_rejilla(env: np.ndarray, periodo_frames: float, fases: np.ndarray):
    """Suma de la envolvente (interpolada) sobre una rejilla de pulsos para cada fase."""
    n_pulsos = int((env.size - 1 - fases.max()) / periodo_frames)
    if n_pulsos < 2:
        return np.zeros_like(fases)
    posiciones = fases[:, None] + periodo_frames * np.arange(n_pulsos)[None, :]
    base = np.floor(posiciones).astype(int)
    frac = posiciones - base
    valores = env[base] * (1 - frac) + env[np.minimum(base + 1, env.size - 1)] * frac
    # Medio pulso con peso menor: ayuda a no fijarse en los contratiempos.
    medios = posiciones + periodo_frames / 2
    base_m = np.minimum(np.floor(medios).astype(int), env.size - 2)
    frac_m = medios - base_m
    valores_m = env[base_m] * (1 - frac_m) + env[base_m + 1] * frac_m
    return (valores.sum(axis=1) + 0.25 * valores_m.sum(axis=1)) / n_pulsos


def ajustar_rejilla(env: np.ndarray, hop_s: float, bpm_inicial: float, rango: float = 0.03):
    """Afina BPM y fase buscando la rejilla constante que mejor calza con los onsets."""
    mejor = (-1.0, bpm_inicial, 0.0)
    for bpm in bpm_inicial * (1 + np.linspace(-rango, rango, 121)):
        periodo = 60.0 / (bpm * hop_s)
        fases = np.arange(0, periodo, 0.25)
        puntajes = _puntaje_rejilla(env, periodo, fases)
        j = int(np.argmax(puntajes))
        if puntajes[j] > mejor[0]:
            mejor = (float(puntajes[j]), float(bpm), float(fases[j]))
    _, bpm, fase = mejor

    # La mayoría de la música producida usa BPM enteros o .5: si estamos cerca, se fija.
    for paso in (1.0, 0.5):
        redondeado = round(bpm / paso) * paso
        if abs(redondeado - bpm) <= 0.12 * paso * 2:
            bpm = redondeado
            break
    periodo = 60.0 / (bpm * hop_s)
    fases = np.arange(0, periodo, 0.1)
    puntajes = _puntaje_rejilla(env, periodo, fases)
    fase = float(fases[int(np.argmax(puntajes))])
    return bpm, fase * hop_s


def elegir_tiempo_fuerte(env_bajo: np.ndarray, env: np.ndarray, hop_s: float,
                         bpm: float, fase: float, compas: int = 4) -> float:
    """Elige cuál de los `compas` pulsos posibles es el primer tiempo del compás."""
    periodo = 60.0 / bpm
    pulsos = np.arange(fase, env.size * hop_s, periodo)
    indices = np.clip(np.rint(pulsos / hop_s).astype(int), 0, env.size - 1)
    peso = env_bajo[indices] + 0.3 * env[indices]
    puntajes = [peso[m::compas].mean() if peso[m::compas].size else 0 for m in range(compas)]
    m = int(np.argmax(puntajes))
    return float(fase + m * periodo)


# ---------------------------------------------------------------------------
# Melodía, intensidad y secciones
# ---------------------------------------------------------------------------

def contorno_melodico(saliencia: np.ndarray, midis: np.ndarray, hop_s: float):
    mejor = np.argmax(saliencia, axis=1)
    pico = saliencia[np.arange(saliencia.shape[0]), mejor]
    mediana = np.median(saliencia, axis=1)
    confianza = (pico - mediana) / (pico + 1e-6)
    tamano = max(3, int(0.06 / hop_s) | 1)
    altura = median_filter(midis[mejor], size=tamano).astype(np.float32)
    confianza = uniform_filter1d(confianza, size=tamano)
    confianza = _normalizar(confianza, 98)
    return altura, np.clip(confianza, 0, 1).astype(np.float32)


def curva_intensidad(energia: np.ndarray, hop_s: float) -> np.ndarray:
    db = 10.0 * np.log10(energia + 1e-10)
    db = uniform_filter1d(db, size=max(3, int(0.4 / hop_s)))
    bajo, alto = np.percentile(db, [5, 98])
    if alto - bajo < 1e-6:
        return np.full_like(db, 0.5, dtype=np.float32)
    return np.clip((db - bajo) / (alto - bajo), 0, 1).astype(np.float32)


def detectar_secciones(mel_db: np.ndarray, intensidad: np.ndarray, env: np.ndarray,
                       hop_s: float, offset: float, bpm: float, duracion: float,
                       compas: int = 4) -> list:
    duracion_compas = compas * 60.0 / bpm
    primero = offset - np.floor(offset / duracion_compas) * duracion_compas
    inicios = np.arange(primero, duracion, duracion_compas)
    bordes = np.unique(np.concatenate([[0.0], inicios[inicios > 1e-3], [duracion]]))
    if bordes.size < 3:
        return [_crear_seccion(0.0, duracion, intensidad, hop_s, [0.5])]

    indices = np.clip(np.rint(bordes / hop_s).astype(int), 0, mel_db.shape[0])
    rasgos = []
    for a, b in zip(indices[:-1], indices[1:]):
        b = max(b, a + 1)
        bloque = mel_db[a:b]
        rasgos.append(np.concatenate([bloque.mean(axis=0) / 10.0,
                                      [intensidad[a:b].mean() * 8.0, env[a:b].mean() * 8.0]]))
    rasgos = np.asarray(rasgos)
    rasgos = rasgos - rasgos.mean(axis=0)
    normas = np.linalg.norm(rasgos, axis=1, keepdims=True) + 1e-9
    unitarios = rasgos / normas
    similitud = unitarios @ unitarios.T

    n = similitud.shape[0]
    L = 4
    novedad = np.zeros(n)
    for i in range(L, n - L + 1):
        antes = similitud[i - L:i, i - L:i].mean()
        despues = similitud[i:i + L, i:i + L].mean()
        cruzado = similitud[i - L:i, i:i + L].mean()
        novedad[i] = antes + despues - 2 * cruzado
    cortes = [0]
    if novedad.max() > 0:
        umbral = novedad.mean() + 0.5 * novedad.std()
        candidatos = [i for i in range(1, n - 1)
                      if novedad[i] >= umbral and novedad[i] == novedad[max(0, i - 3):i + 4].max()]
        for i in candidatos:
            if i - cortes[-1] >= 4:
                cortes.append(i)
    if n - cortes[-1] < 4 and len(cortes) > 1:
        cortes.pop()
    cortes.append(n)

    tiempos = [(float(bordes[a]), float(bordes[b])) for a, b in zip(cortes[:-1], cortes[1:])]
    medias = [float(intensidad[int(a / hop_s):max(int(b / hop_s), int(a / hop_s) + 1)].mean())
              for a, b in tiempos]
    return [_crear_seccion(a, b, intensidad, hop_s, medias) for a, b in tiempos]


def _crear_seccion(inicio, fin, intensidad, hop_s, todas_las_medias):
    a = int(inicio / hop_s)
    b = max(int(fin / hop_s), a + 1)
    valor = float(intensidad[a:b].mean())
    maximo = max(todas_las_medias) if todas_las_medias else valor
    relativo = valor / maximo if maximo > 0 else 0
    if valor < 0.25:
        etiqueta = "tranquila"
    elif relativo >= 0.9 and valor >= 0.6:
        etiqueta = "clímax"
    elif valor >= 0.55:
        etiqueta = "intensa"
    else:
        etiqueta = "media"
    return Seccion(inicio, fin, valor, etiqueta, etiqueta == "clímax")


# ---------------------------------------------------------------------------
# Punto de entrada
# ---------------------------------------------------------------------------

def analizar(senal: np.ndarray, sr: int, bpm: float | None = None,
             offset: float | None = None, compas: int = 4) -> Analisis:
    """Analiza la canción completa. `bpm`/`offset` (s) permiten forzar la rejilla."""
    hop_s = HOP / sr
    duracion = senal.size / sr
    (mel_db, energia, energia_tonal, saliencia, midis, centros,
     mel_fino, centros_fino, saliencia_bajo, midis_bajo) = _espectros(senal, sr)
    capas = modulo_capas.separar(mel_fino, centros_fino, hop_s, detectar_onsets)
    del mel_fino

    flujo = _flujo(mel_db)
    graves = centros < 200
    agudos = centros > 2500
    medios = ~(graves | agudos)
    env_bajo = _normalizar(flujo[:, graves].mean(axis=1))
    env_medio = _normalizar(flujo[:, medios].mean(axis=1))
    env_alto = _normalizar(flujo[:, agudos].mean(axis=1))
    # Cada banda pesa lo mismo: si no, los agudos (muchas bandas mel) dominan.
    env = _normalizar((env_bajo + env_medio + env_alto) / 3.0)

    onsets, fuerzas = detectar_onsets_por_banda(env, (env_bajo, env_medio, env_alto), hop_s)
    # Los graves (bombo) marcan el pulso con más fiabilidad que los platillos.
    env_pulso = _normalizar(env + 1.5 * env_bajo)

    if bpm:
        bpm_final = float(bpm)
        if offset is None:
            periodo = 60.0 / (bpm_final * hop_s)
            fases = np.arange(0, periodo, 0.1)
            fase = float(fases[int(np.argmax(_puntaje_rejilla(env_pulso, periodo, fases)))]) * hop_s
        else:
            fase = float(offset)
    else:
        bpm_final, fase = ajustar_rejilla(env_pulso, hop_s, estimar_bpm_inicial(env_pulso, hop_s))
        if offset is not None:
            fase = float(offset)
    if offset is None:
        fase = elegir_tiempo_fuerte(env_bajo, env, hop_s, bpm_final, fase, compas)
        fase += CORRECCION_ONSET

    intensidad = curva_intensidad(energia, hop_s)
    altura, confianza = contorno_melodico(saliencia, midis, hop_s)
    altura_bajo, confianza_bajo = contorno_melodico(saliencia_bajo, midis_bajo, hop_s)
    energia_tonal_db = uniform_filter1d(10.0 * np.log10(energia_tonal + 1e-10), size=5)

    secciones = detectar_secciones(mel_db, intensidad, env, hop_s, fase, bpm_final, duracion, compas)

    return Analisis(
        sr=sr, duracion=duracion, hop_s=hop_s,
        env=env, env_bajo=env_bajo, env_medio=env_medio, env_alto=env_alto,
        onsets=onsets, fuerzas=fuerzas,
        bpm=bpm_final, offset=fase, compas=compas,
        intensidad=intensidad, altura=altura, confianza_melodia=confianza,
        energia_tonal_db=energia_tonal_db.astype(np.float32),
        secciones=secciones,
        capas=capas,
        altura_bajo=altura_bajo,
        confianza_bajo=confianza_bajo,
    )
