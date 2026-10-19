import numpy as np
import pytest

from motor.analisis import analizar
from sintetico import SR, cancion, clics


@pytest.mark.parametrize("bpm,offset", [(128, 0.3), (150, 0.5), (174, 1.0), (200, 0.4)])
def test_detecta_bpm_y_fase(bpm, offset):
    a = analizar(cancion(bpm, 30, offset), SR)
    assert a.bpm == pytest.approx(bpm, abs=0.05)
    periodo = 60 / bpm
    fase = ((a.offset - offset) / periodo) % 1
    assert min(fase, 1 - fase) * periodo < 0.010  # menos de 10 ms


def test_offset_cae_en_tiempo_fuerte():
    a = analizar(cancion(150, 30, 0.5), SR)
    compas = 4 * 60 / 150
    distancia = ((a.offset - 0.5) / compas) % 1
    assert min(distancia, 1 - distancia) * compas < 0.010


def test_onsets_precisos():
    tiempos = np.arange(0.5, 15, 0.37)
    a = analizar(clics(tiempos, 16), SR)
    assert a.onsets.size == tiempos.size
    errores = [abs(a.onsets[np.argmin(abs(a.onsets - t))] - t) for t in tiempos]
    assert max(errores) < 0.012


def test_bpm_forzado():
    a = analizar(cancion(150, 20, 0.5), SR, bpm=75)
    assert a.bpm == 75


def test_resumen_serializable():
    import json
    a = analizar(cancion(140, 20, 0.2), SR)
    resumen = a.resumen()
    json.dumps(resumen)
    assert resumen["secciones"][0]["inicio"] == 0
    assert resumen["secciones"][-1]["fin"] == pytest.approx(a.duracion, abs=1e-3)
