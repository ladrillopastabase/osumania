"""Validación de jugabilidad y estadísticas de un mapa generado."""

import numpy as np

from .generador import Mapa

HUECO_MINIMO_HOLD = 0.03  # s entre soltar un hold y la siguiente nota en la columna


def validar(mapa: Mapa, duracion: float | None = None) -> dict:
    errores: list[str] = []
    advertencias: list[str] = []
    notas = mapa.notas
    k = mapa.teclas
    perfil = mapa.perfil

    tiempos = [n.tiempo for n in notas]
    if tiempos != sorted(tiempos):
        errores.append("Las notas no están ordenadas por tiempo.")

    por_columna: dict[int, list] = {c: [] for c in range(k)}
    for n in notas:
        if not 0 <= n.columna < k:
            errores.append(f"Columna fuera de rango ({n.columna}) en {n.tiempo:.3f}s.")
            continue
        if n.tiempo < 0 or (duracion is not None and n.tiempo > duracion):
            errores.append(f"Nota fuera de la canción en {n.tiempo:.3f}s.")
        if n.es_hold and n.fin <= n.tiempo:
            errores.append(f"Hold sin duración en {n.tiempo:.3f}s.")
        por_columna[n.columna].append(n)

    jacks_rapidos = 0
    for c, lista in por_columna.items():
        for previa, actual in zip(lista, lista[1:]):
            libre_desde = previa.fin if previa.es_hold else previa.tiempo
            if actual.tiempo <= libre_desde + (HUECO_MINIMO_HOLD if previa.es_hold else 1e-6):
                errores.append(f"Notas superpuestas en la columna {c + 1} ({actual.tiempo:.3f}s).")
            elif not previa.es_hold and actual.tiempo - previa.tiempo < perfil.jack_min - 1e-6:
                jacks_rapidos += 1
    if jacks_rapidos:
        advertencias.append(f"{jacks_rapidos} jacks más rápidos que el mínimo de {perfil.nombre}.")

    acordes: dict[int, int] = {}
    if notas:
        actual, tamano = notas[0].tiempo, 0
        for n in notas:
            if abs(n.tiempo - actual) < 1e-4:
                tamano += 1
            else:
                acordes[tamano] = acordes.get(tamano, 0) + 1
                actual, tamano = n.tiempo, 1
        acordes[tamano] = acordes.get(tamano, 0) + 1
    if acordes and max(acordes) > perfil.acorde_max:
        errores.append(f"Acorde de {max(acordes)} notas supera el máximo de {perfil.acorde_max}.")

    estadisticas = estadisticas_mapa(mapa)
    estadisticas["acordes"] = {str(t): v for t, v in sorted(acordes.items())}
    patrones: dict[str, int] = {}
    for tipo, cantidad in mapa.frases:
        patrones[tipo] = patrones.get(tipo, 0) + cantidad
    estadisticas["patrones"] = dict(sorted(patrones.items(), key=lambda par: -par[1]))
    largas = [cantidad for tipo, cantidad in mapa.frases if tipo != "suelta"]
    estadisticas["largo_frase"] = round(float(np.mean(largas)), 1) if largas else 0.0
    if not notas:
        errores.append("El mapa no tiene notas.")
    elif estadisticas["notas"] < 20:
        advertencias.append("El mapa tiene muy pocas notas.")

    return {"valido": not errores, "errores": errores[:20], "advertencias": advertencias,
            "estadisticas": estadisticas}


def estadisticas_mapa(mapa: Mapa) -> dict:
    notas = mapa.notas
    if not notas:
        return {"notas": 0, "holds": 0, "nps_medio": 0, "nps_max": 0,
                "columnas": [0] * mapa.teclas, "estrellas_aprox": 0}
    tiempos = np.array([n.tiempo for n in notas])
    inicio, fin = tiempos[0], max(tiempos[-1], max((n.fin or 0) for n in notas))
    jugable = max(fin - inicio, 1.0)
    ventanas = np.arange(inicio, fin + 1, 1.0)
    conteo = np.histogram(tiempos, bins=ventanas)[0] if ventanas.size > 1 else np.array([len(notas)])
    columnas = np.bincount([n.columna for n in notas], minlength=mapa.teclas)
    exigente = float(np.percentile(conteo, 95)) if conteo.size else 0.0
    # Estimación muy gruesa (no es el star rating oficial de osu!).
    estrellas = 0.42 * exigente ** 0.82 * (1.0 + 0.04 * (mapa.teclas - 4))
    return {
        "notas": len(notas),
        "holds": sum(1 for n in notas if n.es_hold),
        "nps_medio": round(float(len(notas) / jugable), 2),
        "nps_max": int(conteo.max()) if conteo.size else len(notas),
        "columnas": [int(v) for v in columnas],
        "estrellas_aprox": round(float(estrellas), 2),
    }
