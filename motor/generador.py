"""Motor de generación híbrida.

Convierte un `Analisis` en notas de osu!mania en cuatro etapas:

1. Eventos: cada onset detectado se ajusta a la rejilla permitida por la
   dificultad (1/1 y 1/2 en Easy/Normal; 1/4 o 1/3 en Hard/Insane). Si un
   onset no cae cerca de ningún punto permitido se descarta: nunca se mueve un
   golpe a otro lugar ni se inventan notas donde no suena nada.
2. Selección: cada evento tiene una saliencia según qué instrumento suena
   (bombo/graves, caja/medios, platillos/agudos, cambio melódico). Por sección
   se toman los eventos más salientes hasta la densidad objetivo; el umbral es
   el mismo para toda la sección, así cada compás sigue las mismas capas de la
   música. Luego se regulariza: los golpes que se repiten en los compases
   vecinos se incluyen y los aislados débiles se quitan.
3. Frases y patrones: los eventos se agrupan en frases de ritmo constante
   (ráfagas de 1/4, corcheas, etc.). Cada frase recibe un patrón completo
   —escalera, trino, celda repetida, jumptrill, brackets, chordjack, manos
   alternas o contorno melódico— que se mantiene toda la frase. Si el mismo
   ritmo vuelve a aparecer, se repite el patrón (en espejo una vez sí y otra
   no), como hacen los mapeadores.
4. Jugabilidad: cada nota del patrón se coloca si la columna está libre
   (sin jacks más rápidos que el mínimo ni holds activos); si no, se usa la
   columna libre más cercana. Los golpes fuertes en tiempo (bombo, caja) se
   vuelven acordes y las notas sostenidas, holds.

Todo es determinista para una misma semilla.
"""

from bisect import bisect_left, insort
from dataclasses import dataclass, field

import numpy as np

from .analisis import Analisis
from .capas import MELODIA, PERCUSION
from .dificultades import PerfilDificultad, perfil as obtener_perfil

# Importancia por defecto de cada capa (el usuario puede cambiarla, 0..1).
PESOS_CAPA_DEFECTO = {"bombo": 1.0, "caja": 0.9, "platillos": 0.5, "bajo": 0.6, "melodia": 1.0}
# El instrumento destacado del compás pesa más; el resto, un poco menos.
_REFUERZO_DESTACADO = 1.6
_ATENUACION_RESTO = 0.8
_ATAQUES_PLENOS = 4.0  # fuerza de ataques por segundo que cuenta como actividad plena
_PESO_CAMBIO_MELODICO = 0.6
_BONO_NIVEL = {0: 0.15, 1: 0.1, 2: 0.05, 3: 0.0}
_FACTOR_SECCION = {"tranquila": 0.55, "media": 0.9, "intensa": 1.15, "clímax": 1.45}
# Hueco máximo (en pulsos) con música sonando, antes de rellenar; se escala por sección.
_HUECO_MAXIMO = {"Easy": 4.0, "Normal": 2.0, "Hard": 1.5, "Insane": 1.0}
# Holds: largo máximo y pausa mínima entre holds (en pulsos), y parte del tiempo que
# pueden ocupar en una ventana de 8 pulsos con el control en 1×. Holds largos y
# seguidos se vuelven monótonos: es mejor pocos, en notas que de verdad se sostienen.
_HOLD_MAXIMO = {"Easy": 4.0, "Normal": 3.0, "Hard": 2.0, "Insane": 2.0}
_HOLD_PAUSA = {"Easy": 2.0, "Normal": 1.5, "Hard": 1.0, "Insane": 1.0}
_HOLD_COBERTURA = 0.25
_HOLD_VENTANA = 8.0


def hold_maximo(perfil: PerfilDificultad, periodo: float, holds: float) -> float:
    """Largo máximo de un hold en segundos (el estilo LN, sobre 1×, permite algo más)."""
    return _HOLD_MAXIMO[perfil.nombre] * periodo * (1.0 + 0.5 * max(0.0, holds - 1.0))
_FACTOR_HUECO = {"tranquila": 2.0, "media": 1.0, "intensa": 0.75, "clímax": 0.5}
_UNIDADES_PULSO = 12  # 1/4 = 3 unidades, 1/3 = 4 unidades


@dataclass
class Nota:
    tiempo: float
    columna: int
    fin: float | None = None

    @property
    def es_hold(self) -> bool:
        return self.fin is not None


@dataclass
class OpcionesGeneracion:
    teclas: int = 4
    dificultad: str = "Normal"
    percusion: float = 0.5   # 0..1: cuánto siguen las notas a la batería
    melodia: float = 0.5     # 0..1: cuánto siguen las notas a la melodía y el bajo
    densidad: float = 1.0
    holds: float = 1.0
    semilla: int = 0
    capas: dict | None = None  # peso de cada capa, 0..1 (por defecto PESOS_CAPA_DEFECTO)
    # Pesos distintos por tramo: [{"inicio": s, "fin": s, "capas": {capa: 0..1}}, ...].
    # Fuera de esos tramos rigen los pesos globales de `capas`.
    capas_secciones: list | None = None

    @staticmethod
    def _normalizar_pesos(valores: dict, base: dict) -> dict:
        pesos = dict(base)
        for nombre, valor in (valores or {}).items():
            if nombre not in pesos:
                raise ValueError(f"Capa desconocida: {nombre}")
            pesos[nombre] = float(np.clip(valor, 0.0, 1.0))
        return pesos

    def __post_init__(self):
        self.capas = self._normalizar_pesos(self.capas, PESOS_CAPA_DEFECTO)
        tramos = []
        for tramo in self.capas_secciones or []:
            inicio, fin = float(tramo["inicio"]), float(tramo["fin"])
            if fin > inicio:
                tramos.append((inicio, fin, self._normalizar_pesos(tramo.get("capas"), self.capas)))
        self.capas_secciones = sorted(tramos)
        if self.teclas not in (4, 7):
            raise ValueError("Solo se admiten 4K y 7K.")
        self.percusion = float(np.clip(self.percusion, 0.0, 1.0))
        self.melodia = float(np.clip(self.melodia, 0.0, 1.0))
        if self.percusion + self.melodia < 0.05:
            raise ValueError("La percusión y la melodía no pueden estar ambas en cero.")
        if max(self.peso(c) for c in self.capas) < 0.02 and not any(
                max(p.values()) >= 0.02 for _, _, p in self.capas_secciones):
            raise ValueError("Todas las capas están en cero.")
        self.densidad = float(np.clip(self.densidad, 0.3, 2.5))
        self.holds = float(np.clip(self.holds, 0.0, 3.0))

    def pesos_en(self, t: float | None) -> dict:
        """Pesos de las capas que rigen en el instante `t` (de su sección o globales)."""
        if t is not None:
            for inicio, fin, pesos in self.capas_secciones:
                if inicio <= t < fin:
                    return pesos
        return self.capas

    def peso(self, capa: str, t: float | None = None) -> float:
        """Peso efectivo de una capa en `t`: control de la capa × control de su familia."""
        familia = self.percusion if capa in PERCUSION else self.melodia
        return 2.0 * familia * self.pesos_en(t).get(capa, 0.0)


@dataclass
class Mapa:
    teclas: int
    dificultad: str
    perfil: PerfilDificultad
    notas: list = field(default_factory=list)
    divisor_editor: int = 4
    frases: list = field(default_factory=list)  # (tipo de patrón, cantidad de eventos)
    destacados: list = field(default_factory=list)  # (inicio, fin, capa) por tramos


@dataclass
class _Evento:
    tiempo: float
    compas: int       # índice de compás relativo al offset
    posicion: int     # posición dentro del compás en unidades de 1/12 de pulso
    nivel: int        # 0 tiempo fuerte, 1 pulso, 2 medio pulso, 3 subdivisión menor
    capas: dict = field(default_factory=dict)  # fuerza del ataque en cada capa
    cambio: float = 0.0   # cambio de altura melódica
    cambio_bajo: float = 0.0  # cambio de altura de la línea de bajo
    altura: float = 60.0
    confianza: float = 0.0
    saliencia: float = 0.0
    melodico: float = 0.0  # 0 = solo percusión, 1 = solo melodía
    relleno: bool = False   # nota en el pulso para no dejar un hueco con música sonando
    lider: str | None = None  # capa que más aporta a este evento
    destacado: str | None = None  # instrumento destacado del compás
    aportes: dict = field(default_factory=dict)  # aporte de cada capa a la saliencia
    atribuidas: dict = field(default_factory=dict)  # fuerza por capa tras resolver bombo/bajo

    def capa_sostenida(self) -> str | None:
        """Capa melódica cuya duración debe seguir un hold que empiece aquí."""
        if self.lider in MELODIA:
            return self.lider
        if self.destacado in MELODIA:
            return self.destacado
        fuerzas = {c: self.fuerza(c) for c in MELODIA}
        mejor = max(fuerzas, key=fuerzas.get)
        return mejor if fuerzas[mejor] > 0 else None
    hold_hasta: float = 0.0  # si > 0, el relleno de huecos pidió sostenerlo hasta aquí
    hold_plan: float = 0.0   # si > 0, el plan de holds decidió sostenerlo hasta aquí

    def fuerza(self, capa: str) -> float:
        return self.capas.get(capa, 0.0)


# ---------------------------------------------------------------------------
# 1. Eventos ajustados a la rejilla
# ---------------------------------------------------------------------------

def _usa_tresillos(analisis: Analisis, inicio: float, periodo: float) -> bool:
    dentro = (analisis.onsets > inicio + periodo * 0.08) & (analisis.onsets < inicio + periodo * 0.92)
    tiempos = analisis.onsets[dentro]
    fuerzas = analisis.fuerzas[dentro]
    tiempos = tiempos[fuerzas > 0.2]
    if tiempos.size < 2:
        return False
    fase = (tiempos - inicio) / periodo
    error_cuartos = np.abs(fase * 4 - np.rint(fase * 4)).sum() / 4
    error_tercios = np.abs(fase * 3 - np.rint(fase * 3)).sum() / 3
    return error_tercios < 0.5 * error_cuartos


def _cambio_melodico(analisis: Analisis, t: float, bajo: bool = False) -> float:
    altura = analisis.altura_bajo if bajo else analisis.altura
    confianzas = analisis.confianza_bajo if bajo else analisis.confianza_melodia
    if altura is None:
        return 0.0
    confianza = analisis.maximo(confianzas, t + 0.02, 0.02)
    if confianza < 0.25:
        return 0.0
    # La ventana de altura dura ~90 ms: se compara justo antes del ataque con
    # un punto donde la ventana ya cubre casi solo la nota nueva.
    antes = analisis.valor(altura, t - 0.045)
    despues = analisis.valor(altura, t + 0.05)
    salto = abs(despues - antes)
    if salto < 0.5:
        return 0.0
    return confianza * min(1.0, salto / 3.0)


def _ataques(analisis: Analisis):
    """(tiempo, capa, fuerza) de todas las capas; sin capas, cae a los onsets globales."""
    if analisis.capas:
        for capa in analisis.capas.values():
            for t, f in zip(capa.onsets, capa.fuerzas):
                yield float(t), capa.nombre, float(f)
    else:
        for t, f in zip(analisis.onsets, analisis.fuerzas):
            yield float(t), "caja", float(f)


def construir_eventos(analisis: Analisis, perfil: PerfilDificultad,
                      opciones: "OpcionesGeneracion") -> list:
    """Ajusta el ataque de cada capa al punto permitido más cercano de la rejilla."""
    periodo = analisis.periodo
    tolerancia = 0.03
    tresillos_por_pulso: dict[int, bool] = {}
    eventos: dict[tuple[int, int], _Evento] = {}

    for t, capa, fuerza in _ataques(analisis):
        relativo = (t - analisis.offset) / periodo
        pulso = int(np.floor(relativo + 0.5 / _UNIDADES_PULSO))
        fraccion = relativo - pulso
        if perfil.divisor <= 2:
            divisor = 2
        else:
            if pulso not in tresillos_por_pulso:
                inicio = analisis.offset + pulso * periodo
                tresillos_por_pulso[pulso] = perfil.tresillos and _usa_tresillos(analisis, inicio, periodo)
            divisor = 3 if tresillos_por_pulso[pulso] else 4
        k = int(round(fraccion * divisor))
        tiempo = analisis.offset + (pulso + k / divisor) * periodo
        if abs(tiempo - t) > min(tolerancia, 0.45 * periodo / divisor):
            continue  # no cae en la rejilla de esta dificultad: no se mueve, se descarta
        if k == divisor:
            pulso, k = pulso + 1, 0
        if tiempo < 0 or tiempo >= analisis.duracion - 0.05:
            continue
        compas, pulso_en_compas = divmod(pulso, analisis.compas)
        posicion = pulso_en_compas * _UNIDADES_PULSO + k * (_UNIDADES_PULSO // divisor)
        if k == 0:
            nivel = 0 if pulso_en_compas == 0 else 1
        elif 2 * k == divisor:
            nivel = 2
        else:
            nivel = 3

        clave = (compas, posicion)
        evento = eventos.get(clave)
        if evento is None:
            evento = eventos[clave] = _Evento(float(tiempo), compas, posicion, nivel)
        evento.cambio = max(evento.cambio, _cambio_melodico(analisis, t))
        evento.cambio_bajo = max(evento.cambio_bajo, _cambio_melodico(analisis, t, bajo=True))
        evento.capas[capa] = max(evento.capas.get(capa, 0.0), fuerza)

    ordenados = sorted(eventos.values(), key=lambda e: e.tiempo)
    _atenuar_colas(ordenados)

    # Cada capa aporta según su fuerza, el peso que eligió el usuario y si es el
    # instrumento destacado del compás (que se calcula con una primera pasada).
    for e in ordenados:
        aplicar_aportes(analisis, e, opciones, {})
    destacados = instrumentos_destacados(analisis, ordenados, opciones)
    for e in ordenados:
        aplicar_aportes(analisis, e, opciones, destacados)
        e.saliencia = e.saliencia + _BONO_NIVEL[e.nivel] * perfil.peso_metrico * min(1.0, e.saliencia * 4)
    return ordenados


def aplicar_aportes(analisis: Analisis, e: _Evento, opciones: "OpcionesGeneracion",
                    destacados: dict) -> None:
    fuerzas = {c: e.fuerza(c) for c in PERCUSION + MELODIA}
    # Bombo y bajo comparten registro. Una nota real de bajo cambia de altura; la
    # cola de un bombo 808 no. Así se decide a quién atribuir el ataque grave.
    if fuerzas["bajo"] and fuerzas["bombo"]:
        if e.cambio_bajo >= 0.1:
            if fuerzas["bombo"] < fuerzas["bajo"]:
                fuerzas["bombo"] *= 0.15  # el "golpe" es la pulsación del bajo
        elif fuerzas["bombo"] >= 0.5 * fuerzas["bajo"]:
            fuerzas["bajo"] *= 0.3
    # Un cambio de altura sin ataque detectado también es una nota de la melodía.
    fuerzas["melodia"] = max(fuerzas["melodia"], _PESO_CAMBIO_MELODICO * e.cambio)
    e.atribuidas = dict(fuerzas)
    destacado = destacados.get(e.compas)
    e.destacado = destacado
    aportes = {}
    for capa, fuerza in fuerzas.items():
        factor = 1.0
        if destacado is not None:
            # Solo se refuerzan ataques reales: un roce débil del destacado no se vuelve nota.
            if capa == destacado:
                factor = _REFUERZO_DESTACADO if fuerza >= 0.2 else 1.0
            else:
                factor = _ATENUACION_RESTO
        aportes[capa] = opciones.peso(capa, e.tiempo) * fuerza * factor
    total = sum(aportes.values())
    maximo = max(aportes.values())
    e.aportes = aportes
    e.lider = max(aportes, key=aportes.get) if maximo > 0 else destacado
    e.saliencia = maximo + 0.25 * (total - maximo)
    e.melodico = sum(aportes[c] for c in MELODIA) / total if total > 0 else 0.0
    # Si lidera el bajo (en el evento, o en el compás sin que la melodía lo
    # dispute), el contorno que se dibuja es el de la línea de bajo.
    sigue_bajo = e.lider == "bajo" or (destacado == "bajo" and e.lider != "melodia")
    if sigue_bajo and analisis.altura_bajo is not None:
        e.altura = analisis.valor(analisis.altura_bajo, e.tiempo + 0.03)
        e.confianza = analisis.maximo(analisis.confianza_bajo, e.tiempo + 0.02, 0.02)
    else:
        e.altura = analisis.valor(analisis.altura, e.tiempo + 0.03)
        e.confianza = analisis.maximo(analisis.confianza_melodia, e.tiempo + 0.02, 0.02)


def instrumentos_destacados(analisis: Analisis, eventos: list, opciones: "OpcionesGeneracion") -> dict:
    """Capa que lleva la música en cada compás: {índice de compás: capa}.

    Se suman los aportes de cada capa en los eventos del compás (ya con el peso
    del usuario y la atribución bombo/bajo resuelta) y, para las capas
    melódicas, cuánto suenan sostenidas (una voz larga tiene pocos ataques).
    Para que no salte de un instrumento a otro, solo se cambia de destacado si
    el nuevo supera al actual por un 25 %.
    """
    if not analisis.capas:
        return {}
    duracion_compas = analisis.periodo * analisis.compas
    primero = int(np.floor(-analisis.offset / duracion_compas))
    ultimo = int(np.ceil((analisis.duracion - analisis.offset) / duracion_compas))
    ataques: dict[int, dict[str, float]] = {}
    for e in eventos:
        suma = ataques.setdefault(e.compas, {})
        for capa, aporte in e.aportes.items():
            suma[capa] = suma.get(capa, 0.0) + aporte

    destacados = {}
    actual = None
    for b in range(primero, ultimo):
        t0 = analisis.offset + b * duracion_compas
        i = analisis.frame(max(t0, 0.0))
        j = max(analisis.frame(min(t0 + duracion_compas, analisis.duracion)), i + 1)
        puntajes = {}
        for capa in analisis.capas:
            actividad = min(1.0, ataques.get(b, {}).get(capa, 0.0) / duracion_compas / _ATAQUES_PLENOS)
            puntaje = actividad
            presencia = analisis.capas[capa].presencia
            if capa in MELODIA and presencia is not None:
                medio = t0 + duracion_compas / 2
                puntaje = 0.5 * actividad + 0.5 * opciones.peso(capa, medio) * float(presencia[i:j].mean())
            puntajes[capa] = puntaje
        mejor = max(puntajes, key=puntajes.get)
        if puntajes[mejor] < 0.05:
            actual = None
        elif actual is None or puntajes[mejor] > 1.25 * puntajes.get(actual, 0.0):
            actual = mejor
        destacados[b] = actual
    return destacados


def _atenuar_colas(eventos: list, ventana: float = 0.15) -> None:
    """La cola tonal de un golpe (bombo 808, cuerpo de la caja) pasa a la parte
    armónica con retraso y parece un ataque melódico. Si un ataque armónico sin
    cambio de altura llega poco después de un golpe percusivo más fuerte, se atenúa.
    """
    for i, e in enumerate(eventos):
        melodica = max((e.fuerza(c) for c in MELODIA), default=0.0)
        if melodica <= 0 or e.cambio >= 0.1:
            continue
        j = i - 1
        while j >= 0 and e.tiempo - eventos[j].tiempo <= ventana:
            golpe = max((eventos[j].fuerza(c) for c in PERCUSION), default=0.0)
            if golpe >= 1.5 * melodica:
                for c in MELODIA:
                    if c in e.capas:
                        e.capas[c] *= 0.3
                break
            j -= 1


# ---------------------------------------------------------------------------
# 2. Selección por sección y regularización entre compases
# ---------------------------------------------------------------------------

def _hay_espacio(tiempos: list, t: float, separacion: float) -> bool:
    i = bisect_left(tiempos, t)
    if i < len(tiempos) and tiempos[i] - t < separacion - 1e-6:
        return False
    return not (i > 0 and t - tiempos[i - 1] < separacion - 1e-6)


def seleccionar_eventos(analisis: Analisis, eventos: list, perfil: PerfilDificultad,
                        opciones: "OpcionesGeneracion") -> list:
    densidad = opciones.densidad
    elegidos: set[int] = set()
    tiempos: list[float] = []
    umbrales: dict[int, float] = {}
    seccion_de = []
    for e in eventos:
        s = analisis.seccion_en(e.tiempo)
        seccion_de.append(analisis.secciones.index(s) if s is not None else 0)
    # Piso global: en secciones casi vacías no se rellena con eco ni ruido.
    piso = 0.08
    if eventos:
        proporcion = {"Easy": 0.3, "Normal": 0.3, "Hard": 0.25, "Insane": 0.2}.get(perfil.nombre, 0.3)
        piso = max(piso, proporcion * float(np.percentile([e.saliencia for e in eventos], 75)))

    for indice_seccion, seccion in enumerate(analisis.secciones or [None]):
        miembros = [i for i, s in enumerate(seccion_de) if s == indice_seccion]
        if not miembros:
            continue
        if seccion is None:
            duracion, factor, intensidad = analisis.duracion, 1.0, 0.5
        else:
            duracion = seccion.fin - seccion.inicio
            factor = _FACTOR_SECCION[seccion.etiqueta]
            intensidad = seccion.intensidad
        objetivo = int(round(perfil.nps * densidad * factor * (0.6 + 0.8 * intensidad) * duracion))
        # En el clímax se aceptan golpes más suaves: es donde más notas se esperan.
        piso_seccion = piso * (0.6 if seccion is not None and seccion.kiai else 1.0)
        tomados = 0
        umbral = 1.0
        for i in sorted(miembros, key=lambda i: -eventos[i].saliencia):
            if tomados >= objetivo or eventos[i].saliencia < piso_seccion:
                break
            if not _hay_espacio(tiempos, eventos[i].tiempo, perfil.separacion_min):
                continue
            elegidos.add(i)
            insort(tiempos, eventos[i].tiempo)
            tomados += 1
            umbral = eventos[i].saliencia
        umbrales[indice_seccion] = umbral

    # Regularización: lo que se repite en los compases vecinos entra; lo aislado y débil sale.
    por_posicion = {(e.compas, e.posicion): i for i, e in enumerate(eventos)}

    def elegido_en(compas, posicion):
        j = por_posicion.get((compas, posicion))
        return j is not None and j in elegidos

    for i, e in enumerate(eventos):
        umbral = umbrales.get(seccion_de[i], 1.0)
        vecinos = [elegido_en(e.compas + d, e.posicion) for d in (-2, -1, 1, 2)]
        if i not in elegidos:
            repetido = (vecinos[1] and vecinos[2]) or (vecinos[0] and vecinos[3])
            # La repetición en los compases vecinos es evidencia suficiente: el piso se relaja.
            if (repetido and e.saliencia >= max(0.5 * piso, 0.5 * umbral)
                    and _hay_espacio(tiempos, e.tiempo, perfil.separacion_min)):
                elegidos.add(i)
                insort(tiempos, e.tiempo)
        elif not any(vecinos) and e.saliencia < 1.3 * umbral and e.nivel >= 2:
            elegidos.discard(i)
            tiempos.pop(bisect_left(tiempos, e.tiempo))
    seleccion = [eventos[i] for i in sorted(elegidos, key=lambda i: eventos[i].tiempo)]
    libres = [e for i, e in enumerate(eventos) if i not in elegidos]
    return rellenar_huecos(analisis, seleccion, libres, perfil, opciones, piso)


def _hueco_maximo(analisis: Analisis, perfil: PerfilDificultad, t: float) -> float:
    seccion = analisis.seccion_en(t)
    factor = _FACTOR_HUECO[seccion.etiqueta] if seccion is not None else 1.0
    # Un pulso sin notas nunca es un hueco: es parte del ritmo.
    return max(1.0, _HUECO_MAXIMO[perfil.nombre] * factor) * analisis.periodo


def _evento_de_pulso(analisis: Analisis, t: float) -> _Evento:
    pulso = analisis.indice_pulso(t)
    compas, pulso_en_compas = divmod(pulso, analisis.compas)
    e = _Evento(float(t), compas, pulso_en_compas * _UNIDADES_PULSO,
                0 if pulso_en_compas == 0 else 1, relleno=True)
    e.altura = analisis.valor(analisis.altura, t + 0.03)
    e.confianza = analisis.maximo(analisis.confianza_melodia, t + 0.02, 0.02)
    e.melodico = 1.0 if e.confianza > 0.3 else 0.5
    e.saliencia = 0.05
    return e


def rellenar_huecos(analisis: Analisis, seleccion: list, libres: list, perfil: PerfilDificultad,
                    opciones: "OpcionesGeneracion", piso: float = 0.08) -> list:
    """Evita espacios vacíos mientras la música suena.

    Para cada hueco más largo que el máximo de la dificultad (más corto en el
    clímax), en este orden:
      1. si el sonido del evento anterior se sostiene, ese evento será un hold
         que cubre el hueco;
      2. se agregan los golpes reales más fuertes que habían quedado fuera;
      3. si aún queda hueco y la música está fuerte, notas en los pulsos.
    """
    if len(seleccion) < 2:
        return seleccion
    periodo = analisis.periodo
    libres = sorted(libres, key=lambda e: e.tiempo)
    tiempos_libres = [e.tiempo for e in libres]
    usados: set[int] = set()
    nuevos: list[_Evento] = []
    separacion = perfil.separacion_min
    # Holds de relleno ya pedidos, para respetar la misma pausa y el mismo tope de
    # tiempo cubierto que los holds normales.
    holds_relleno: list[tuple[float, float]] = []
    pausa_hold = _HOLD_PAUSA[perfil.nombre] * periodo / max(1.0, opciones.holds)

    def cabe_hold(t: float) -> bool:
        if holds_relleno and t < holds_relleno[-1][1] + pausa_hold:
            return False
        ventana = _HOLD_VENTANA * periodo
        cubierto = sum(max(0.0, min(f, t) - max(i, t - ventana)) for i, f in holds_relleno)
        return cubierto / ventana < _HOLD_COBERTURA * min(opciones.holds, 2.5)

    def intensidad_media(a, b):
        i, j = analisis.frame(a), max(analisis.frame(b), analisis.frame(a) + 1)
        return float(analisis.intensidad[i:j].mean())

    def suena_lo_elegido(a, b):
        """¿Suena algún instrumento al que el usuario le dio influencia (en este tramo)?"""
        if not analisis.capas:
            return True
        medio = (a + b) / 2
        peso_maximo = max(opciones.peso(c) for c in opciones.capas) or 1.0
        i, j = analisis.frame(a), max(analisis.frame(b), analisis.frame(a) + 1)
        return any(opciones.peso(c, medio) / peso_maximo * float(capa.presencia[i:j].mean()) >= 0.2
                   for c, capa in analisis.capas.items() if capa.presencia is not None)

    def rellenar(a: _Evento | None, t0: float, t1: float, profundidad: int = 0):
        maximo = _hueco_maximo(analisis, perfil, (t0 + t1) / 2)
        if t1 - t0 <= maximo * 1.05 or intensidad_media(t0, t1) < 0.25 or profundidad > 64:
            return
        # 1. Hold sobre un sonido sostenido.
        capa_hold = a.capa_sostenida() if a is not None else None
        if (a is not None and opciones.holds > 0 and profundidad == 0 and cabe_hold(a.tiempo)
                and (capa_hold is None or opciones.peso(capa_hold, a.tiempo) > 0)):
            sostenido = analisis.sostenido(a.tiempo, capa=capa_hold)
            tope = hold_maximo(perfil, periodo, opciones.holds)
            if sostenido >= 0.6 * min(t1 - t0, tope) and sostenido >= perfil.hold_min_pulsos * periodo:
                # El hold cubre hasta su largo máximo; lo que sobra se rellena con notas.
                a.hold_hasta = min(t1, t0 + min(sostenido, tope))
                holds_relleno.append((a.tiempo, a.hold_hasta))
                if t1 - a.hold_hasta > maximo:
                    rellenar(None, a.hold_hasta, t1, profundidad + 1)
                return
        # 2. El golpe real más fuerte que quedó afuera dentro del hueco.
        i0 = bisect_left(tiempos_libres, t0 + separacion - 1e-6)
        i1 = bisect_left(tiempos_libres, t1 - separacion + 1e-6)
        mejor = None
        for j in range(i0, i1):
            # Golpes más suaves que los elegidos, pero no roces de capas sin influencia.
            if j in usados or libres[j].saliencia < max(0.03, 0.4 * piso):
                continue
            puntaje = libres[j].saliencia + _BONO_NIVEL[libres[j].nivel]
            if mejor is None or puntaje > mejor[0]:
                mejor = (puntaje, j)
        if mejor is not None:
            j = mejor[1]
            usados.add(j)
            nuevos.append(libres[j])
            rellenar(None, t0, libres[j].tiempo, profundidad + 1)
            rellenar(libres[j], libres[j].tiempo, t1, profundidad + 1)
            return
        # 3. Pulsos, solo si la música está claramente sonando (y es música elegida).
        if intensidad_media(t0, t1) < 0.45 or not suena_lo_elegido(t0, t1):
            return
        paso = max(1, int(round(maximo / periodo))) * periodo
        primero = analisis.offset + np.ceil((t0 + separacion - analisis.offset) / periodo) * periodo
        t = primero
        while t < t1 - max(separacion, 0.5 * periodo):
            nuevos.append(_evento_de_pulso(analisis, t))
            t += paso

    previos = list(seleccion)
    for a, b in zip(previos, previos[1:]):
        rellenar(a, a.tiempo, b.tiempo)
    return sorted(previos + nuevos, key=lambda e: e.tiempo)


# ---------------------------------------------------------------------------
# 3. Frases de ritmo constante
# ---------------------------------------------------------------------------

def intervalo_minimo(frase: list) -> float:
    if len(frase) < 2:
        return 0.0
    return float(min(b.tiempo - a.tiempo for a, b in zip(frase, frase[1:])))


def agrupar_frases(eventos: list, periodo: float, maximo: int = 16) -> list:
    """Agrupa eventos en frases de velocidad parecida.

    Una frase admite intervalos entre su mínimo y el doble (una ráfaga con un
    golpe faltante o un ritmo 3-3-2 siguen siendo la misma frase); se corta en
    silencios de más de un pulso (dos en frases lentas), cuando el ritmo cambia
    de velocidad o, en frases largas, al llegar a un tiempo del compás.
    """
    frases: list[list] = []
    actual: list = []
    minimo = None
    for e in eventos:
        if actual:
            dt = e.tiempo - actual[-1].tiempo
            lenta = minimo is not None and minimo > periodo * 1.01
            silencio = dt > periodo * (2.01 if lenta or minimo is None else 1.01)
            cambia = minimo is not None and (dt > 2.01 * minimo or dt < 0.49 * minimo)
            if silencio or cambia or (len(actual) >= maximo and e.nivel <= 1):
                frases.append(actual)
                actual, minimo = [], None
            else:
                minimo = dt if minimo is None else min(minimo, dt)
        actual.append(e)
    if actual:
        frases.append(actual)
    return frases


# ---------------------------------------------------------------------------
# Catálogo de patrones
# ---------------------------------------------------------------------------

_CELDAS = {
    4: [(0, 1, 2, 3), (3, 2, 1, 0), (0, 2, 1, 3), (3, 1, 2, 0), (0, 1, 3, 2), (1, 0, 2, 3),
        (0, 3, 1, 2), (1, 3, 0, 2)],
    7: [(0, 1, 2, 4, 5, 6), (6, 5, 4, 2, 1, 0), (0, 2, 4, 6, 5, 3, 1), (0, 4, 1, 5, 2, 6),
        (2, 1, 0, 4, 5, 6), (0, 6, 1, 5, 2, 4), (1, 2, 4, 5), (0, 3, 6, 4, 2)],
}
_CELDAS_TERNARIAS = {
    4: [(0, 1, 2), (3, 2, 1), (0, 2, 3), (3, 1, 0), (0, 1, 3, 2, 3, 1)],
    7: [(0, 1, 2), (6, 5, 4), (0, 2, 4), (6, 4, 2), (1, 2, 3, 5, 4, 3)],
}
_JUMPTRILLS = {
    4: [((0, 1), (2, 3)), ((0, 2), (1, 3)), ((0, 3), (1, 2))],
    7: [((0, 1), (5, 6)), ((1, 2), (4, 5)), ((0, 2), (4, 6)), ((0, 1, 2), (4, 5, 6))],
}


def _manos(k: int):
    izquierda = list(range(k // 2))
    derecha = list(range(k - k // 2, k))
    return izquierda, derecha


def _patron_escalera(n, k, rng):
    direccion = int(rng.choice([-1, 1]))
    columna = int(rng.integers(k))
    salida = []
    for _ in range(n):
        salida.append((columna,))
        siguiente = columna + direccion
        if not 0 <= siguiente < k:
            direccion *= -1
            siguiente = columna + direccion
        columna = siguiente
    return salida


def _patron_trino(n, k, rng):
    if k == 4:
        parejas = [(1, 2), (0, 3), (0, 1), (2, 3), (0, 2), (1, 3)]
    else:
        parejas = [(2, 4), (1, 5), (0, 6), (1, 2), (4, 5), (2, 5), (3, 4)]
    a, b = parejas[int(rng.integers(len(parejas)))]
    return [((a,) if i % 2 == 0 else (b,)) for i in range(n)]


def _patron_celda(n, k, rng, ternario=False):
    celdas = (_CELDAS_TERNARIAS if ternario else _CELDAS)[k]
    celda = celdas[int(rng.integers(len(celdas)))]
    return [(celda[i % len(celda)],) for i in range(n)]


def _patron_jumptrill(n, k, rng, acorde_max):
    opciones = [j for j in _JUMPTRILLS[k] if len(j[0]) <= acorde_max]
    a, b = opciones[int(rng.integers(len(opciones)))]
    return [a if i % 2 == 0 else b for i in range(n)]


def _patron_brackets(n, k, rng):
    inicio = int(rng.integers(k - 3))
    base = [(inicio, inicio + 1), (inicio + 2, inicio + 3), (inicio + 1, inicio + 2)]
    return [base[i % 3] for i in range(n)]


def _patron_chordjack(n, k, rng):
    ancla = int(rng.integers(k))
    otras = [c for c in range(k) if c != ancla]
    rng.shuffle(otras)
    return [(ancla, otras[i % len(otras)]) for i in range(n)]


def _patron_manos(n, k, rng, eventos):
    izquierda, derecha = _manos(k)
    lado = int(rng.integers(2))
    salida = []
    for i in range(n):
        mano = (izquierda, derecha)[lado]
        if i > 0 and eventos[i].altura > eventos[i - 1].altura + 0.5:
            columna = mano[-1] if lado == 1 else mano[min(1, len(mano) - 1)]
        elif i > 0 and eventos[i].altura < eventos[i - 1].altura - 0.5:
            columna = mano[0] if lado == 0 else mano[max(0, len(mano) - 2)]
        else:
            columna = mano[int(rng.integers(len(mano)))]
        salida.append((columna,))
        lado = 1 - lado
    return salida


def _patron_melodia(n, k, rng, eventos, jack_min):
    """Dibuja el contorno de la melodía (o del bajo) de forma relativa.

    Si la nota sube, la columna se mueve a la derecha; si baja, a la izquierda
    (dos columnas en saltos grandes, si caben). Cada tramo que sube o baja
    arranca desde una columna que le deje espacio. Una nota repetida rápida se
    vuelve un trino con la columna vecina.
    """
    alturas = np.round([e.altura for e in eventos])
    if np.unique(alturas).size <= 1:
        return _patron_trino(n, k, rng)
    saltos = np.diff(alturas)
    direcciones = np.sign(saltos)

    def largo_tramo(i, signo):
        """Cuántos movimientos seguidos en `signo` empiezan en el salto i (las repeticiones no cortan)."""
        largo = 0
        while i < len(direcciones) and direcciones[i] in (0, signo):
            largo += direcciones[i] != 0
            i += 1
        return largo

    no_nulas = [d for d in direcciones if d != 0]
    primera = no_nulas[0] if no_nulas else 1
    largo = largo_tramo(0, primera)
    columna = max(0, (k - 1) - largo) if primera > 0 else min(k - 1, largo)
    columna = int(columna if largo < k else (0 if primera > 0 else k - 1))
    salida = [(columna,)]
    base = columna  # columna "propia" de la nota (sin el desvío del trino)
    for i, salto in enumerate(saltos):
        if salto == 0:
            dt = eventos[i + 1].tiempo - eventos[i].tiempo
            if dt < 2 * jack_min:
                vecina = salida[-1][0] + (1 if salida[-1][0] == base and base + 1 < k else -1)
                if salida[-1][0] != base:
                    vecina = base
                salida.append((int(np.clip(vecina, 0, k - 1)),))
            else:
                salida.append((base,))
            continue
        signo = int(np.sign(salto))
        paso = 2 if abs(salto) >= 5 and k > 4 else 1
        if abs(salto) >= 7 and k == 4:
            paso = 2
        destino = base + signo * paso
        if not 0 <= destino < k:
            destino = base + signo  # el salto grande no cabe: un solo paso
        if not 0 <= destino < k:
            destino = base - signo  # tope del teclado: inevitable rebotar
        base = int(np.clip(destino, 0, k - 1))
        salida.append((base,))
    return salida


def _espejo(columnas, k):
    return [tuple(sorted(k - 1 - c for c in cols)) for cols in columnas]


# ---------------------------------------------------------------------------
# 4. Colocación jugable
# ---------------------------------------------------------------------------

class _Asignador:
    def __init__(self, analisis: Analisis, opciones: OpcionesGeneracion, perfil: PerfilDificultad):
        self.a = analisis
        self.o = opciones
        self.p = perfil
        self.k = opciones.teclas
        self.rng = np.random.default_rng(opciones.semilla)
        self.ultimo = np.full(self.k, -10.0)
        self.uso = np.zeros(self.k)
        self.total_notas = 0
        self.fin_hold = np.full(self.k, -10.0)
        self.notas: list[Nota] = []
        self.holds_activos: dict[int, Nota] = {}
        self.memoria: dict[tuple, tuple] = {}
        self.frases: list[tuple[str, int]] = []
        self.limite_holds = 1 if perfil.nombre == "Easy" and self.k == 4 else max(1, self.k // 2)
        self.tiempos_eventos: list[float] = []
        self.paso_hold = self.a.periodo / (2 if perfil.divisor <= 2 else 4)
        self.hueco_hold = max(0.06, perfil.jack_min * 0.5)  # tras soltar un hold
        self.hold_maximo = hold_maximo(perfil, self.a.periodo, opciones.holds)
        self.holds_hechos: list[tuple[float, float, int]] = []  # (inicio, fin, columna)

    # -- elección del patrón -------------------------------------------------
    def _pesos_patrones(self, frase, dt):
        p, k = self.p, self.k
        pulsos = dt / self.a.periodo if dt else 1.0
        n = len(frase)
        intensidad = float(np.mean([self.a.valor(self.a.intensidad, e.tiempo) for e in frase]))
        confianza = float(np.mean([e.confianza for e in frase]))
        alturas = np.round([e.altura for e in frase])
        movimiento = float(np.mean(np.diff(alturas) != 0)) if n > 1 else 0.0
        agudos = float(np.mean([e.fuerza("platillos") > max(e.fuerza("bombo"), e.fuerza("caja"))
                                for e in frase]))
        melodica = float(np.mean([e.melodico for e in frase]))
        avanzado = p.nombre in ("Hard", "Insane")
        rapido = pulsos <= 1 / 3 + 0.02
        medio = not rapido and pulsos <= 0.5 + 0.02

        pesos = {}
        if p.nombre == "Easy":
            pesos = {"melodia": 3.0 * (0.3 + confianza), "manos": 2.0, "escalera": 1.0}
        elif rapido:
            pesos = {"escalera": 2.0, "celda": 3.0, "trino": 1.0 + 1.5 * max(agudos, 1 - movimiento),
                     "melodia": 3.0 * confianza * movimiento}
            if avanzado and intensidad > 0.55 and 2 * dt >= p.jack_min and p.acorde_max >= 2:
                pesos["jumptrill"] = 1.5 if p.nombre == "Insane" else 0.7
                if k == 7:
                    pesos["brackets"] = 1.0
        elif medio:
            pesos = {"celda": 2.0, "melodia": 3.5 * confianza * (0.3 + movimiento), "manos": 2.0,
                     "escalera": 1.0}
            if avanzado and intensidad > 0.55 and p.acorde_max >= 2:
                pesos["jumptrill"] = 1.0
                if k == 7:
                    pesos["brackets"] = 1.2
                if p.nombre == "Insane" and dt >= p.jack_min * 1.1:
                    pesos["chordjack"] = 1.0
        else:
            pesos = {"melodia": 3.0 * (0.3 + confianza), "manos": 2.0, "celda": 1.0}

        # Una frase llevada por la melodía dibuja su contorno; una llevada por la
        # batería usa patrones rítmicos.
        if "melodia" in pesos:
            pesos["melodia"] *= 0.2 + 4.0 * melodica
        for tipo in ("celda", "trino", "jumptrill", "chordjack", "brackets", "escalera"):
            if tipo in pesos:
                pesos[tipo] *= 0.3 + 1.7 * (1 - melodica)
        # Los patrones de acordes son percusivos: desaparecen si la percusión está en cero.
        for tipo in ("jumptrill", "chordjack", "brackets"):
            if tipo in pesos:
                pesos[tipo] *= min(1.0, 2 * self.o.percusion)
        return {t: w for t, w in pesos.items() if w > 0}

    def _generar_patron(self, tipo, frase, rng):
        n, k = len(frase), self.k
        dt = intervalo_minimo(frase) or self.a.periodo
        ternario = abs(dt / self.a.periodo - 1 / 3) < 0.03
        if tipo == "escalera":
            return _patron_escalera(n, k, rng)
        if tipo == "trino":
            return _patron_trino(n, k, rng)
        if tipo == "celda":
            return _patron_celda(n, k, rng, ternario)
        if tipo == "jumptrill":
            return _patron_jumptrill(n, k, rng, self.p.acorde_max)
        if tipo == "brackets":
            return _patron_brackets(n, k, rng)
        if tipo == "chordjack":
            return _patron_chordjack(n, k, rng)
        if tipo == "manos":
            return _patron_manos(n, k, rng, frase)
        return _patron_melodia(n, k, rng, frase, self.p.jack_min)

    def _patron_para(self, frase):
        n = len(frase)
        dt = intervalo_minimo(frase)
        unidad = self.a.periodo / _UNIDADES_PULSO
        firma = (frase[0].posicion,) + tuple(round((b.tiempo - a.tiempo) / unidad)
                                             for a, b in zip(frase, frase[1:]))
        if firma in self.memoria:
            tipo, semilla, veces = self.memoria[firma]
            self.memoria[firma] = (tipo, semilla, veces + 1)
            columnas = self._generar_patron(tipo, frase, np.random.default_rng(semilla))
            if tipo == "melodia":
                return tipo, columnas  # el contorno no se refleja: subir debe seguir siendo subir
            return tipo, (_espejo(columnas, self.k) if veces % 2 else columnas)
        melodica = float(np.mean([e.melodico for e in frase]))
        confianza = float(np.mean([e.confianza for e in frase]))
        alturas = np.round([e.altura for e in frase])
        movimiento = float(np.mean(np.diff(alturas) != 0)) if n > 1 else 0.0
        if n < 3:
            tipo = "suelta"
        elif melodica >= 0.7 and confianza >= 0.25 and movimiento >= 0.3 and self.p.nombre != "Easy":
            tipo = "melodia"  # la lleva la melodía o el bajo: se dibuja su contorno
        else:
            pesos = self._pesos_patrones(frase, dt)
            if melodica <= 0.3:
                pesos.pop("melodia", None)  # la lleva la batería: patrones rítmicos
            if not pesos:
                pesos = {"celda": 1.0}
            tipos = list(pesos)
            valores = np.array([pesos[t] for t in tipos])
            tipo = tipos[int(self.rng.choice(len(tipos), p=valores / valores.sum()))]
        semilla = int(self.rng.integers(1 << 30))
        columnas = self._generar_patron("melodia" if tipo == "suelta" else tipo, frase,
                                        np.random.default_rng(semilla))
        # Se elige la orientación que mejor empalma con lo anterior (salvo un
        # contorno melódico, que no se refleja).
        candidatas = [columnas] if tipo == "melodia" else [columnas, _espejo(columnas, self.k)]
        espejo = int(np.argmin([self._conflictos(frase, c) for c in candidatas]))
        if n >= 3:
            self.memoria[firma] = (tipo, semilla, espejo)
        return tipo, candidatas[espejo]

    def _conflictos(self, frase, columnas):
        total = 0
        for e, cols in zip(frase[:4], columnas[:4]):
            total += sum(not self._libre(c, e.tiempo) for c in cols)
        return total

    # -- estado de columnas --------------------------------------------------
    def _libre(self, c, t):
        return (self.fin_hold[c] <= t - self.hueco_hold
                and t - self.ultimo[c] >= self.p.jack_min - 1e-6)

    def _costo_extra(self, c, t, cerca_de):
        costo = abs(c - cerca_de) * 0.6 if cerca_de is not None else 0.0
        dt = t - self.ultimo[c]
        if dt < self.p.jack_min * 1.8:
            costo += 1.5
        if self.total_notas > 16:
            costo += max(0.0, self.uso[c] / self.total_notas - 1.0 / self.k) * self.k * 2.0
        if self.k == 7 and c == 3 and self.p.nombre in ("Easy", "Normal"):
            costo += 0.5
        return costo + self.rng.uniform(0, 0.3)

    def _tamano_acorde(self, evento, rapido):
        p = self.p
        if p.acorde_max <= 1 or evento.nivel > (2 if p.nombre == "Insane" else 1):
            return 1
        # Los acordes marcan golpes de bombo y caja, en proporción al peso de la percusión.
        atribuidas = evento.atribuidas or evento.capas
        fuerza = max(atribuidas.get("bombo", 0.0), 0.85 * atribuidas.get("caja", 0.0))
        fuerza *= min(1.0, 2 * self.o.percusion)
        umbral = {"Easy": 0.8, "Normal": 0.65, "Hard": 0.55, "Insane": 0.5}[p.nombre]
        if fuerza < umbral:
            return 1
        seccion = self.a.seccion_en(evento.tiempo)
        intensidad = seccion.intensidad if seccion is not None else 0.5
        extra = (p.acorde_max - 1) * min(1.0, (fuerza - umbral) / (1 - umbral + 1e-6) + 0.3)
        extra *= 0.5 + p.prob_acorde + 0.4 * intensidad + (0.2 if seccion is not None and seccion.kiai else 0)
        tamano = 1 + max(1, int(round(extra)))
        if rapido:
            tamano = min(tamano, 2 if self.k == 4 or p.nombre != "Insane" else 3)
        return min(tamano, p.acorde_max)

    def _colocar(self, evento, deseadas, tamano):
        t = evento.tiempo
        colocadas = []
        for c in deseadas:
            if self._libre(c, t) and c not in colocadas:
                colocadas.append(c)
                continue
            libres = [x for x in range(self.k) if self._libre(x, t) and x not in colocadas]
            if libres:
                colocadas.append(min(libres, key=lambda x: self._costo_extra(x, t, c)))
        if colocadas and len(colocadas) < tamano:
            izquierda, _ = _manos(self.k)
            ancla = colocadas[0]
            libres = [x for x in range(self.k) if self._libre(x, t) and x not in colocadas]
            # El acorde se reparte entre ambas manos.
            libres.sort(key=lambda x: self._costo_extra(x, t, None)
                        - (0.8 if (x in izquierda) != (ancla in izquierda) else 0.0))
            colocadas.extend(libres[: tamano - len(colocadas)])
        return tuple(sorted(colocadas))

    # -- holds ---------------------------------------------------------------
    def _liberar_holds(self, t: float):
        for c, nota in list(self.holds_activos.items()):
            if nota.fin <= t:
                del self.holds_activos[c]

    def _fin_musical(self, t: float, objetivo: float, minimo: float, limite: float) -> float | None:
        """Elige dónde soltar un hold que debería durar hasta `objetivo`.

        Se prefiere soltar justo cuando empieza otra nota (el gesto natural de un
        LN); si no hay ninguna cerca, en el tiempo más fuerte de la rejilla antes
        de que se apague el sonido.
        """
        a = self.a
        tolerancia = 0.5 * a.periodo
        i = bisect_left(self.tiempos_eventos, t + minimo - 1e-6)
        j = bisect_left(self.tiempos_eventos, min(objetivo + tolerancia, t + limite + 1e-6))
        if j > i:
            fin = self.tiempos_eventos[j - 1]
            if self.p.nombre == "Easy":
                fin -= self.paso_hold  # en Easy no se suelta y se presiona a la vez
            if fin - t >= minimo - 1e-6:
                return fin
        mejor = None
        paso = self.paso_hold
        k = np.floor((min(objetivo, t + limite) - a.offset) / paso + 1e-6)
        while True:
            fin = a.offset + k * paso
            if fin - t < minimo - 1e-6:
                break
            relativo = (fin - a.offset) / a.periodo
            fuerza = 2 if abs(relativo - round(relativo)) < 1e-6 else (1 if abs(2 * relativo - round(2 * relativo)) < 1e-6 else 0)
            if mejor is None or fuerza > mejor[0]:
                mejor = (fuerza, fin)
            if fuerza == 2:
                break
            k -= 1
        return mejor[1] if mejor else None

    def _quizas_hold(self, evento, nuevas: list):
        """Sostiene una de las notas del evento si el plan de holds lo eligió."""
        a = self.a
        t = nuevas[0].tiempo
        if evento.hold_plan <= t or len(self.holds_activos) >= self.limite_holds:
            return
        # Se prefiere una columna distinta de la del último hold; si la única posible es
        # la misma y el hold anterior fue hace poco, se deja como nota: variedad.
        ultima_columna = self.holds_hechos[-1][2] if self.holds_hechos else None
        candidatas = [n for n in nuevas if n.columna != ultima_columna]
        if not candidatas:
            relleno = evento.hold_hasta > t  # cubre un hueco: se aplica igual
            if not relleno and self.holds_hechos and t - self.holds_hechos[-1][1] < 2 * a.periodo:
                return
            candidatas = nuevas
        nota = candidatas[int(self.rng.integers(len(candidatas)))]
        minimo = self.p.hold_min_pulsos * a.periodo
        objetivo = evento.hold_plan
        fin = self._fin_musical(nota.tiempo, min(objetivo, a.duracion - 0.05), minimo, self.hold_maximo)
        if fin is None:
            return
        nota.fin = fin
        self.fin_hold[nota.columna] = fin
        self.holds_activos[nota.columna] = nota
        self.holds_hechos.append((nota.tiempo, fin, nota.columna))

    def _recortar_hold(self, t: float) -> bool:
        """Si todas las columnas están ocupadas, acorta el hold que termina antes."""
        if not self.holds_activos:
            return False
        c, nota = min(self.holds_activos.items(), key=lambda par: par[1].fin)
        nuevo_fin = t - max(self.hueco_hold, self.paso_hold)
        nota.fin = nuevo_fin if nuevo_fin - nota.tiempo >= 0.5 * self.a.periodo else None
        self.fin_hold[c] = nota.fin if nota.fin is not None else nota.tiempo
        del self.holds_activos[c]
        return True

    # -- recorrido -----------------------------------------------------------
    def asignar(self, eventos: list) -> list:
        frases = agrupar_frases(eventos, self.a.periodo)
        self.tiempos_eventos = [e.tiempo for e in eventos]
        for indice_frase, frase in enumerate(frases):
            tipo, columnas = self._patron_para(frase)
            self.frases.append((tipo, len(frase)))
            dt = intervalo_minimo(frase) or self.a.periodo
            rapido = dt <= self.a.periodo / 3 + 1e-3
            con_acordes = tipo not in ("jumptrill", "brackets", "chordjack")
            for i, (evento, deseadas) in enumerate(zip(frase, columnas)):
                t = evento.tiempo
                self._liberar_holds(t)
                tamano = max(len(deseadas), self._tamano_acorde(evento, rapido) if con_acordes else 1)
                colocadas = self._colocar(evento, deseadas, tamano)
                if not colocadas and self._recortar_hold(t):
                    colocadas = self._colocar(evento, deseadas[:1], 1)
                if not colocadas:
                    continue
                nuevas = [Nota(t, c) for c in colocadas]
                for nota in nuevas:
                    self.ultimo[nota.columna] = t
                    self.uso[nota.columna] += 1
                self.total_notas += len(nuevas)
                self.notas.extend(nuevas)
                # En ráfagas solo se sostiene al inicio o al final de la frase.
                self._quizas_hold(evento, nuevas)
        return self.notas


# ---------------------------------------------------------------------------
# Plan de holds
# ---------------------------------------------------------------------------

def planificar_holds(analisis: Analisis, eventos: list, perfil: PerfilDificultad,
                     opciones: OpcionesGeneracion) -> None:
    """Decide qué eventos serán holds, mirando toda la canción a la vez.

    Cada nota que se sostiene recibe un puntaje: cuánto dura de verdad (en su
    capa), si es del instrumento destacado y si es melódica. Se eligen de mayor
    a menor respetando un largo máximo, una pausa entre holds, que no haya dos
    eventos seguidos con hold y un tope de tiempo cubierto por holds. Así los
    holds caen en las notas más largas y no tapan la canción.
    """
    if opciones.holds <= 0 or not eventos:
        return
    periodo = analisis.periodo
    minimo = perfil.hold_min_pulsos * periodo
    tope = hold_maximo(perfil, periodo, opciones.holds)
    pausa_base = _HOLD_PAUSA[perfil.nombre] * periodo / max(1.0, opciones.holds)
    cobertura = _HOLD_COBERTURA * min(opciones.holds, 2.5)
    ventana = _HOLD_VENTANA * periodo
    consecutivos = opciones.holds >= 1.8  # estilo LN marcado: se permiten holds seguidos

    candidatos = []
    for i, e in enumerate(eventos):
        rapido = any(0 < abs(eventos[j].tiempo - e.tiempo) < periodo / 3 + 1e-3
                     for j in (i - 1, i + 1) if 0 <= j < len(eventos))
        if e.hold_hasta > e.tiempo:
            # El relleno de huecos lo pidió (ya respetando pausa y cobertura).
            candidatos.append((100.0, i, e.hold_hasta - e.tiempo, True))
            continue
        capa = e.capa_sostenida()
        if capa is not None and opciones.peso(capa, e.tiempo) > 0:
            sostenido = analisis.sostenido(e.tiempo, capa=capa)
            # Margen del 15 %: una nota de un pulso que se apaga un poco antes sigue valiendo.
            if sostenido >= 0.85 * minimo:
                duracion = min(max(sostenido, minimo), tope)
                puntaje = (duracion / periodo) * (0.4 + e.melodico)
                if capa == e.destacado:
                    puntaje *= 1.5
                if rapido:
                    puntaje *= 0.35
                candidatos.append((puntaje, i, duracion, False))
                continue
        if opciones.holds > 1.0:
            # Estilo LN: también se alargan notas cortas mientras la otra mano toca.
            duracion = min(max(minimo, periodo), tope)
            candidatos.append((0.3 * (opciones.holds - 1.0), i, duracion, False))

    rng = np.random.default_rng(opciones.semilla + 7)
    candidatos.sort(key=lambda c: -(c[0] + rng.uniform(0, 0.05)))
    elegidos: list[tuple[float, float]] = []   # (inicio, fin), ordenados
    indices: set[int] = set()
    for puntaje, i, duracion, forzado in candidatos:
        if puntaje < 0.25:
            break
        e = eventos[i]
        inicio, fin = e.tiempo, e.tiempo + duracion
        if not forzado:
            pausa = pausa_base * (0.5 if e.capa_sostenida() == e.destacado else 1.0)
            if any(inicio < f + pausa and fin + pausa > a for a, f in elegidos):
                continue
            if not consecutivos and (i - 1 in indices or i + 1 in indices):
                continue
            cubierto = sum(max(0.0, min(f, fin) - max(a, fin - ventana)) for a, f in elegidos)
            if (cubierto + duracion) / ventana > cobertura:
                continue
        elegidos.append((inicio, fin))
        indices.add(i)
        e.hold_plan = fin


# ---------------------------------------------------------------------------
# Punto de entrada
# ---------------------------------------------------------------------------

def generar_mapa(analisis: Analisis, opciones: OpcionesGeneracion) -> Mapa:
    perfil = obtener_perfil(opciones.dificultad, opciones.teclas)
    eventos = construir_eventos(analisis, perfil, opciones)
    tramos = tramos_destacados(analisis, eventos)
    eventos = seleccionar_eventos(analisis, eventos, perfil, opciones)
    planificar_holds(analisis, eventos, perfil, opciones)
    asignador = _Asignador(analisis, opciones, perfil)
    notas = asignador.asignar(eventos)
    notas = [n for n in notas if 0 <= n.tiempo < analisis.duracion]
    notas.sort(key=lambda n: (n.tiempo, n.columna))
    divisor = 4 if perfil.divisor >= 4 else 2
    return Mapa(opciones.teclas, opciones.dificultad, perfil, notas, divisor_editor=divisor,
                frases=asignador.frases, destacados=tramos)


def tramos_destacados(analisis: Analisis, eventos: list) -> list:
    """Une los compases seguidos con el mismo instrumento destacado en tramos."""
    duracion_compas = analisis.periodo * analisis.compas
    destacados = {e.compas: e.destacado for e in eventos}
    tramos = []
    for b, capa in sorted(destacados.items()):
        inicio = max(0.0, analisis.offset + b * duracion_compas)
        fin = min(analisis.duracion, analisis.offset + (b + 1) * duracion_compas)
        if fin <= inicio or capa is None:
            continue
        if tramos and tramos[-1][2] == capa and abs(tramos[-1][1] - inicio) < 1e-6:
            tramos[-1] = (tramos[-1][0], fin, capa)
        else:
            tramos.append((inicio, fin, capa))
    return tramos
