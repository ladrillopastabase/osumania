"""Pruebas del ayudante (sin red: la descarga se reemplaza por una falsa).

    python -m unittest discover ayudante
"""

import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, unquote
from urllib.request import Request, urlopen

import youtube


class DescargadorFalso:
    def __init__(self, carpeta: Path):
        self.audio = carpeta / "abc.m4a"
        self.audio.write_bytes(b"\x00\x00\x00\x18ftypM4A " + bytes(1000))
        self.miniatura = carpeta / "abc.webp"
        self.miniatura.write_bytes(b"RIFF....WEBP")
        self.llamadas = []

    def descargar(self, url):
        self.llamadas.append(url)
        if not youtube.es_url_youtube(url):
            raise youtube.ErrorDescarga("El enlace no es de YouTube.")
        return {"audio": self.audio, "miniatura": self.miniatura, "titulo": "Ghost",
                "artista": "Camellia", "duracion": 200}


class PruebasFunciones(unittest.TestCase):
    def test_acepta_enlaces_de_youtube(self):
        for url in ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ",
                    "https://music.youtube.com/watch?v=abc", "http://m.youtube.com/watch?v=abc"]:
            self.assertTrue(youtube.es_url_youtube(url), url)

    def test_rechaza_otros_enlaces(self):
        for url in ["https://example.com/watch?v=abc", "https://youtube.com.evil.net/x", "file:///etc/passwd",
                    "ftp://youtube.com/x", "no es un enlace"]:
            self.assertFalse(youtube.es_url_youtube(url), url)
            with self.assertRaises(youtube.ErrorDescarga):
                youtube.Descargador(Path(tempfile.mkdtemp())).descargar(url)

    def test_separar_artista(self):
        self.assertEqual(youtube.separar_artista("Camellia - Ghost (Official Video)"), ("Camellia", "Ghost (Official Video)"))
        self.assertEqual(youtube.separar_artista("Solo un título"), (None, "Solo un título"))


class PruebasServidor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.descargador = DescargadorFalso(Path(tempfile.mkdtemp()))
        manejador = youtube.crear_manejador(cls.descargador, youtube.ORIGENES_DEFECTO)
        cls.servidor = ThreadingHTTPServer(("127.0.0.1", 0), manejador)
        cls.base = f"http://127.0.0.1:{cls.servidor.server_address[1]}"
        threading.Thread(target=cls.servidor.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.servidor.shutdown()

    def pedir(self, ruta, origen="https://usuario.github.io", metodo="GET"):
        cabeceras = {"Origin": origen} if origen else {}
        try:
            with urlopen(Request(self.base + ruta, headers=cabeceras, method=metodo)) as r:
                return r.status, dict(r.headers), r.read()
        except HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def test_estado(self):
        codigo, cabeceras, cuerpo = self.pedir("/estado")
        self.assertEqual(codigo, 200)
        self.assertTrue(json.loads(cuerpo)["ok"])
        self.assertEqual(cabeceras["Access-Control-Allow-Origin"], "https://usuario.github.io")

    def test_audio_con_metadatos(self):
        url = quote("https://www.youtube.com/watch?v=abc", safe="")
        codigo, cabeceras, cuerpo = self.pedir(f"/audio?url={url}", origen="http://localhost:8000")
        self.assertEqual(codigo, 200)
        self.assertEqual(cabeceras["Content-Type"], "audio/mp4")
        self.assertEqual(cuerpo, self.descargador.audio.read_bytes())
        self.assertIn("X-Metadatos", cabeceras["Access-Control-Expose-Headers"])
        meta = json.loads(unquote(cabeceras["X-Metadatos"]))
        self.assertEqual((meta["titulo"], meta["artista"], meta["extension"], meta["miniatura"]),
                         ("Ghost", "Camellia", "m4a", True))
        codigo, _, cuerpo = self.pedir(f"/miniatura?url={url}")
        self.assertEqual((codigo, cuerpo), (200, b"RIFF....WEBP"))

    def test_enlace_invalido(self):
        codigo, cabeceras, cuerpo = self.pedir("/audio?url=https%3A%2F%2Fexample.com%2Fx")
        self.assertEqual(codigo, 400)
        self.assertIn("YouTube", json.loads(cuerpo)["error"])
        self.assertIn("Access-Control-Allow-Origin", cabeceras)  # la página puede leer el error

    def test_rechaza_otras_paginas(self):
        antes = len(self.descargador.llamadas)
        codigo, cabeceras, _ = self.pedir("/audio?url=https%3A%2F%2Fyoutu.be%2Fabc", origen="https://malvada.example")
        self.assertEqual(codigo, 403)
        self.assertNotIn("Access-Control-Allow-Origin", cabeceras)
        self.assertEqual(len(self.descargador.llamadas), antes)  # no descargó nada

    def test_preflight_red_privada(self):
        codigo, cabeceras, _ = self.pedir("/audio", metodo="OPTIONS")
        self.assertEqual(codigo, 204)
        self.assertEqual(cabeceras["Access-Control-Allow-Private-Network"], "true")


if __name__ == "__main__":
    unittest.main()
