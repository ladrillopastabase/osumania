"""Exportador a formato .osu (v14) y empaquetado .osz para importar en osu!."""

import re
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path

from .analisis import Analisis
from .generador import Mapa


@dataclass
class Metadatos:
    titulo: str = "Sin título"
    artista: str = "Desconocido"
    creador: str = "Generador osu!mania"
    fuente: str = ""
    etiquetas: str = "generado automatico"


def _ascii(texto: str) -> str:
    limpio = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return limpio.strip() or texto


def nombre_version(mapa: Mapa) -> str:
    return f"{mapa.teclas}K {mapa.dificultad}"


def nombre_archivo(meta: Metadatos, version: str) -> str:
    nombre = f"{_ascii(meta.artista)} - {_ascii(meta.titulo)} ({_ascii(meta.creador)}) [{version}].osu"
    return re.sub(r'[\\/:*?"<>|]', "", nombre)


def posicion_x(columna: int, teclas: int) -> int:
    """Coordenada x que osu! interpreta como `columna` (floor(x * teclas / 512))."""
    return int(columna * 512 / teclas + 256 / teclas)


def _ms(segundos: float) -> int:
    return int(round(segundos * 1000))


def _puntos_de_tiempo(analisis: Analisis) -> list[str]:
    beat_ms = 60000.0 / analisis.bpm
    offset = _ms(analisis.offset)
    lineas = [f"{offset},{beat_ms:.12g},{analisis.compas},2,0,40,1,0"]
    for s in analisis.secciones:
        if not s.kiai:
            continue
        inicio = max(offset, _ms(s.inicio))
        fin = _ms(s.fin)
        if fin - inicio < 1000:
            continue
        lineas.append(f"{inicio},-100,{analisis.compas},2,0,40,0,1")
        lineas.append(f"{fin},-100,{analisis.compas},2,0,40,0,0")
    return lineas


def _tiempo_vista_previa(analisis: Analisis) -> int:
    for s in analisis.secciones:
        if s.kiai:
            return _ms(s.inicio)
    return _ms(analisis.duracion * 0.4)


def exportar_osu(mapa: Mapa, analisis: Analisis, meta: Metadatos, audio: str = "audio.mp3") -> str:
    p = mapa.perfil
    lineas = [
        "osu file format v14",
        "",
        "[General]",
        f"AudioFilename: {audio}",
        "AudioLeadIn: 0",
        f"PreviewTime: {_tiempo_vista_previa(analisis)}",
        "Countdown: 0",
        "SampleSet: Soft",
        "StackLeniency: 0.7",
        "Mode: 3",
        "LetterboxInBreaks: 0",
        "SpecialStyle: 0",
        "WidescreenStoryboard: 0",
        "",
        "[Editor]",
        "DistanceSpacing: 1",
        f"BeatDivisor: {mapa.divisor_editor}",
        "GridSize: 4",
        "TimelineZoom: 1",
        "",
        "[Metadata]",
        f"Title:{_ascii(meta.titulo)}",
        f"TitleUnicode:{meta.titulo}",
        f"Artist:{_ascii(meta.artista)}",
        f"ArtistUnicode:{meta.artista}",
        f"Creator:{meta.creador}",
        f"Version:{nombre_version(mapa)}",
        f"Source:{meta.fuente}",
        f"Tags:{meta.etiquetas}",
        "BeatmapID:0",
        "BeatmapSetID:-1",
        "",
        "[Difficulty]",
        f"HPDrainRate:{p.hp:g}",
        f"CircleSize:{mapa.teclas}",
        f"OverallDifficulty:{p.od:g}",
        "ApproachRate:5",
        "SliderMultiplier:1.4",
        "SliderTickRate:1",
        "",
        "[Events]",
        "//Background and Video events",
        "//Break Periods",
        "//Storyboard Layer 0 (Background)",
        "//Storyboard Layer 1 (Fail)",
        "//Storyboard Layer 2 (Pass)",
        "//Storyboard Layer 3 (Foreground)",
        "//Storyboard Sound Samples",
        "",
        "[TimingPoints]",
        *_puntos_de_tiempo(analisis),
        "",
        "",
        "[HitObjects]",
    ]
    for n in sorted(mapa.notas, key=lambda n: (n.tiempo, n.columna)):
        x = posicion_x(n.columna, mapa.teclas)
        if n.es_hold:
            lineas.append(f"{x},192,{_ms(n.tiempo)},128,0,{_ms(n.fin)}:0:0:0:0:")
        else:
            lineas.append(f"{x},192,{_ms(n.tiempo)},1,0,0:0:0:0:")
    return "\r\n".join(lineas) + "\r\n"


def leer_hitobjects(contenido: str, teclas: int) -> list[tuple[int, int, int | None]]:
    """Lee los HitObjects de un .osu de mania: (tiempo_ms, columna, fin_ms)."""
    resultado = []
    en_seccion = False
    for linea in contenido.splitlines():
        linea = linea.strip()
        if linea.startswith("["):
            en_seccion = linea == "[HitObjects]"
            continue
        if not en_seccion or not linea:
            continue
        partes = linea.split(",")
        x, tiempo, tipo = int(partes[0]), int(partes[2]), int(partes[3])
        columna = min(teclas - 1, x * teclas // 512)
        fin = int(partes[5].split(":")[0]) if tipo & 128 else None
        resultado.append((tiempo, columna, fin))
    return resultado


def empaquetar_osz(destino, audio, archivos_osu: dict[str, str]) -> Path:
    """Crea un .osz (zip) con el audio y los .osu; osu! lo importa al abrirlo."""
    destino = Path(destino)
    audio = Path(audio)
    with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(audio, audio.name)
        for nombre, contenido in archivos_osu.items():
            zf.writestr(nombre, contenido.encode("utf-8"))
    return destino
