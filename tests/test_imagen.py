import io
import subprocess
import zipfile

import numpy as np
import pytest
from scipy.io import wavfile

import app as aplicacion
from motor.imagen import elegir_fondo, extraer_portada, normalizar_imagen
from sintetico import SR, cancion


def _imagen(ruta, ancho=640, alto=360, color="red"):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:s={ancho}x{alto}",
                    "-frames:v", "1", str(ruta)], check=True)
    return ruta


def _wav(ruta, segundos=12):
    wavfile.write(ruta, SR, (cancion(140, segundos, 0.3) * 32000).astype(np.int16))
    return ruta


def _mp3_con_portada(tmp_path):
    portada = _imagen(tmp_path / "portada.png", 300, 300, "blue")
    destino = tmp_path / "con_portada.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(_wav(tmp_path / "a.wav")), "-i", str(portada),
                    "-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-c:v", "png",
                    "-disposition:v", "attached_pic", str(destino)], check=True)
    return destino


def _tamano(ruta):
    salida = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                             "stream=width,height", "-of", "csv=p=0", str(ruta)],
                            capture_output=True, text=True, check=True).stdout.strip()
    return tuple(int(x) for x in salida.split(","))


def test_normaliza_y_limita_ancho(tmp_path):
    grande = _imagen(tmp_path / "grande.webp", 3840, 2160)
    destino = normalizar_imagen(grande, tmp_path / "fondo.jpg")
    assert destino is not None and _tamano(destino) == (1920, 1080)


def test_extrae_portada_del_mp3(tmp_path):
    destino = extraer_portada(_mp3_con_portada(tmp_path), tmp_path / "fondo.jpg")
    assert destino is not None and _tamano(destino) == (300, 300)


def test_sin_portada_no_hay_fondo(tmp_path):
    assert extraer_portada(_wav(tmp_path / "b.wav"), tmp_path / "fondo.jpg") is None


def test_prioridad_imagen_subida(tmp_path):
    subida = _imagen(tmp_path / "subida.png", 800, 450)
    miniatura = _imagen(tmp_path / "mini.jpg", 1280, 720)
    destino = elegir_fondo(tmp_path / "fondo.jpg", imagen_subida=subida, miniatura=miniatura)
    assert _tamano(destino) == (800, 450)
    destino = elegir_fondo(tmp_path / "fondo2.jpg", miniatura=miniatura)
    assert _tamano(destino) == (1280, 720)


@pytest.fixture()
def cliente(tmp_path, monkeypatch):
    monkeypatch.setattr(aplicacion, "TRABAJOS", tmp_path / "trabajos")
    aplicacion.app.config["TESTING"] = True
    return aplicacion.app.test_client()


def test_fondo_en_osu_y_osz(cliente, tmp_path):
    mp3 = _mp3_con_portada(tmp_path)
    respuesta = cliente.post("/api/generar", data={
        "audio": (io.BytesIO(mp3.read_bytes()), "Banda - Tema.mp3"),
        "teclas": "4", "dificultades": "Easy"}, content_type="multipart/form-data")
    datos = respuesta.get_json()
    assert respuesta.status_code == 200, datos
    assert datos["fondo"]
    assert cliente.get(datos["fondo"]).status_code == 200
    osu = cliente.get(f"/api/trabajos/{datos['id']}/osu/0").data.decode()
    assert '0,0,"fondo.jpg",0,0' in osu
    with zipfile.ZipFile(io.BytesIO(cliente.get(datos["osz"]).data)) as zf:
        assert "fondo.jpg" in zf.namelist()


def test_imagen_subida_reemplaza_portada(cliente, tmp_path):
    imagen = _imagen(tmp_path / "mia.png", 1000, 500, "green")
    respuesta = cliente.post("/api/generar", data={
        "audio": (io.BytesIO(_mp3_con_portada(tmp_path).read_bytes()), "x.mp3"),
        "imagen": (io.BytesIO(imagen.read_bytes()), "mia.png"),
        "teclas": "4", "dificultades": "Easy"}, content_type="multipart/form-data")
    datos = respuesta.get_json()
    fondo = tmp_path / "descargado.jpg"
    fondo.write_bytes(cliente.get(datos["fondo"]).data)
    assert _tamano(fondo) == (1000, 500)


def test_rechaza_imagen_invalida(cliente, tmp_path):
    respuesta = cliente.post("/api/generar", data={
        "audio": (io.BytesIO(_wav(tmp_path / "c.wav").read_bytes()), "c.wav"),
        "imagen": (io.BytesIO(b"x"), "a.gif")}, content_type="multipart/form-data")
    assert respuesta.status_code == 400


def test_sin_fondo_cuando_no_hay_imagen(cliente, tmp_path):
    respuesta = cliente.post("/api/generar", data={
        "audio": (io.BytesIO(_wav(tmp_path / "d.wav").read_bytes()), "d.wav"),
        "teclas": "4", "dificultades": "Easy"}, content_type="multipart/form-data")
    datos = respuesta.get_json()
    assert datos["fondo"] is None
    osu = cliente.get(f"/api/trabajos/{datos['id']}/osu/0").data.decode()
    assert "fondo.jpg" not in osu
