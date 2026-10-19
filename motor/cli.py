"""Uso por línea de comandos: python -m motor.cli cancion.mp3 --teclas 4 7"""

import argparse
import sys
from pathlib import Path

from .analisis import analizar
from .audio import ErrorAudio, cargar_audio, preparar_audio_osu
from .dificultades import NOMBRES
from .exportador import Metadatos, empaquetar_osz, exportar_osu, nombre_archivo, nombre_version
from .generador import OpcionesGeneracion, generar_mapa
from .imagen import elegir_fondo
from .validador import validar


def main(argv=None) -> int:
    lector = argparse.ArgumentParser(description="Genera beatmaps de osu!mania a partir de un audio.")
    lector.add_argument("audio", type=Path)
    lector.add_argument("--teclas", type=int, nargs="+", default=[4], choices=[4, 7])
    lector.add_argument("--dificultades", nargs="+", default=NOMBRES, choices=NOMBRES)
    lector.add_argument("--percusion", type=float, default=0.5, help="0..1, peso de la batería")
    lector.add_argument("--melodia", type=float, default=0.5, help="0..1, peso de la melodía")
    lector.add_argument("--imagen", type=Path, help="imagen de fondo (si no, la portada del audio)")
    lector.add_argument("--densidad", type=float, default=1.0)
    lector.add_argument("--holds", type=float, default=1.0)
    lector.add_argument("--semilla", type=int, default=0)
    lector.add_argument("--bpm", type=float)
    lector.add_argument("--offset-ms", type=float)
    lector.add_argument("--titulo")
    lector.add_argument("--artista", default="Desconocido")
    lector.add_argument("--creador", default="Generador osu!mania")
    lector.add_argument("--salida", type=Path, default=Path("salida"))
    args = lector.parse_args(argv)

    try:
        senal, sr = cargar_audio(args.audio)
    except ErrorAudio as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    offset = args.offset_ms / 1000 if args.offset_ms is not None else None
    analisis = analizar(senal, sr, bpm=args.bpm, offset=offset)
    print(f"BPM {analisis.bpm:g} · offset {analisis.offset * 1000:.0f} ms · "
          f"{len(analisis.secciones)} secciones · {analisis.duracion:.1f} s")

    meta = Metadatos(titulo=args.titulo or args.audio.stem, artista=args.artista, creador=args.creador)
    args.salida.mkdir(parents=True, exist_ok=True)
    audio_osu = preparar_audio_osu(args.audio, args.salida)
    fondo = elegir_fondo(args.salida / "fondo.jpg", imagen_subida=args.imagen, audio=args.audio)
    archivos = {}
    for k in args.teclas:
        for dificultad in args.dificultades:
            mapa = generar_mapa(analisis, OpcionesGeneracion(
                teclas=k, dificultad=dificultad, percusion=args.percusion, melodia=args.melodia,
                densidad=args.densidad,
                holds=args.holds, semilla=args.semilla))
            informe = validar(mapa, analisis.duracion)
            nombre = nombre_archivo(meta, nombre_version(mapa))
            contenido = exportar_osu(mapa, analisis, meta, audio=audio_osu.name,
                                     fondo=fondo.name if fondo else None)
            (args.salida / nombre).write_text(contenido, encoding="utf-8")
            archivos[nombre] = contenido
            e = informe["estadisticas"]
            marca = "ok" if informe["valido"] else "ERRORES: " + "; ".join(informe["errores"][:3])
            print(f"  {nombre_version(mapa):<10} {e['notas']:>5} notas {e['holds']:>4} holds "
                  f"{e['nps_medio']:>5} NPS ≈{e['estrellas_aprox']}★  {marca}")
    osz = args.salida / (nombre_archivo(meta, "set")[:-len(" [set].osu")] + ".osz")
    empaquetar_osz(osz, audio_osu, archivos, fondo=fondo)
    print(f"Paquete: {osz}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
