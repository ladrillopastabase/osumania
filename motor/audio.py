"""Entrada de audio: decodificación y remuestreo a mono."""

import shutil
import subprocess
from pathlib import Path

import numpy as np

FRECUENCIA_ANALISIS = 22050
EXTENSIONES_ADMITIDAS = {".mp3", ".wav", ".flac", ".ogg"}


class ErrorAudio(Exception):
    pass


def hay_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def cargar_audio(ruta, sr: int = FRECUENCIA_ANALISIS) -> tuple[np.ndarray, int]:
    """Decodifica MP3/WAV/FLAC/OGG a una señal mono float32 en [-1, 1] a `sr` Hz."""
    ruta = Path(ruta)
    if not ruta.exists():
        raise ErrorAudio(f"No existe el archivo: {ruta}")
    if ruta.suffix.lower() not in EXTENSIONES_ADMITIDAS:
        raise ErrorAudio(f"Formato no admitido: {ruta.suffix}")

    if hay_ffmpeg():
        senal = _decodificar_ffmpeg(ruta, sr)
    elif ruta.suffix.lower() == ".wav":
        senal = _decodificar_wav(ruta, sr)
    else:
        raise ErrorAudio("Se necesita ffmpeg para decodificar MP3/FLAC/OGG.")

    if senal.size < sr:
        raise ErrorAudio("El audio dura menos de un segundo.")
    pico = float(np.max(np.abs(senal)))
    if pico > 0:
        senal = senal / pico
    return senal.astype(np.float32), sr


def _decodificar_ffmpeg(ruta: Path, sr: int) -> np.ndarray:
    comando = [
        "ffmpeg", "-v", "error", "-nostdin", "-i", str(ruta),
        "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(sr), "-",
    ]
    proceso = subprocess.run(comando, capture_output=True)
    if proceso.returncode != 0:
        raise ErrorAudio("ffmpeg no pudo decodificar el audio: "
                         + proceso.stderr.decode(errors="ignore")[-300:])
    return np.frombuffer(proceso.stdout, dtype=np.float32).copy()


def _decodificar_wav(ruta: Path, sr: int) -> np.ndarray:
    from scipy.io import wavfile
    from scipy.signal import resample_poly

    sr_original, datos = wavfile.read(str(ruta))
    if datos.dtype.kind == "i":
        datos = datos.astype(np.float32) / np.iinfo(datos.dtype).max
    elif datos.dtype.kind == "u":
        datos = (datos.astype(np.float32) - 128) / 128
    datos = datos.astype(np.float32)
    if datos.ndim > 1:
        datos = datos.mean(axis=1)
    if sr_original != sr:
        divisor = np.gcd(sr_original, sr)
        datos = resample_poly(datos, sr // divisor, sr_original // divisor)
    return datos.astype(np.float32)


def preparar_audio_osu(ruta_origen, carpeta_destino) -> Path:
    """Deja el audio en un formato que osu! reproduce (MP3/OGG).

    WAV y FLAC se transcodifican a MP3 con ffmpeg; MP3/OGG se copian tal cual.
    """
    ruta_origen = Path(ruta_origen)
    carpeta_destino = Path(carpeta_destino)
    carpeta_destino.mkdir(parents=True, exist_ok=True)
    if ruta_origen.suffix.lower() in {".mp3", ".ogg"}:
        destino = carpeta_destino / f"audio{ruta_origen.suffix.lower()}"
        shutil.copyfile(ruta_origen, destino)
        return destino
    if not hay_ffmpeg():
        destino = carpeta_destino / f"audio{ruta_origen.suffix.lower()}"
        shutil.copyfile(ruta_origen, destino)
        return destino
    destino = carpeta_destino / "audio.mp3"
    comando = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(ruta_origen),
               "-codec:a", "libmp3lame", "-q:a", "2", str(destino)]
    proceso = subprocess.run(comando, capture_output=True)
    if proceso.returncode != 0:
        raise ErrorAudio("No se pudo convertir el audio a MP3.")
    return destino
