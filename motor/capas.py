"""Separación de la música en capas por instrumento.

Se usa HPSS (separación armónico/percusiva por filtros de mediana) sobre un
espectrograma mel de 128 bandas: lo que es horizontal en el tiempo (notas
sostenidas) es armónico; lo que es vertical en frecuencia (golpes de banda
ancha) es percusivo. Luego cada parte se divide por rango de frecuencia:

    percusión: bombo (<150 Hz) · caja (180 Hz–4 kHz) · platillos (>5 kHz)
    melodía:   bajo (<250 Hz) · melodía/voz (250 Hz–5 kHz)

No es una separación de fuentes perfecta (no distingue una voz de una guitarra
en el mismo registro), pero alcanza para decidir qué golpe viene de qué capa y
dejar que el usuario elija cuánto peso dar a la percusión y a la melodía.
"""

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import median_filter, uniform_filter1d

N_MEL_FINO = 128

# nombre, familia, parte (p = percusiva, h = armónica), fmin, fmax
DEFINICION = (
    ("bombo", "percusion", "p", 0.0, 150.0),
    ("caja", "percusion", "p", 180.0, 4000.0),
    ("platillos", "percusion", "p", 5000.0, 1e9),
    ("bajo", "melodia", "h", 0.0, 250.0),
    ("melodia", "melodia", "h", 250.0, 5000.0),
)
NOMBRES = tuple(d[0] for d in DEFINICION)
PERCUSION = tuple(d[0] for d in DEFINICION if d[1] == "percusion")
MELODIA = tuple(d[0] for d in DEFINICION if d[1] == "melodia")


@dataclass
class Capa:
    nombre: str
    familia: str
    env: np.ndarray        # envolvente de ataques, normalizada por familia
    actividad: np.ndarray  # fuerza de ataques por segundo, suavizada, 0..1
    onsets: np.ndarray
    fuerzas: np.ndarray


def hpss(potencia: np.ndarray, hop_s: float, bandas_freq: int = 9):
    """Devuelve (armónica, percusiva) con máscaras suaves de Wiener."""
    largo_t = max(3, int(0.25 / hop_s) | 1)
    armonica = median_filter(potencia, size=(largo_t, 1), mode="nearest")
    percusiva = median_filter(potencia, size=(1, bandas_freq), mode="nearest")
    a2, p2 = armonica ** 2, percusiva ** 2
    total = a2 + p2 + 1e-20
    return potencia * (a2 / total), potencia * (p2 / total)


def _env_ataques(comprimida: np.ndarray) -> np.ndarray:
    """Flujo sobre una compresión log1p relativa al nivel fuerte de cada banda.

    A diferencia de los dB, un sonido 30 dB por debajo de lo habitual en la
    banda (la fuga de otro instrumento) casi no genera ataques."""
    flujo = np.maximum(0.0, np.diff(comprimida, axis=0, prepend=comprimida[:1]))
    return flujo.mean(axis=1)


def separar(mel_fino: np.ndarray, centros: np.ndarray, hop_s: float, detectar_onsets) -> dict:
    """`mel_fino`: potencia mel (frames x 128). Devuelve {nombre: Capa}."""
    armonica, percusiva = hpss(mel_fino, hop_s)
    # La referencia de cada banda sale de la mezcla completa: así la fuga de una
    # parte en la otra queda en su nivel real (débil) y no se amplifica.
    referencia = np.percentile(mel_fino, 99, axis=0, keepdims=True) + 1e-12
    comprimidas = {"p": np.log1p(100.0 * percusiva / referencia),
                   "h": np.log1p(100.0 * armonica / referencia)}
    crudas = {}
    for nombre, familia, parte, fmin, fmax in DEFINICION:
        bandas = (centros >= fmin) & (centros < fmax)
        if bandas.any():
            crudas[nombre] = _env_ataques(comprimidas[parte][:, bandas])
    # Normalización común por familia: las capas quedan comparables entre sí.
    escala = {}
    for familia in ("percusion", "melodia"):
        valores = [crudas[d[0]] for d in DEFINICION if d[1] == familia and d[0] in crudas]
        escala[familia] = float(np.percentile(np.max(valores, axis=0), 99.5)) + 1e-9
    capas = {}
    n_frames = mel_fino.shape[0]
    for nombre, familia, parte, fmin, fmax in DEFINICION:
        if nombre not in crudas:
            continue
        env = np.clip(crudas[nombre] / escala[familia], 0, 1.5).astype(np.float32)
        onsets, fuerzas = detectar_onsets(env, hop_s, delta=0.08)
        # Actividad: fuerza de los ataques por segundo (lo que importa para mapear).
        golpes = np.zeros(n_frames, dtype=np.float32)
        if onsets.size:
            indices = np.clip(np.rint(onsets / hop_s).astype(int), 0, n_frames - 1)
            np.add.at(golpes, indices, fuerzas)
        actividad = uniform_filter1d(golpes, size=max(3, int(1.0 / hop_s))) / hop_s
        capas[nombre] = Capa(nombre, familia, env, actividad, onsets, fuerzas)
    # Actividad normalizada por familia, para comparar capas entre sí.
    for familia in ("percusion", "melodia"):
        miembros = [c for c in capas.values() if c.familia == familia]
        if miembros:
            tope = float(np.percentile(np.max([c.actividad for c in miembros], axis=0), 98)) + 1e-9
            for c in miembros:
                c.actividad = np.clip(c.actividad / tope, 0, 1).astype(np.float32)
    return capas
