import io
import subprocess

import numpy as np
import pytest
from scipy.io import wavfile

import app as aplicacion
from motor.audio import ErrorAudio
from motor.youtube import _separar_artista, descargar_audio, es_url_youtube
from sintetico import SR, cancion


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=abc",
    "http://m.youtube.com/watch?v=abc",
])
def test_acepta_enlaces_de_youtube(url):
    assert es_url_youtube(url)


@pytest.mark.parametrize("url", [
    "https://example.com/watch?v=abc",
    "https://youtube.com.evil.net/x",
    "file:///etc/passwd",
    "ftp://youtube.com/x",
    "no es un enlace",
])
def test_rechaza_otros_enlaces(url):
    assert not es_url_youtube(url)
    with pytest.raises(ErrorAudio):
        descargar_audio(url, "/tmp/no-usar")


def test_separar_artista():
    assert _separar_artista("Camellia - Ghost (Official Video)") == ("Camellia", "Ghost (Official Video)")
    assert _separar_artista("Solo un título") == (None, "Solo un título")


@pytest.fixture()
def cliente(tmp_path, monkeypatch):
    monkeypatch.setattr(aplicacion, "TRABAJOS", tmp_path / "trabajos")

    def descarga_falsa(url, carpeta):
        ruta = carpeta / "youtube.wav"
        wavfile.write(ruta, SR, (cancion(150, 15, 0.4) * 32000).astype(np.int16))
        miniatura = carpeta / "youtube.webp"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=1280x720",
                        "-frames:v", "1", str(miniatura)], check=True)
        return ruta, {"titulo": "Tema", "artista": "Banda", "miniatura": miniatura}

    monkeypatch.setattr(aplicacion, "descargar_audio", descarga_falsa)
    aplicacion.app.config["TESTING"] = True
    return aplicacion.app.test_client()


def test_generar_desde_youtube(cliente):
    respuesta = cliente.post("/api/generar", data={
        "url": "https://youtu.be/abc", "teclas": "4", "dificultades": "Normal"})
    assert respuesta.status_code == 200, respuesta.get_json()
    datos = respuesta.get_json()
    assert datos["metadatos"] == {"titulo": "Tema", "artista": "Banda"}
    assert datos["analisis"]["bpm"] == pytest.approx(150, abs=0.05)
    osu = cliente.get(f"/api/trabajos/{datos['id']}/osu/0").data.decode()
    assert "Title:Tema" in osu and "Artist:Banda" in osu
    assert datos["fondo"] and cliente.get(datos["fondo"]).status_code == 200
    assert '0,0,"fondo.jpg",0,0' in osu
    audio = cliente.get(datos["audio"])
    assert audio.status_code == 200 and len(audio.data) > 1000


def test_rechaza_enlace_no_youtube(cliente):
    respuesta = cliente.post("/api/generar", data={"url": "https://example.com/a.mp3"})
    assert respuesta.status_code == 400


def test_sin_archivo_ni_enlace(cliente):
    assert cliente.post("/api/generar", data={}).status_code == 400
