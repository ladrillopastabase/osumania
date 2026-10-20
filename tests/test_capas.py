"""El mapa sigue al instrumento destacado y respeta la influencia de cada capa."""

import numpy as np
import pytest

from motor.analisis import analizar
from motor.dificultades import perfil
from motor.generador import OpcionesGeneracion, construir_eventos, generar_mapa
from sintetico import SR, cancion_capas


@pytest.fixture(scope="module")
def turnos():
    senal, eventos, partes = cancion_capas()
    return analizar(senal, SR), eventos, partes


def _en_parte(notas, parte):
    inicio, fin = parte
    return [n for n in notas if inicio - 0.01 <= n.tiempo < fin - 0.01]


def test_destacado_por_parte(turnos):
    analisis, _, partes = turnos
    eventos = construir_eventos(analisis, perfil("Hard", 4), OpcionesGeneracion(4, "Hard"))
    destacados = {e.compas: e.destacado for e in eventos}
    compas = analisis.periodo * 4

    def destacados_en(parte):
        inicio, fin = partes[parte]
        return {destacados.get(int(round((t - analisis.offset) / compas)))
                for t in np.arange(inicio, fin - 1e-3, compas)}

    assert destacados_en("bajo") == {"bajo"}
    assert destacados_en("bateria") <= {"bombo", "caja", "platillos"}
    assert destacados_en("voz") == {"melodia"}


def test_controles_por_capa(turnos):
    analisis, _, partes = turnos
    solo = {c: 0.0 for c in ("bombo", "caja", "platillos", "bajo", "melodia")}
    solo_bajo = generar_mapa(analisis, OpcionesGeneracion(4, "Hard", capas={**solo, "bajo": 1.0}))
    solo_bateria = generar_mapa(analisis, OpcionesGeneracion(
        4, "Hard", capas={**solo, "bombo": 1.0, "caja": 1.0, "platillos": 1.0}))
    # Con solo el bajo, la parte del bajo tiene notas y la de batería casi nada (solo relleno).
    assert len(_en_parte(solo_bajo.notas, partes["bajo"])) > 3 * len(_en_parte(solo_bajo.notas, partes["bateria"]))
    assert len(_en_parte(solo_bateria.notas, partes["bateria"])) > 2 * len(_en_parte(solo_bateria.notas, partes["bajo"]))
    with pytest.raises(ValueError):
        OpcionesGeneracion(capas=solo)
    with pytest.raises(ValueError):
        OpcionesGeneracion(capas={"guitarra": 1.0})


def test_notas_siguen_al_bajo(turnos):
    analisis, eventos, partes = turnos
    bajos = [(t, nota) for t, instrumento, nota in eventos if instrumento == "bajo"]
    tiempos = np.array([t for t, _ in bajos])
    mapa = generar_mapa(analisis, OpcionesGeneracion(7, "Hard"))
    columnas = {}
    for n in _en_parte(mapa.notas, partes["bajo"]):
        columnas.setdefault(round(n.tiempo, 4), []).append(n.columna)
    secuencia = []
    for t, cols in sorted(columnas.items()):
        j = int(np.argmin(np.abs(tiempos - t)))
        assert abs(tiempos[j] - t) < 0.025  # cada nota cae en una nota del bajo
        secuencia.append((np.mean(cols), bajos[j][1]))
    acuerdos = [np.sign(c2 - c1) == np.sign(a2 - a1)
                for (c1, a1), (c2, a2) in zip(secuencia, secuencia[1:]) if a2 != a1]
    assert np.mean(acuerdos) >= 0.8  # la columna sube y baja con el bajo


@pytest.mark.parametrize("dificultad", ["Normal", "Insane"])
def test_holds_siguen_a_la_voz(turnos, dificultad):
    analisis, eventos, partes = turnos
    voces = [(t, duracion) for t, instrumento, duracion in eventos if instrumento == "voz"]
    mapa = generar_mapa(analisis, OpcionesGeneracion(4, dificultad))
    holds = [n for n in _en_parte(mapa.notas, partes["voz"]) if n.es_hold]
    errores = []
    for t, duracion in voces:
        candidatos = [n for n in holds if abs(n.tiempo - t) < 0.03]
        if candidatos:
            errores.append(abs((candidatos[0].fin - candidatos[0].tiempo) - duracion) / analisis.periodo)
    assert len(errores) >= 0.5 * len(voces)  # la mayoría de las notas largas son holds
    assert np.mean(errores) <= 0.5  # y duran lo que dura la nota cantada
