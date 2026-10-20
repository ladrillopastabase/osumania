"""Recorte de la canción: un tramo del audio y del mapa, con fundido al final.

El mapa se genera sobre la canción completa (el BPM y las secciones salen más
estables) y después se recorta: se quedan las notas del tramo, los holds que
pasan el final se acortan y todo se desplaza para que el tramo empiece en 0.
"""

import subprocess
from dataclasses import replace
from pathlib import Path

import numpy as np

from .analisis import Analisis, Seccion
from .audio import ErrorAudio, hay_ffmpeg
from .generador import Mapa, Nota

DURACION_MINIMA = 10.0  # s
MARGEN_FINAL = 0.4      # s sin notas antes de que termine el audio recortado


def ajustar_a_compas(analisis: Analisis, t: float) -> float:
    """Lleva `t` al inicio de compás más cercano (dentro de la canción)."""
    compas = analisis.periodo * analisis.compas
    ajustado = analisis.offset + round((t - analisis.offset) / compas) * compas
    if ajustado < 0:
        ajustado += compas
    return float(np.clip(ajustado, 0.0, analisis.duracion))


def validar_tramo(analisis: Analisis, inicio: float, fin: float) -> tuple[float, float]:
    inicio = float(np.clip(inicio, 0.0, analisis.duracion))
    fin = float(np.clip(fin, 0.0, analisis.duracion))
    if fin - inicio < DURACION_MINIMA:
        raise ValueError(f"El tramo recortado debe durar al menos {DURACION_MINIMA:.0f} s.")
    return inicio, fin


def recortar_mapa(mapa: Mapa, inicio: float, fin: float, periodo: float, fundido: float = 0.0) -> Mapa:
    """Notas del tramo [inicio, fin), desplazadas para empezar en 0.

    Durante el fundido final solo quedan las notas de la primera mitad: así el
    mapa no termina con notas casi inaudibles.
    """
    limite = fin - max(MARGEN_FINAL, fundido / 2)
    notas = []
    minimo_hold = 0.5 * mapa.perfil.hold_min_pulsos * periodo  # holds que quedan muy cortos pasan a nota
    for n in mapa.notas:
        if not inicio - 1e-6 <= n.tiempo < limite:
            continue
        final = None
        if n.es_hold:
            final = min(n.fin, limite)
            if final - n.tiempo < minimo_hold:
                final = None
        notas.append(Nota(n.tiempo - inicio, n.columna, None if final is None else final - inicio))
    destacados = [(max(a, inicio) - inicio, min(b, fin) - inicio, capa)
                  for a, b, capa in mapa.destacados if b > inicio and a < fin]
    return replace(mapa, notas=notas, destacados=destacados)


def vista_recortada(analisis: Analisis, inicio: float, fin: float) -> Analisis:
    """El análisis visto desde el audio recortado (para exportar el .osu).

    El offset se corre al primer tiempo fuerte dentro del tramo; las secciones
    se recortan y desplazan (el kiai queda donde estaba).
    """
    compas = analisis.periodo * analisis.compas
    offset = analisis.offset - inicio
    offset -= np.floor(offset / compas) * compas  # primer compás que empieza en el tramo
    secciones = [Seccion(max(s.inicio, inicio) - inicio, min(s.fin, fin) - inicio,
                         s.intensidad, s.etiqueta, s.kiai)
                 for s in analisis.secciones if s.fin > inicio and s.inicio < fin]
    return replace(analisis, offset=float(offset), duracion=fin - inicio, secciones=secciones)


def recortar_audio(origen, destino, inicio: float, fin: float, fundido: float = 2.0) -> Path:
    """Corta el audio con ffmpeg (preciso al milisegundo) y aplica fundido al final."""
    if not hay_ffmpeg():
        raise ErrorAudio("Se necesita ffmpeg para recortar el audio.")
    destino = Path(destino)
    duracion = fin - inicio
    # atrim corta con precisión de muestra antes de los fundidos; asetpts reinicia
    # las marcas de tiempo para que los fundidos se midan desde el inicio del tramo.
    filtros = [f"atrim=start={inicio:.4f}:end={fin:.4f}", "asetpts=PTS-STARTPTS",
               "afade=t=in:st=0:d=0.02"]
    if fundido > 0:
        filtros.append(f"afade=t=out:st={max(0.0, duracion - fundido):.3f}:d={fundido:.3f}")
    comando = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(origen), "-af", ",".join(filtros),
               "-codec:a", "libmp3lame", "-q:a", "2", str(destino)]
    proceso = subprocess.run(comando, capture_output=True)
    if proceso.returncode != 0:
        raise ErrorAudio("No se pudo recortar el audio.")
    return destino
