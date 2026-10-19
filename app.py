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
from motor.generador import OpcionesGeneracion, generar_mapa
from motor.imagen import EXTENSIONES_IMAGEN, elegir_fondo
from motor.validador import validar
from motor.youtube import descargar_audio, es_url_youtube

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
    if archivo is not None and not archivo.filename:
        archivo = None
    url = request.form.get("url", "").strip()
    if archivo is None and not url:
        return jsonify(error="Sube un archivo de audio o pega un enlace de YouTube."), 400
    if archivo is not None:
        extension = Path(archivo.filename).suffix.lower()
        if extension not in EXTENSIONES_ADMITIDAS:
            return jsonify(error="Formato no admitido. Usa MP3, WAV, FLAC u OGG."), 400
    elif not es_url_youtube(url):
        return jsonify(error="El enlace no es de YouTube."), 400
    imagen = request.files.get("imagen")
    if imagen is not None and not imagen.filename:
        imagen = None
    if imagen is not None and Path(imagen.filename).suffix.lower() not in EXTENSIONES_IMAGEN:
        return jsonify(error="La imagen debe ser JPG, PNG o WEBP."), 400

    teclas = [int(t) for t in _lista("teclas", {"4", "7"}, ["4"])]
    dificultades = _lista("dificultades", set(DIFICULTADES), list(DIFICULTADES))
    percusion = _numero("percusion", 0.5)
    melodia = _numero("melodia", 0.5)
    if percusion + melodia < 0.05:
        return jsonify(error="La percusión y la melodía no pueden estar ambas en cero."), 400
    densidad = _numero("densidad", 1.0)
    holds = _numero("holds", 1.0)
    semilla = _numero("semilla", 0, int)
    bpm = _numero("bpm")
    offset_ms = _numero("offset_ms")
    if bpm is not None and not 30 <= bpm <= 400:
        return jsonify(error="El BPM debe estar entre 30 y 400."), 400

    id_trabajo = str(uuid.uuid4())
    carpeta = TRABAJOS / id_trabajo
    carpeta.mkdir(parents=True)

    if archivo is not None:
        original = carpeta / f"original{extension}"
        archivo.save(original)
        sugerido = {"titulo": Path(archivo.filename).stem, "artista": "Desconocido", "miniatura": None}
    else:
        try:
            original, sugerido = descargar_audio(url, carpeta)
        except ErrorAudio as error:
            shutil.rmtree(carpeta, ignore_errors=True)
            return jsonify(error=str(error)), 400

    meta = Metadatos(
        titulo=request.form.get("titulo", "").strip() or sugerido["titulo"],
        artista=request.form.get("artista", "").strip() or sugerido["artista"],
        creador=request.form.get("creador", "").strip() or "Generador osu!mania",
    )

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

    subida = None
    if imagen is not None:
        subida = carpeta / f"imagen{Path(imagen.filename).suffix.lower()}"
        imagen.save(subida)
    fondo = elegir_fondo(carpeta / "osz" / "fondo.jpg", imagen_subida=subida,
                         miniatura=sugerido.get("miniatura"), audio=original)

    mapas = []
    archivos = {}
    for k in teclas:
        for dificultad in dificultades:
            opciones = OpcionesGeneracion(teclas=k, dificultad=dificultad, percusion=percusion,
                                          melodia=melodia, densidad=densidad, holds=holds,
                                          semilla=semilla)
            mapa = generar_mapa(analisis, opciones)
            informe = validar(mapa, analisis.duracion)
            version = nombre_version(mapa)
            nombre = nombre_archivo(meta, version)
            contenido = exportar_osu(mapa, analisis, meta, audio=audio_osu.name,
                                     fondo=fondo.name if fondo else None)
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
    empaquetar_osz(carpeta / "mapas.osz", audio_osu, archivos, fondo=fondo)
    (carpeta / "trabajo.json").write_text(json.dumps({
        "osz": nombre_osz, "archivos": [m["archivo"] for m in mapas],
        "audio": audio_osu.name, "fondo": fondo.name if fondo else None}), encoding="utf-8")

    return jsonify(
        id=id_trabajo,
        tiempo_analisis=round(t_analisis, 2),
        analisis=analisis.resumen(),
        mapas=mapas,
        osz=f"/api/trabajos/{id_trabajo}/osz",
        audio=f"/api/trabajos/{id_trabajo}/audio",
        fondo=f"/api/trabajos/{id_trabajo}/fondo" if fondo else None,
        metadatos={"titulo": meta.titulo, "artista": meta.artista},
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


@app.get("/api/trabajos/<id_trabajo>/audio")
def audio_trabajo(id_trabajo):
    carpeta = _carpeta_trabajo(id_trabajo)
    datos = json.loads((carpeta / "trabajo.json").read_text(encoding="utf-8"))
    return send_file(carpeta / "osz" / datos["audio"], conditional=True)


@app.get("/api/trabajos/<id_trabajo>/fondo")
def fondo_trabajo(id_trabajo):
    carpeta = _carpeta_trabajo(id_trabajo)
    datos = json.loads((carpeta / "trabajo.json").read_text(encoding="utf-8"))
    if not datos.get("fondo"):
        abort(404)
    return send_file(carpeta / "osz" / datos["fondo"], mimetype="image/jpeg")


@app.errorhandler(400)
def error_400(error):
    return jsonify(error=getattr(error, "description", "Solicitud inválida.")), 400


@app.errorhandler(413)
def error_413(_):
    return jsonify(error="El archivo supera los 80 MB."), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
