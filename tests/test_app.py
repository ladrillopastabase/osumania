import io
import zipfile

import numpy as np
import pytest
from scipy.io import wavfile

import app as aplicacion
from sintetico import SR, cancion


@pytest.fixture()
def cliente(tmp_path, monkeypatch):
    monkeypatch.setattr(aplicacion, "TRABAJOS", tmp_path / "trabajos")
    aplicacion.app.config["TESTING"] = True
    return aplicacion.app.test_client()


def _wav(segundos=20):
    buffer = io.BytesIO()
    wavfile.write(buffer, SR, (cancion(140, segundos, 0.3) * 32000).astype(np.int16))
    buffer.seek(0)
    return buffer


def test_generar_y_descargar(cliente):
    respuesta = cliente.post("/api/generar", data={
        "audio": (_wav(), "Artista - Tema.wav"),
        "teclas": "4,7", "dificultades": "Easy,Insane",
        "titulo": "Tema", "artista": "Artista",
    }, content_type="multipart/form-data")
    assert respuesta.status_code == 200, respuesta.get_json()
    datos = respuesta.get_json()
    assert datos["analisis"]["bpm"] == pytest.approx(140, abs=0.05)
    assert [m["version"] for m in datos["mapas"]] == ["4K Easy", "4K Insane", "7K Easy", "7K Insane"]

    osu = cliente.get(f"/api/trabajos/{datos['id']}/osu/1")
    assert osu.status_code == 200
    assert b"Version:4K Insane" in osu.data

    osz = cliente.get(datos["osz"])
    assert osz.status_code == 200
    with zipfile.ZipFile(io.BytesIO(osz.data)) as zf:
        nombres = zf.namelist()
    assert "audio.mp3" in nombres
    assert sum(n.endswith(".osu") for n in nombres) == 4


def test_rechaza_formato(cliente):
    respuesta = cliente.post("/api/generar", data={"audio": (io.BytesIO(b"x"), "a.txt")},
                             content_type="multipart/form-data")
    assert respuesta.status_code == 400


def test_trabajo_inexistente(cliente):
    assert cliente.get("/api/trabajos/no-existe/osz").status_code == 404
