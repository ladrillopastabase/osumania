import io
import subprocess
import zipfile

import numpy as np
import pytest
from scipy.io import wavfile

import app as aplicacion
from motor.analisis import analizar
from motor.audio import cargar_audio
from motor.exportador import Metadatos, exportar_osu
from motor.generador import OpcionesGeneracion, generar_mapa
from motor.recorte import ajustar_a_compas, recortar_audio, recortar_mapa, vista_recortada
from sintetico import SR, cancion, cancion_capas


@pytest.fixture(scope="module")
def analisis():
    return analizar(cancion(150, 40, 0.5), SR)


def test_ajustar_a_compas(analisis):
    compas = analisis.periodo * 4
    t = ajustar_a_compas(analisis, 10.3)
    assert abs(((t - analisis.offset) / compas) - round((t - analisis.offset) / compas)) < 1e-6
    assert abs(t - 10.3) <= compas / 2


def test_vista_y_mapa_recortados(analisis):
    inicio, fin = ajustar_a_compas(analisis, 8.0), ajustar_a_compas(analisis, 30.0)
    mapa = generar_mapa(analisis, OpcionesGeneracion(4, "Hard", holds=2.5))
    recortado = recortar_mapa(mapa, inicio, fin, analisis.periodo, fundido=2.0)
    vista = vista_recortada(analisis, inicio, fin)
    assert vista.duracion == pytest.approx(fin - inicio)
    assert 0 <= vista.offset < analisis.periodo * 4
    # El tiempo fuerte sigue siendo el mismo, solo desplazado.
    assert ((analisis.offset - inicio - vista.offset) / analisis.periodo) % 1 == pytest.approx(0, abs=1e-6)
    originales = [n for n in mapa.notas if inicio <= n.tiempo < fin - 1.0]
    assert recortado.notas and len(recortado.notas) >= len(originales)
    for n in recortado.notas:
        assert 0 <= n.tiempo < vista.duracion - 0.39
        assert n.fin is None or n.fin <= vista.duracion - 0.39
    texto = exportar_osu(recortado, vista, Metadatos())
    punto = texto.split("[TimingPoints]")[1].split()[0]
    assert int(punto.split(",")[0]) == round(vista.offset * 1000)


def test_recorte_de_audio_preciso(tmp_path):
    senal, eventos, _ = cancion_capas()
    origen = tmp_path / "c.wav"
    wavfile.write(origen, SR, (senal * 30000).astype(np.int16))
    destino = recortar_audio(origen, tmp_path / "r.mp3", 13.3, 26.1, fundido=1.0)
    senal_r, sr = cargar_audio(destino)
    assert senal_r.size / sr == pytest.approx(12.8, abs=0.06)
    analisis_r = analizar(senal_r, sr)
    # Los golpes de la batería (13.3 s en adelante) caen en el mismo lugar, desplazados.
    esperados = np.array([t - 13.3 for t, i, _ in eventos if i == "bombo" and 13.3 <= t < 25.0])
    errores = [np.min(np.abs(analisis_r.capas["bombo"].onsets - t)) for t in esperados]
    assert np.median(errores) < 0.012


@pytest.fixture()
def cliente(tmp_path, monkeypatch):
    monkeypatch.setattr(aplicacion, "TRABAJOS", tmp_path / "trabajos")
    aplicacion.app.config["TESTING"] = True
    return aplicacion.app.test_client()


def _wav(segundos=40):
    buffer = io.BytesIO()
    wavfile.write(buffer, SR, (cancion(140, segundos, 0.3) * 32000).astype(np.int16))
    buffer.seek(0)
    return buffer


def test_recorte_en_la_api(cliente):
    creado = cliente.post("/api/trabajos", data={"audio": (_wav(), "x.wav")},
                          content_type="multipart/form-data").get_json()
    url = f"/api/trabajos/{creado['id']}/generar"
    datos = cliente.post(url, data={"teclas": "4", "dificultades": "Normal", "recorte_inicio": "10",
                                    "recorte_fin": "30", "fundido": "2"}).get_json()
    recorte = datos["recorte"]
    compas = 4 * 60 / datos["analisis"]["bpm"]
    offset = datos["analisis"]["offset_ms"] / 1000
    for extremo, pedido in ((recorte["inicio"], 10), (recorte["fin"], 30)):
        assert abs(extremo - pedido) <= compas / 2 + 1e-3  # al compás más cercano
        compases = (extremo - offset) / compas
        assert abs(compases - round(compases)) < 1e-3
    assert datos["reproduccion"]["duracion"] == pytest.approx(recorte["fin"] - recorte["inicio"], abs=1e-3)
    assert max(n[0] for n in datos["mapas"][0]["notas"]) < datos["reproduccion"]["duracion"] * 1000
    with zipfile.ZipFile(io.BytesIO(cliente.get(datos["osz"]).data)) as zf:
        nombres = zf.namelist()
        osu = zf.read([n for n in nombres if n.endswith(".osu")][0]).decode()
    assert "audio_recorte.mp3" in nombres and "audio.mp3" not in nombres
    assert "AudioFilename: audio_recorte.mp3" in osu
    audio = cliente.get(datos["audio"]).data
    assert len(audio) > 1000

    # Volver a la canción completa.
    completo = cliente.post(url, data={"teclas": "4", "dificultades": "Normal"}).get_json()
    assert completo["recorte"] is None
    with zipfile.ZipFile(io.BytesIO(cliente.get(completo["osz"]).data)) as zf:
        assert "audio.mp3" in zf.namelist()


def test_recorte_demasiado_corto(cliente):
    creado = cliente.post("/api/trabajos", data={"audio": (_wav(), "x.wav")},
                          content_type="multipart/form-data").get_json()
    respuesta = cliente.post(f"/api/trabajos/{creado['id']}/generar",
                             data={"recorte_inicio": "10", "recorte_fin": "14"})
    assert respuesta.status_code == 400
