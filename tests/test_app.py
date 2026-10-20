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


def test_regenerar_sin_volver_a_descargar(cliente, monkeypatch):
    creado = cliente.post("/api/trabajos", data={"audio": (_wav(), "Banda - Tema.wav")},
                          content_type="multipart/form-data")
    assert creado.status_code == 200, creado.get_json()
    trabajo = creado.get_json()
    assert trabajo["metadatos"]["titulo"] == "Banda - Tema"
    assert trabajo["analisis"]["bpm"] == pytest.approx(140, abs=0.05)

    # A partir de aquí no se debe volver a leer ni analizar el audio.
    def prohibido(*_args, **_kwargs):
        raise AssertionError("se volvió a analizar")
    monkeypatch.setattr(aplicacion, "analizar", prohibido)

    url = f"/api/trabajos/{trabajo['id']}/generar"
    primero = cliente.post(url, data={"teclas": "4", "dificultades": "Hard", "titulo": "Tema",
                                      "artista": "Banda", "percusion": "1", "melodia": "0"})
    assert primero.status_code == 200, primero.get_json()
    segundo = cliente.post(url, data={"teclas": "4,7", "dificultades": "Hard", "titulo": "Otro nombre",
                                      "artista": "Otra banda", "percusion": "0", "melodia": "1"})
    datos = segundo.get_json()
    assert [m["version"] for m in datos["mapas"]] == ["4K Hard", "7K Hard"]
    assert datos["metadatos"] == {"titulo": "Otro nombre", "artista": "Otra banda"}
    osu = cliente.get(f"/api/trabajos/{trabajo['id']}/osu/0").data.decode()
    assert "Title:Otro nombre" in osu and "Artist:Otra banda" in osu
    assert primero.get_json()["mapas"][0]["notas"] != datos["mapas"][0]["notas"]
    with zipfile.ZipFile(io.BytesIO(cliente.get(datos["osz"]).data)) as zf:
        assert sum(n.endswith(".osu") for n in zf.namelist()) == 2


def test_regenerar_con_bpm_forzado_reanaliza(cliente):
    creado = cliente.post("/api/trabajos", data={"audio": (_wav(), "x.wav")},
                          content_type="multipart/form-data").get_json()
    datos = cliente.post(f"/api/trabajos/{creado['id']}/generar",
                         data={"teclas": "4", "dificultades": "Easy", "bpm": "70"}).get_json()
    assert datos["analisis"]["bpm"] == 70


def test_regenerar_trabajo_inexistente(cliente):
    import uuid
    assert cliente.post(f"/api/trabajos/{uuid.uuid4()}/generar").status_code == 404


def test_influencia_por_capa_y_destacados(cliente):
    creado = cliente.post("/api/trabajos", data={"audio": (_wav(), "x.wav")},
                          content_type="multipart/form-data").get_json()
    url = f"/api/trabajos/{creado['id']}/generar"
    datos = cliente.post(url, data={"teclas": "4", "dificultades": "Hard", "capa_bombo": "1",
                                    "capa_caja": "0", "capa_platillos": "0", "capa_bajo": "0",
                                    "capa_melodia": "0.2"}).get_json()
    tramos = datos["mapas"][0]["destacados"]
    assert tramos and all(len(t) == 3 and t[0] < t[1] for t in tramos)
    nulos = {f"capa_{c}": "0" for c in ("bombo", "caja", "platillos", "bajo", "melodia")}
    assert cliente.post(url, data={"teclas": "4", **nulos}).status_code == 400
