"""Interfaz web: subir audio, configurar parámetros, previsualizar y descargar."""

import json
import shutil
from collections import OrderedDict
import time
import uuid
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

from motor.analisis import analizar
from motor.audio import EXTENSIONES_ADMITIDAS, ErrorAudio, cargar_audio, preparar_audio_osu
from motor.dificultades import NOMBRES as DIFICULTADES
from motor.exportador import Metadatos, empaquetar_osz, exportar_osu, nombre_archivo, nombre_version
from motor.generador import PESOS_CAPA_DEFECTO, OpcionesGeneracion, generar_mapa
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


# Análisis en memoria por trabajo: regenerar no vuelve a descargar ni a analizar.
_ANALISIS: "OrderedDict[str, tuple]" = OrderedDict()
_MAXIMO_EN_MEMORIA = 8


def _leer_trabajo(carpeta: Path) -> dict:
    return json.loads((carpeta / "trabajo.json").read_text(encoding="utf-8"))


def _guardar_trabajo(carpeta: Path, datos: dict) -> None:
    (carpeta / "trabajo.json").write_text(json.dumps(datos), encoding="utf-8")


def _analisis_de(id_trabajo: str, carpeta: Path, datos: dict, bpm, offset_ms):
    """Devuelve el análisis del trabajo, rehaciéndolo solo si cambió el BPM/offset forzado."""
    clave = (bpm, offset_ms)
    guardado = _ANALISIS.get(id_trabajo)
    if guardado is not None and guardado[0] == clave:
        _ANALISIS.move_to_end(id_trabajo)
        return guardado[1], 0.0
    inicio_t = time.time()
    senal, sr = cargar_audio(carpeta / datos["original"])
    analisis = analizar(senal, sr, bpm=bpm, offset=offset_ms / 1000 if offset_ms is not None else None)
    _ANALISIS[id_trabajo] = (clave, analisis)
    while len(_ANALISIS) > _MAXIMO_EN_MEMORIA:
        _ANALISIS.popitem(last=False)
    return analisis, time.time() - inicio_t


def _imagen_subida():
    imagen = request.files.get("imagen")
    if imagen is not None and not imagen.filename:
        imagen = None
    if imagen is not None and Path(imagen.filename).suffix.lower() not in EXTENSIONES_IMAGEN:
        abort(400, "La imagen debe ser JPG, PNG o WEBP.")
    return imagen


def _bpm_y_offset():
    bpm = _numero("bpm")
    offset_ms = _numero("offset_ms")
    if bpm is not None and not 30 <= bpm <= 400:
        abort(400, "El BPM debe estar entre 30 y 400.")
    return bpm, offset_ms


def _crear_trabajo():
    """Guarda el audio (subido o de YouTube), lo analiza y elige el fondo."""
    _limpiar_trabajos_viejos()
    archivo = request.files.get("audio")
    if archivo is not None and not archivo.filename:
        archivo = None
    url = request.form.get("url", "").strip()
    if archivo is None and not url:
        abort(400, "Sube un archivo de audio o pega un enlace de YouTube.")
    if archivo is not None:
        extension = Path(archivo.filename).suffix.lower()
        if extension not in EXTENSIONES_ADMITIDAS:
            abort(400, "Formato no admitido. Usa MP3, WAV, FLAC u OGG.")
    elif not es_url_youtube(url):
        abort(400, "El enlace no es de YouTube.")
    imagen = _imagen_subida()
    bpm, offset_ms = _bpm_y_offset()

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
            abort(400, str(error))

    datos = {"original": original.name, "titulo": sugerido["titulo"], "artista": sugerido["artista"],
             "fuente": url or archivo.filename}
    try:
        audio_osu = preparar_audio_osu(original, carpeta / "osz")
        datos["audio"] = audio_osu.name
        analisis, segundos = _analisis_de(id_trabajo, carpeta, datos, bpm, offset_ms)
    except ErrorAudio as error:
        shutil.rmtree(carpeta, ignore_errors=True)
        _ANALISIS.pop(id_trabajo, None)
        abort(400, str(error))

    subida = None
    if imagen is not None:
        subida = carpeta / f"imagen{Path(imagen.filename).suffix.lower()}"
        imagen.save(subida)
    fondo = elegir_fondo(carpeta / "osz" / "fondo.jpg", imagen_subida=subida,
                         miniatura=sugerido.get("miniatura"), audio=original)
    datos["fondo"] = fondo.name if fondo else None
    _guardar_trabajo(carpeta, datos)
    return id_trabajo, carpeta, datos, analisis, segundos


def _respuesta_trabajo(id_trabajo, datos, analisis, segundos):
    return {
        "id": id_trabajo,
        "tiempo_analisis": round(segundos, 2),
        "analisis": analisis.resumen(),
        "audio": f"/api/trabajos/{id_trabajo}/audio",
        "fondo": f"/api/trabajos/{id_trabajo}/fondo?v={int(time.time())}" if datos.get("fondo") else None,
        "metadatos": {"titulo": datos["titulo"], "artista": datos["artista"]},
        "fuente": datos.get("fuente"),
    }


def _generar_mapas(id_trabajo, carpeta, datos, analisis, usar_imagen=True):
    """Genera los mapas con los parámetros del formulario (sin descargar nada)."""
    teclas = [int(t) for t in _lista("teclas", {"4", "7"}, ["4"])]
    dificultades = _lista("dificultades", set(DIFICULTADES), list(DIFICULTADES))
    percusion = _numero("percusion", 0.5)
    melodia = _numero("melodia", 0.5)
    if percusion + melodia < 0.05:
        abort(400, "La percusión y la melodía no pueden estar ambas en cero.")
    densidad = _numero("densidad", 1.0)
    holds = _numero("holds", 1.0)
    semilla = _numero("semilla", 0, int)
    capas = {}
    for capa in PESOS_CAPA_DEFECTO:
        valor = _numero(f"capa_{capa}")
        if valor is not None:
            capas[capa] = valor
    if capas and max(capas.get(c, PESOS_CAPA_DEFECTO[c]) for c in PESOS_CAPA_DEFECTO) < 0.02:
        abort(400, "Al menos un instrumento tiene que tener influencia.")

    # Datos de la canción editables en cada generación.
    datos["titulo"] = request.form.get("titulo", "").strip() or datos["titulo"]
    datos["artista"] = request.form.get("artista", "").strip() or datos["artista"]
    meta = Metadatos(titulo=datos["titulo"], artista=datos["artista"],
                     creador=request.form.get("creador", "").strip() or "Generador osu!mania")
    imagen = _imagen_subida() if usar_imagen else None
    if imagen is not None:
        subida = carpeta / f"imagen{Path(imagen.filename).suffix.lower()}"
        imagen.save(subida)
        fondo = elegir_fondo(carpeta / "osz" / "fondo.jpg", imagen_subida=subida)
        if fondo is not None:
            datos["fondo"] = fondo.name
    fondo = carpeta / "osz" / datos["fondo"] if datos.get("fondo") else None

    for viejo in carpeta.glob("*.osu"):
        viejo.unlink()
    mapas = []
    archivos = {}
    for k in teclas:
        for dificultad in dificultades:
            opciones = OpcionesGeneracion(teclas=k, dificultad=dificultad, percusion=percusion,
                                          melodia=melodia, densidad=densidad, holds=holds,
                                          semilla=semilla, capas=capas)
            mapa = generar_mapa(analisis, opciones)
            informe = validar(mapa, analisis.duracion)
            version = nombre_version(mapa)
            nombre = nombre_archivo(meta, version)
            contenido = exportar_osu(mapa, analisis, meta, audio=datos["audio"],
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
                "destacados": [[round(a * 1000), round(b * 1000), capa] for a, b, capa in mapa.destacados],
            })

    datos["osz"] = nombre_archivo(meta, "set")[:-len(" [set].osu")] + ".osz"
    datos["archivos"] = [m["archivo"] for m in mapas]
    empaquetar_osz(carpeta / "mapas.osz", carpeta / "osz" / datos["audio"], archivos, fondo=fondo)
    _guardar_trabajo(carpeta, datos)
    version = int(time.time() * 1000)
    return {
        "mapas": mapas,
        "osz": f"/api/trabajos/{id_trabajo}/osz?v={version}",
        "version": version,
    }


@app.post("/api/trabajos")
def crear_trabajo():
    """Paso 1: subir o descargar la canción y analizarla."""
    id_trabajo, _carpeta, datos, analisis, segundos = _crear_trabajo()
    return jsonify(_respuesta_trabajo(id_trabajo, datos, analisis, segundos))


@app.post("/api/trabajos/<id_trabajo>/generar")
def regenerar(id_trabajo):
    """Paso 2 (repetible): generar con otros parámetros o datos, sin volver a descargar."""
    carpeta = _carpeta_trabajo(id_trabajo)
    datos = _leer_trabajo(carpeta)
    bpm, offset_ms = _bpm_y_offset()
    try:
        analisis, segundos = _analisis_de(id_trabajo, carpeta, datos, bpm, offset_ms)
    except ErrorAudio as error:
        abort(400, str(error))
    resultado = _generar_mapas(id_trabajo, carpeta, datos, analisis)
    return jsonify({**_respuesta_trabajo(id_trabajo, datos, analisis, segundos), **resultado})


@app.post("/api/generar")
def generar():
    """Atajo: crear el trabajo y generar en una sola llamada."""
    id_trabajo, carpeta, datos, analisis, segundos = _crear_trabajo()
    resultado = _generar_mapas(id_trabajo, carpeta, datos, analisis, usar_imagen=False)
    return jsonify({**_respuesta_trabajo(id_trabajo, datos, analisis, segundos), **resultado})


@app.get("/api/trabajos/<id_trabajo>/osu/<int:indice>")
def descargar_osu(id_trabajo, indice):
    carpeta = _carpeta_trabajo(id_trabajo)
    datos = _leer_trabajo(carpeta)
    ruta = carpeta / f"{indice}.osu"
    if not ruta.exists() or indice >= len(datos.get("archivos", [])):
        abort(404)
    return send_file(ruta, as_attachment=True, download_name=datos["archivos"][indice],
                     mimetype="text/plain")


@app.get("/api/trabajos/<id_trabajo>/osz")
def descargar_osz(id_trabajo):
    carpeta = _carpeta_trabajo(id_trabajo)
    datos = _leer_trabajo(carpeta)
    if "osz" not in datos:
        abort(404)
    return send_file(carpeta / "mapas.osz", as_attachment=True, download_name=datos["osz"],
                     mimetype="application/octet-stream")


@app.get("/api/trabajos/<id_trabajo>/audio")
def audio_trabajo(id_trabajo):
    carpeta = _carpeta_trabajo(id_trabajo)
    datos = _leer_trabajo(carpeta)
    return send_file(carpeta / "osz" / datos["audio"], conditional=True)


@app.get("/api/trabajos/<id_trabajo>/fondo")
def fondo_trabajo(id_trabajo):
    carpeta = _carpeta_trabajo(id_trabajo)
    datos = _leer_trabajo(carpeta)
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
