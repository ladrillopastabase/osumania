"""Descarga del audio de un video de YouTube con yt-dlp."""

from pathlib import Path
from urllib.parse import urlparse

from .audio import ErrorAudio, hay_ffmpeg

DOMINIOS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
DURACION_MAXIMA = 15 * 60  # segundos


def es_url_youtube(url: str) -> bool:
    try:
        partes = urlparse(url.strip())
    except ValueError:
        return False
    return partes.scheme in ("http", "https") and (partes.hostname or "").lower() in DOMINIOS


def _separar_artista(titulo: str) -> tuple[str | None, str]:
    """'Artista - Tema (Official Video)' -> ('Artista', 'Tema (Official Video)')."""
    for separador in (" - ", " – ", " — "):
        if separador in titulo:
            artista, tema = titulo.split(separador, 1)
            return artista.strip(), tema.strip()
    return None, titulo.strip()


def descargar_audio(url: str, carpeta) -> tuple[Path, dict]:
    """Descarga el audio como MP3 en `carpeta`. Devuelve (ruta, {titulo, artista, miniatura})."""
    if not es_url_youtube(url):
        raise ErrorAudio("El enlace no es de YouTube.")
    if not hay_ffmpeg():
        raise ErrorAudio("Se necesita ffmpeg para extraer el audio de YouTube.")
    try:
        import yt_dlp
    except ImportError as error:
        raise ErrorAudio("Falta instalar yt-dlp (pip install yt-dlp).") from error

    carpeta = Path(carpeta)
    carpeta.mkdir(parents=True, exist_ok=True)

    def filtro(info, *, incomplete):
        duracion = info.get("duration")
        if info.get("is_live"):
            return "No se pueden usar transmisiones en vivo."
        if duracion and duracion > DURACION_MAXIMA:
            return f"El video dura más de {DURACION_MAXIMA // 60} minutos."
        return None

    opciones = {
        "format": "bestaudio/best",
        "outtmpl": str(carpeta / "youtube.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "match_filter": filtro,
        "writethumbnail": True,
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3",
                            "preferredquality": "2"}],
    }
    try:
        with yt_dlp.YoutubeDL(opciones) as ydl:
            info = ydl.extract_info(url.strip(), download=True)
    except Exception as error:  # yt-dlp lanza varios tipos de error
        mensaje = str(error).replace("ERROR: ", "").strip()
        raise ErrorAudio(f"No se pudo descargar el audio: {mensaje[:200]}") from error

    ruta = carpeta / "youtube.mp3"
    if not ruta.exists():
        motivo = filtro(info or {}, incomplete=False)
        raise ErrorAudio(motivo or "No se pudo descargar el audio.")

    titulo_video = (info or {}).get("title") or "YouTube"
    artista_titulo, tema = _separar_artista(titulo_video)
    miniaturas = [m for m in carpeta.glob("youtube.*") if m.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")]
    meta = {
        "titulo": info.get("track") or tema,
        "artista": info.get("artist") or artista_titulo or info.get("uploader") or "Desconocido",
        "miniatura": miniaturas[0] if miniaturas else None,
    }
    return ruta, meta
