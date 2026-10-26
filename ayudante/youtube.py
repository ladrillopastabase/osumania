"""Ayudante de YouTube para el generador de beatmaps.

Una página estática (GitHub Pages) no puede bajar audio de YouTube: el navegador
lo impide (CORS) y YouTube cifra los enlaces. Este programa corre yt-dlp en tu
computador y le entrega el audio a la página.

    pip install "yt-dlp[default]"
    python youtube.py

y deja la ventana abierta mientras usas la página. También se puede desplegar en
un servidor (ver el README); solo usa la biblioteca estándar de Python y yt-dlp.

Rutas (todas GET, con CORS para la página):
    /estado                 {"ok": true, "version": ...}
    /audio?url=<enlace>     el audio (webm/opus o m4a); metadatos en la cabecera X-Metadatos
    /miniatura?url=<enlace> la miniatura del video
"""

import argparse
import json
import mimetypes
import os
import re
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

PUERTO = 8787
DOMINIOS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
DURACION_MAXIMA = 15 * 60  # segundos
EXTENSIONES_MINIATURA = (".jpg", ".jpeg", ".png", ".webp")
# Páginas que pueden usar el ayudante: GitHub Pages y pruebas locales. Así otra web
# que visites no puede usarlo a escondidas. Se agregan más con --origen.
ORIGENES_DEFECTO = [r"https://[a-z0-9-]+\.github\.io", r"https?://(localhost|127\.0\.0\.1)(:\d+)?"]


class ErrorDescarga(Exception):
    pass


def es_url_youtube(url: str) -> bool:
    try:
        partes = urlparse(url.strip())
    except ValueError:
        return False
    return partes.scheme in ("http", "https") and (partes.hostname or "").lower() in DOMINIOS


def separar_artista(titulo: str) -> tuple[str | None, str]:
    """'Artista - Tema (Official Video)' -> ('Artista', 'Tema (Official Video)')."""
    for separador in (" - ", " – ", " — "):
        if separador in titulo:
            artista, tema = titulo.split(separador, 1)
            return artista.strip(), tema.strip()
    return None, titulo.strip()


def runtimes_js() -> dict | None:
    """YouTube exige ejecutar JavaScript: se usa el que esté instalado (Deno, Node o Bun)."""
    encontrados = {nombre: {} for nombre in ("deno", "node", "bun") if shutil.which(nombre)}
    return encontrados or None


class Descargador:
    """Baja el audio con yt-dlp y lo guarda por id de video (no se descarga dos veces)."""

    def __init__(self, carpeta: Path):
        self.carpeta = carpeta
        self.carpeta.mkdir(parents=True, exist_ok=True)
        self.candado = threading.Lock()

    def descargar(self, url: str) -> dict:
        """{audio: Path, miniatura: Path | None, titulo, artista, duracion}."""
        if not es_url_youtube(url):
            raise ErrorDescarga("El enlace no es de YouTube.")
        try:
            import yt_dlp
        except ImportError as error:
            raise ErrorDescarga('Falta instalar yt-dlp: pip install "yt-dlp[default]"') from error

        def filtro(info, *, incomplete):
            if info.get("is_live"):
                return "No se pueden usar transmisiones en vivo."
            if (info.get("duration") or 0) > DURACION_MAXIMA:
                return f"El video dura más de {DURACION_MAXIMA // 60} minutos."
            return None

        opciones = {
            # Opus (webm) lo decodifican todos los Chrome/Edge/Firefox, incluso los que
            # no traen AAC; m4a queda de respaldo. Ninguno necesita ffmpeg.
            "format": "bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": str(self.carpeta / "%(id)s.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "match_filter": filtro,
            "writethumbnail": True,
            "js_runtimes": runtimes_js(),
        }
        with self.candado:  # una descarga a la vez: YouTube castiga las ráfagas
            try:
                with yt_dlp.YoutubeDL(opciones) as ydl:
                    info = ydl.extract_info(url.strip(), download=True) or {}
            except Exception as error:  # yt-dlp lanza varios tipos de error
                mensaje = str(error).replace("ERROR: ", "").strip()
                raise ErrorDescarga(f"No se pudo descargar el audio: {mensaje[:300]}") from error
        identificador = info.get("id") or ""
        archivos = [p for p in self.carpeta.glob(f"{glob_escapar(identificador)}.*") if not p.name.endswith(".part")]
        audio = next((p for p in archivos if p.suffix.lower() not in EXTENSIONES_MINIATURA), None)
        if audio is None:
            raise ErrorDescarga(filtro(info, incomplete=False) or "No se pudo descargar el audio.")
        miniatura = next((p for p in archivos if p.suffix.lower() in EXTENSIONES_MINIATURA), None)
        artista_titulo, tema = separar_artista(info.get("title") or "YouTube")
        return {
            "audio": audio,
            "miniatura": miniatura,
            "titulo": info.get("track") or tema,
            "artista": info.get("artist") or artista_titulo or info.get("uploader") or "Desconocido",
            "duracion": info.get("duration"),
        }


def glob_escapar(texto: str) -> str:
    return re.sub(r"([*?\[\]])", r"[\1]", texto)


def crear_manejador(descargador: Descargador, origenes: list[str]):
    permitidos = [re.compile(f"^{o}$") for o in origenes if o != "*"]
    cualquiera = "*" in origenes

    class Manejador(BaseHTTPRequestHandler):
        server_version = "AyudanteYouTube/1.0"

        def log_message(self, formato, *args):
            sys.stderr.write("  " + (formato % args) + "\n")

        def _origen_valido(self) -> bool:
            origen = self.headers.get("Origin")
            return origen is None or cualquiera or any(p.match(origen) for p in permitidos)

        def _cors(self):
            origen = self.headers.get("Origin")
            if origen and self._origen_valido():
                self.send_header("Access-Control-Allow-Origin", origen)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "*")
                self.send_header("Access-Control-Expose-Headers", "X-Metadatos")
                # Chrome pide permiso explícito para que una web pública hable con 127.0.0.1.
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def _json(self, codigo: int, datos: dict):
            cuerpo = json.dumps(datos, ensure_ascii=False).encode()
            self.send_response(codigo)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(cuerpo)))
            self.end_headers()
            self.wfile.write(cuerpo)

        def _archivo(self, ruta: Path, extra: dict | None = None):
            tipo = mimetypes.guess_type(ruta.name)[0] or "application/octet-stream"
            if ruta.suffix.lower() == ".m4a":
                tipo = "audio/mp4"
            elif ruta.suffix.lower() in (".webm", ".weba"):
                tipo = "audio/webm"
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", tipo)
            self.send_header("Content-Length", str(ruta.stat().st_size))
            for clave, valor in (extra or {}).items():
                self.send_header(clave, valor)
            self.end_headers()
            with ruta.open("rb") as archivo:
                shutil.copyfileobj(archivo, self.wfile)

        def do_OPTIONS(self):
            self.send_response(204 if self._origen_valido() else 403)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if not self._origen_valido():
                self._json(403, {"error": "Esta página no está autorizada a usar el ayudante (ver --origen)."})
                return
            partes = urlparse(self.path)
            url = (parse_qs(partes.query).get("url") or [""])[0]
            try:
                if partes.path == "/estado":
                    try:
                        import yt_dlp
                        version = yt_dlp.version.__version__
                    except ImportError:
                        version = None
                    self._json(200, {"ok": version is not None, "version": version,
                                     "js": sorted(runtimes_js() or {})})
                elif partes.path == "/audio":
                    datos = descargador.descargar(url)
                    meta = {"titulo": datos["titulo"], "artista": datos["artista"], "duracion": datos["duracion"],
                            "extension": datos["audio"].suffix.lstrip("."), "miniatura": datos["miniatura"] is not None}
                    self._archivo(datos["audio"], {"X-Metadatos": quote(json.dumps(meta, ensure_ascii=False))})
                elif partes.path == "/miniatura":
                    datos = descargador.descargar(url)  # ya está en caché: no vuelve a bajar
                    if datos["miniatura"] is None:
                        self._json(404, {"error": "El video no tiene miniatura."})
                    else:
                        self._archivo(datos["miniatura"])
                else:
                    self._json(404, {"error": "Ruta desconocida."})
            except ErrorDescarga as error:
                self._json(400, {"error": str(error)})
            except (BrokenPipeError, ConnectionResetError):
                pass  # la página cerró la conexión

    return Manejador


def main(argumentos=None):
    analizador = argparse.ArgumentParser(description="Ayudante de YouTube para el generador de beatmaps.")
    analizador.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"),
                            help="0.0.0.0 para usarlo como servidor en la nube (por defecto, solo este equipo)")
    analizador.add_argument("--puerto", type=int, default=int(os.environ.get("PORT", PUERTO)))
    analizador.add_argument("--origen", action="append", default=[],
                            help="otra página autorizada (regex de origen, p. ej. https://midominio\\.com) o * para todas")
    analizador.add_argument("--carpeta", default=os.path.join(tempfile.gettempdir(), "ayudante-youtube"),
                            help="dónde guardar los audios descargados")
    opciones = analizador.parse_args(argumentos)
    origenes = ORIGENES_DEFECTO + opciones.origen + [o for o in os.environ.get("ORIGENES", "").split() if o]

    try:
        import yt_dlp
        print(f"yt-dlp {yt_dlp.version.__version__}")
    except ImportError:
        print('Falta yt-dlp. Instálalo con:  pip install "yt-dlp[default]"')
        return 1
    if runtimes_js() is None:
        print("Aviso: no se encontró Deno, Node ni Bun. YouTube puede fallar sin un intérprete de JavaScript;\n"
              "       instala Deno (https://deno.com) o Node (https://nodejs.org).")
    servidor = ThreadingHTTPServer((opciones.host, opciones.puerto),
                                   crear_manejador(Descargador(Path(opciones.carpeta)), origenes))
    print(f"Ayudante de YouTube listo en http://{opciones.host}:{opciones.puerto}")
    print("Deja esta ventana abierta mientras usas la página. Ctrl+C para salir.")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
