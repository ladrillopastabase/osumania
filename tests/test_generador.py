import numpy as np
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
@pytest.mark.parametrize("mezcla", [(0.5, 0.5), (1.0, 0.0), (0.0, 1.0)])
def test_mapas_validos(analisis, teclas, dificultad, mezcla):
    percusion, melodia = mezcla
    mapa = generar_mapa(analisis, OpcionesGeneracion(teclas, dificultad, percusion, melodia))
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
        OpcionesGeneracion(percusion=0, melodia=0)


# --- calidad rítmica sobre una canción con ritmo conocido ---------------------

@pytest.fixture(scope="module")
def realista():
    from sintetico import cancion_realista
    senal, eventos = cancion_realista()
    return analizar(senal, SR), np.array(sorted({e[0] for e in eventos}))


@pytest.mark.parametrize("teclas", [4, 7])
@pytest.mark.parametrize("dificultad", NOMBRES)
def test_sin_notas_fantasma(realista, teclas, dificultad):
    analisis, verdad = realista
    mapa = generar_mapa(analisis, OpcionesGeneracion(teclas, dificultad))
    distancias = [np.min(np.abs(verdad - n.tiempo)) for n in mapa.notas]
    assert max(distancias) < 0.025  # toda nota coincide con algo que suena


@pytest.mark.parametrize("dificultad", ["Hard", "Insane"])
def test_cubre_golpes_y_patrones_largos(realista, dificultad):
    analisis, verdad = realista
    mapa = generar_mapa(analisis, OpcionesGeneracion(4, dificultad))
    tiempos = np.array([n.tiempo for n in mapa.notas])
    from sintetico import cancion_realista
    fuertes = [e[0] for e in cancion_realista()[1] if e[1] != "platillo"]
    cubiertos = np.mean([np.min(np.abs(tiempos - t)) < 0.02 for t in fuertes])
    assert cubiertos > 0.9
    largas = [n for tipo, n in mapa.frases if tipo != "suelta"]
    assert np.mean(largas) >= 8


def test_ritmo_repetido_mismo_patron(realista):
    analisis, _ = realista
    mapa = generar_mapa(analisis, OpcionesGeneracion(4, "Hard"))
    # El coro se repite: sus compases deben tener el mismo ritmo.
    compas = 4 * analisis.periodo
    def ritmo(indice):
        inicio = analisis.offset + indice * compas
        return {round((n.tiempo - inicio) / (analisis.periodo / 4)) for n in mapa.notas
                if inicio - 1e-3 <= n.tiempo < inicio + compas - 1e-3}
    coro = [ritmo(i) for i in range(13, 19)]
    iguales = sum(a == b for a, b in zip(coro, coro[1:]))
    assert iguales >= 4


def test_controles_percusion_y_melodia(realista):
    from sintetico import cancion_realista
    analisis, _ = realista
    eventos = cancion_realista()[1]
    melodia = np.array([e[0] for e in eventos if e[1] == "melodia"])
    solo_bateria = np.array([e[0] for e in eventos
                             if e[1] != "melodia" and np.min(np.abs(melodia - e[0])) > 0.03])

    def medir(percusion, melodia_peso):
        mapa = generar_mapa(analisis, OpcionesGeneracion(4, "Hard", percusion, melodia_peso))
        tiempos = sorted({n.tiempo for n in mapa.notas})
        en_bateria = np.mean([np.min(np.abs(solo_bateria - t)) < 0.025 for t in tiempos])
        acordes = len(mapa.notas) - len(tiempos)
        return en_bateria, acordes

    bateria_p, acordes_p = medir(1.0, 0.0)
    bateria_m, acordes_m = medir(0.0, 1.0)
    assert bateria_p > 2 * bateria_m
    assert acordes_m == 0 and acordes_p > 20


def test_capas_detectadas(realista):
    analisis, _ = realista
    assert set(analisis.capas) == {"bombo", "caja", "platillos", "bajo", "melodia"}
    from sintetico import cancion_realista
    bombos = np.array([e[0] for e in cancion_realista()[1] if e[1] == "bombo"])
    capa = analisis.capas["bombo"]
    fuertes = capa.onsets[capa.fuerzas > 0.25]
    assert np.mean([np.min(np.abs(fuertes - t)) < 0.03 for t in bombos]) > 0.95
    assert np.mean([np.min(np.abs(bombos - t)) < 0.03 for t in fuertes]) > 0.9


# --- huecos, clímax y holds ---------------------------------------------------

def _hueco_maximo(mapa, desde, hasta):
    ocupado = sorted((n.tiempo, n.fin or n.tiempo) for n in mapa.notas if desde <= n.tiempo < hasta)
    ultimo, maximo = desde, 0.0
    for inicio, fin in ocupado:
        maximo = max(maximo, inicio - ultimo)
        ultimo = max(ultimo, fin)
    return max(maximo, hasta - ultimo)


@pytest.mark.parametrize("dificultad", ["Normal", "Hard", "Insane"])
def test_sin_huecos_con_musica(realista, dificultad):
    analisis, _ = realista
    mapa = generar_mapa(analisis, OpcionesGeneracion(4, dificultad))
    inicio_musica = analisis.offset + 4 * 4 * analisis.periodo  # después de la intro
    fin_musica = analisis.duracion - 1.5
    assert _hueco_maximo(mapa, inicio_musica, fin_musica) <= 2.05 * analisis.periodo


def test_coro_sostenido_no_queda_vacio():
    from sintetico import SECCIONES_SOSTENIDAS, cancion_realista
    senal, _ = cancion_realista(secciones=SECCIONES_SOSTENIDAS)
    analisis = analizar(senal, SR)
    paso = analisis.periodo / 4
    inicio_coro = 0.6 + 12 * 16 * paso
    fin_coro = inicio_coro + 8 * 16 * paso
    mapa = generar_mapa(analisis, OpcionesGeneracion(4, "Hard"))
    assert _hueco_maximo(mapa, inicio_coro, fin_coro) <= 1.05 * analisis.periodo
    holds = [n for n in mapa.notas if n.es_hold and inicio_coro <= n.tiempo < fin_coro]
    assert len(holds) >= 8  # las notas largas de la melodía se vuelven holds


@pytest.mark.parametrize("dificultad", ["Normal", "Hard", "Insane"])
def test_control_de_holds(realista, dificultad):
    analisis, _ = realista

    def proporcion(holds):
        mapa = generar_mapa(analisis, OpcionesGeneracion(4, dificultad, holds=holds))
        assert validar(mapa, analisis.duracion)["valido"]
        return sum(n.es_hold for n in mapa.notas) / len(mapa.notas)

    sin, normal, ln = proporcion(0.0), proporcion(1.0), proporcion(2.5)
    assert sin == 0
    assert 0 < normal < ln
    assert ln >= 0.1


def test_holds_terminan_en_puntos_musicales(realista):
    analisis, _ = realista
    for dificultad in ("Normal", "Hard", "Insane"):
        mapa = generar_mapa(analisis, OpcionesGeneracion(4, dificultad, holds=2.0))
        inicios = np.array(sorted({n.tiempo for n in mapa.notas}))
        holds = [n for n in mapa.notas if n.es_hold]
        en_nota = [np.min(np.abs(inicios - n.fin)) < 1e-3 for n in holds]
        relativo = [(n.fin - analisis.offset) / (analisis.periodo / 2) for n in holds]
        en_rejilla = [abs(r - round(r)) < 1e-3 for r in relativo]
        assert np.mean(np.logical_or(en_nota, en_rejilla)) >= 0.95
