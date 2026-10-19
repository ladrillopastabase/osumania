"""Interfaz web: subir audio, configurar parámetros, previsualizar y descargar."""

import json
import shutil
import time
import uuid
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

from motor.analisis import analizar
from motor.audio import EXTENSIONES_ADMITIDAS, ErrorAudio, cargar_audio, preparar_audio_osu
from motor.dificultades import NOMBRES as DIFICULTADES
from motor.exportador import Metadatos, empaquetar_osz, exportar_osu, nombre_archivo, nombre_version
from motor.generador import ESTILOS, OpcionesGeneracion, generar_mapa
from motor.validador import validar

RAIZ = Path(__file__).resolve().parent
TRABAJOS = RAIZ / "trabajos"
VIDA_TRABAJO = 6 * 3600  # segundos

app = Flask(__name__, static_folder=str(RAIZ / "static"), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 80 * 1024 * 1024


def _limpiar_trabajos_viejos():
    if not TRABAJOS.exists():
        return
    limite = time.time() - VIDA_TRABAJO
    for carpeta in TRABAJOS.iterdir():
        if carpeta.is_dir() and carpeta.stat().st_mtime < limite:
            shutil.rmtree(carpeta, ignore_errors=True)


def _numero(nombre, defecto=None, tipo=float):
    valor = request.form.get(nombre, "").strip().replace(",", ".")
    if not valor:
        return defecto
    try:
        return tipo(valor)
    except ValueError:
        abort(400, f"Valor inválido para {nombre}.")


def _lista(nombre, permitidos, defecto):
    crudo = request.form.get(nombre, "")
    elegidos = [v.strip() for v in crudo.split(",") if v.strip()]
    elegidos = [v for v in elegidos if v in permitidos]
    return elegidos or defecto


def _carpeta_trabajo(id_trabajo: str) -> Path:
    try:
        uuid.UUID(id_trabajo)
    except ValueError:
        abort(404)
    carpeta = TRABAJOS / id_trabajo
    if not carpeta.is_dir():
        abort(404)
    return carpeta


@app.get("/")
def inicio():
    return send_from_directory(app.static_folder, "index.html")


@app.post("/api/generar")
def generar():
    _limpiar_trabajos_viejos()
    archivo = request.files.get("audio")
    if archivo is None or not archivo.filename:
        return jsonify(error="Falta el archivo de audio."), 400
    extension = Path(archivo.filename).suffix.lower()
    if extension not in EXTENSIONES_ADMITIDAS:
        return jsonify(error="Formato no admitido. Usa MP3, WAV, FLAC u OGG."), 400

    teclas = [int(t) for t in _lista("teclas", {"4", "7"}, ["4"])]
    dificultades = _lista("dificultades", set(DIFICULTADES), list(DIFICULTADES))
    estilo = request.form.get("estilo", "hibrido")
    if estilo not in ESTILOS:
        return jsonify(error="Estilo desconocido."), 400
    densidad = _numero("densidad", 1.0)
    holds = _numero("holds", 1.0)
    semilla = _numero("semilla", 0, int)
    bpm = _numero("bpm")
    offset_ms = _numero("offset_ms")
    if bpm is not None and not 30 <= bpm <= 400:
        return jsonify(error="El BPM debe estar entre 30 y 400."), 400

    meta = Metadatos(
        titulo=request.form.get("titulo", "").strip() or Path(archivo.filename).stem,
        artista=request.form.get("artista", "").strip() or "Desconocido",
        creador=request.form.get("creador", "").strip() or "Generador osu!mania",
    )

    id_trabajo = str(uuid.uuid4())
    carpeta = TRABAJOS / id_trabajo
    carpeta.mkdir(parents=True)
    original = carpeta / f"original{extension}"
    archivo.save(original)

    try:
        inicio_t = time.time()
        senal, sr = cargar_audio(original)
        analisis = analizar(senal, sr, bpm=bpm,
                            offset=offset_ms / 1000 if offset_ms is not None else None)
        t_analisis = time.time() - inicio_t
        audio_osu = preparar_audio_osu(original, carpeta / "osz")
    except ErrorAudio as error:
        shutil.rmtree(carpeta, ignore_errors=True)
        return jsonify(error=str(error)), 400

    mapas = []
    archivos = {}
    for k in teclas:
        for dificultad in dificultades:
            opciones = OpcionesGeneracion(teclas=k, dificultad=dificultad, estilo=estilo,
                                          densidad=densidad, holds=holds, semilla=semilla)
            mapa = generar_mapa(analisis, opciones)
            informe = validar(mapa, analisis.duracion)
            version = nombre_version(mapa)
            nombre = nombre_archivo(meta, version)
            contenido = exportar_osu(mapa, analisis, meta, audio=audio_osu.name)
            archivos[nombre] = contenido
            (carpeta / f"{len(mapas)}.osu").write_text(contenido, encoding="utf-8")
            mapas.append({
                "indice": len(mapas),
                "teclas": k,
                "dificultad": dificultad,
                "version": version,
                "archivo": nombre,
                "validacion": informe,
                "notas": [[round(n.tiempo * 1000), n.columna,
                           round(n.fin * 1000) if n.es_hold else -1] for n in mapa.notas],
            })

    nombre_osz = nombre_archivo(meta, "set")[:-len(" [set].osu")] + ".osz"
    empaquetar_osz(carpeta / "mapas.osz", audio_osu, archivos)
    (carpeta / "trabajo.json").write_text(json.dumps({
        "osz": nombre_osz, "archivos": [m["archivo"] for m in mapas]}), encoding="utf-8")

    return jsonify(
        id=id_trabajo,
        tiempo_analisis=round(t_analisis, 2),
        analisis=analisis.resumen(),
        mapas=mapas,
        osz=f"/api/trabajos/{id_trabajo}/osz",
    )


@app.get("/api/trabajos/<id_trabajo>/osu/<int:indice>")
def descargar_osu(id_trabajo, indice):
    carpeta = _carpeta_trabajo(id_trabajo)
    datos = json.loads((carpeta / "trabajo.json").read_text(encoding="utf-8"))
    ruta = carpeta / f"{indice}.osu"
    if not ruta.exists() or indice >= len(datos["archivos"]):
        abort(404)
    return send_file(ruta, as_attachment=True, download_name=datos["archivos"][indice],
                     mimetype="text/plain")


@app.get("/api/trabajos/<id_trabajo>/osz")
def descargar_osz(id_trabajo):
    carpeta = _carpeta_trabajo(id_trabajo)
    datos = json.loads((carpeta / "trabajo.json").read_text(encoding="utf-8"))
    return send_file(carpeta / "mapas.osz", as_attachment=True, download_name=datos["osz"],
                     mimetype="application/octet-stream")


@app.errorhandler(400)
def error_400(error):
    return jsonify(error=getattr(error, "description", "Solicitud inválida.")), 400


@app.errorhandler(413)
def error_413(_):
    return jsonify(error="El archivo supera los 80 MB."), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
