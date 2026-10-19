import io
import zipfile

import pytest

from motor.analisis import analizar
from motor.exportador import Metadatos, empaquetar_osz, exportar_osu, leer_hitobjects, posicion_x
from motor.generador import OpcionesGeneracion, generar_mapa
from sintetico import SR, cancion


@pytest.fixture(scope="module")
def analisis():
    return analizar(cancion(150, 30, 0.5), SR)


@pytest.mark.parametrize("teclas", [4, 7])
def test_posicion_x_ida_y_vuelta(teclas):
    for c in range(teclas):
        assert posicion_x(c, teclas) * teclas // 512 == c


@pytest.mark.parametrize("teclas", [4, 7])
def test_osu_valido(analisis, teclas):
    mapa = generar_mapa(analisis, OpcionesGeneracion(teclas, "Hard", holds=2))
    texto = exportar_osu(mapa, analisis, Metadatos("Canción", "Artista"))
    assert texto.startswith("osu file format v14")
    assert "Mode: 3" in texto
    assert f"CircleSize:{teclas}" in texto
    assert "Version:%dK Hard" % teclas in texto
    puntos = texto.split("[TimingPoints]")[1].split("[HitObjects]")[0].split()
    offset, beat_ms, *_ = puntos[0].split(",")
    assert float(beat_ms) == pytest.approx(400.0)
    leidos = leer_hitobjects(texto, teclas)
    assert len(leidos) == len(mapa.notas)
    for (t, c, fin), nota in zip(leidos, mapa.notas):
        assert t == round(nota.tiempo * 1000)
        assert c == nota.columna
        assert (fin is None) == (not nota.es_hold)


def test_osz(tmp_path, analisis):
    audio = tmp_path / "audio.mp3"
    audio.write_bytes(b"ID3")
    mapa = generar_mapa(analisis, OpcionesGeneracion(4, "Easy"))
    contenido = exportar_osu(mapa, analisis, Metadatos())
    destino = empaquetar_osz(tmp_path / "set.osz", audio, {"a [4K Easy].osu": contenido})
    with zipfile.ZipFile(io.BytesIO(destino.read_bytes())) as zf:
        assert set(zf.namelist()) == {"audio.mp3", "a [4K Easy].osu"}
