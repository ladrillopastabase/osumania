import pytest

from motor.analisis import analizar
from motor.dificultades import NOMBRES
from motor.generador import OpcionesGeneracion, generar_mapa
from motor.validador import validar
from sintetico import SR, cancion


@pytest.fixture(scope="module")
def analisis():
    return analizar(cancion(160, 45, 0.4), SR)


@pytest.mark.parametrize("teclas", [4, 7])
@pytest.mark.parametrize("dificultad", NOMBRES)
@pytest.mark.parametrize("estilo", ["hibrido", "ritmo", "melodia"])
def test_mapas_validos(analisis, teclas, dificultad, estilo):
    mapa = generar_mapa(analisis, OpcionesGeneracion(teclas, dificultad, estilo))
    informe = validar(mapa, analisis.duracion)
    assert informe["valido"], informe["errores"]
    assert informe["estadisticas"]["notas"] > 40
    assert all(0 <= n.columna < teclas for n in mapa.notas)


@pytest.mark.parametrize("teclas", [4, 7])
def test_dificultad_creciente(analisis, teclas):
    cantidades = [len(generar_mapa(analisis, OpcionesGeneracion(teclas, d)).notas) for d in NOMBRES]
    assert cantidades == sorted(cantidades)
    assert cantidades[-1] > 2 * cantidades[0]


def test_notas_en_la_rejilla(analisis):
    mapa = generar_mapa(analisis, OpcionesGeneracion(4, "Normal"))
    medio = analisis.periodo / 2
    for n in mapa.notas:
        pasos = (n.tiempo - analisis.offset) / medio
        assert abs(pasos - round(pasos)) < 1e-6


def test_determinista(analisis):
    a = generar_mapa(analisis, OpcionesGeneracion(7, "Hard", semilla=3)).notas
    b = generar_mapa(analisis, OpcionesGeneracion(7, "Hard", semilla=3)).notas
    c = generar_mapa(analisis, OpcionesGeneracion(7, "Hard", semilla=4)).notas
    assert a == b
    assert a != c


def test_columnas_repartidas(analisis):
    mapa = generar_mapa(analisis, OpcionesGeneracion(4, "Hard"))
    uso = validar(mapa)["estadisticas"]["columnas"]
    assert min(uso) > 0.6 * max(uso)


def test_hay_holds_y_acordes(analisis):
    mapa = generar_mapa(analisis, OpcionesGeneracion(4, "Insane", holds=2.0))
    acordes = validar(mapa)["estadisticas"]["acordes"]
    assert any(n.es_hold for n in mapa.notas)
    assert any(int(t) > 1 for t in acordes)


def test_easy_sin_acordes_en_4k(analisis):
    mapa = generar_mapa(analisis, OpcionesGeneracion(4, "Easy"))
    assert validar(mapa)["estadisticas"]["acordes"].keys() == {"1"}


def test_opciones_invalidas():
    with pytest.raises(ValueError):
        OpcionesGeneracion(teclas=5)
    with pytest.raises(ValueError):
        OpcionesGeneracion(estilo="otro")
