"""Imagen de fondo del beatmap: portada del audio, miniatura de YouTube o imagen subida."""

import subprocess
from pathlib import Path

from .audio import hay_ffmpeg

EXTENSIONES_IMAGEN = {".jpg", ".jpeg", ".png", ".webp"}
ANCHO_MAXIMO = 1920


def normalizar_imagen(origen, destino) -> Path | None:
    """Convierte cualquier imagen a JPG de hasta 1920 px de ancho (lo que osu! espera)."""
    if not hay_ffmpeg():
        return None
    destino = Path(destino)
    comando = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(origen),
               "-vf", f"scale='min({ANCHO_MAXIMO},iw)':-2", "-frames:v", "1", "-q:v", "3", str(destino)]
    proceso = subprocess.run(comando, capture_output=True)
    if proceso.returncode != 0 or not destino.exists() or destino.stat().st_size == 0:
        destino.unlink(missing_ok=True)
        return None
    return destino


def extraer_portada(audio, destino) -> Path | None:
    """Saca la carátula incrustada en un MP3/FLAC/OGG, si tiene."""
    if not hay_ffmpeg():
        return None
    destino = Path(destino)
    comando = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(audio), "-an",
               "-map", "0:v:0", "-vf", f"scale='min({ANCHO_MAXIMO},iw)':-2",
               "-frames:v", "1", "-q:v", "3", str(destino)]
    proceso = subprocess.run(comando, capture_output=True)
    if proceso.returncode != 0 or not destino.exists() or destino.stat().st_size == 0:
        destino.unlink(missing_ok=True)
        return None
    return destino


def elegir_fondo(destino, imagen_subida=None, miniatura=None, audio=None) -> Path | None:
    """Prioridad: imagen subida por el usuario > miniatura de YouTube > portada del audio."""
    for origen in (imagen_subida, miniatura):
        if origen is not None and Path(origen).exists():
            resultado = normalizar_imagen(origen, destino)
            if resultado is not None:
                return resultado
    if audio is not None:
        return extraer_portada(audio, destino)
    return None
