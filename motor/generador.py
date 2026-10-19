"""Motor de generación híbrida.

Convierte un `Analisis` en notas de osu!mania en cuatro etapas:

1. Rejilla: subdivide cada pulso según la dificultad (1/2, 1/4 y 1/3 donde la
   música tiene tresillos).
2. Selección de eventos: puntúa cada punto de la rejilla combinando golpes
   (envolvente de onset), cambios melódicos y peso métrico, y elige por compás
   tantos eventos como pida la densidad objetivo de la sección.
3. Asignación de columnas: cada evento busca la columna (o el acorde) de menor
   costo. El costo mezcla una posición preferida —que sale del contorno
   melódico, del motivo rítmico activo (escalera, trino, alternancia de manos)
   y de la banda dominante (graves a la izquierda, agudos a la derecha)— con
   restricciones de jugabilidad: jacks demasiado rápidos, anclas, holds activos
   y equilibrio entre manos.
4. Holds: las notas cuyo sonido se sostiene se alargan hasta la rejilla.

Todo es determinista para una misma semilla.
"""

from dataclasses import dataclass, field
from itertools import combinations

import numpy as np

from .analisis import Analisis
from .dificultades import PerfilDificultad, perfil as obtener_perfil

ESTILOS = ("hibrido", "ritmo", "melodia")

# Pesos (melodía, motivo rítmico, banda) de la posición preferida según el estilo.
_PESOS_ESTILO = {
    "hibrido": (0.65, 0.5, 0.25),
    "ritmo": (0.15, 0.75, 0.45),
    "melodia": (1.0, 0.25, 0.1),
}
# Pesos (golpe, melodía) del puntaje de selección de eventos.
_PESOS_SELECCION = {
    "hibrido": (0.85, 0.55),
    "ritmo": (1.0, 0.2),
    "melodia": (0.55, 1.0),
}
_PESO_NIVEL = {0: 0.35, 1: 0.25, 2: 0.1, 3: 0.0}


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
    estilo: str = "hibrido"
    densidad: float = 1.0
    holds: float = 1.0
    semilla: int = 0

    def __post_init__(self):
        if self.teclas not in (4, 7):
            raise ValueError("Solo se admiten 4K y 7K.")
        if self.estilo not in ESTILOS:
            raise ValueError(f"Estilo desconocido: {self.estilo}")
        self.densidad = float(np.clip(self.densidad, 0.3, 2.5))
        self.holds = float(np.clip(self.holds, 0.0, 3.0))


@dataclass
class Mapa:
    teclas: int
    dificultad: str
    perfil: PerfilDificultad
    notas: list = field(default_factory=list)
    divisor_editor: int = 4


@dataclass
class _Punto:
    tiempo: float
    nivel: int        # 0 tiempo fuerte, 1 pulso, 2 medio pulso, 3 subdivisión menor
    tolerancia: float
    puntaje: float = 0.0
    golpe: float = 0.0
    bajo: float = 0.0
    alto: float = 0.0


# ---------------------------------------------------------------------------
# 1. Rejilla
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


def construir_rejilla(analisis: Analisis, perfil: PerfilDificultad) -> list:
    periodo = analisis.periodo
    puntos = []
    for t in analisis.pulsos():
        indice = analisis.indice_pulso(t)
        divisor = perfil.divisor
        if perfil.tresillos and _usa_tresillos(analisis, t, periodo):
            divisor = 3
        paso = periodo / divisor
        for k in range(divisor):
            tiempo = t + k * paso
            if tiempo >= analisis.duracion - 0.05:
                break
            if k == 0:
                nivel = 0 if indice % analisis.compas == 0 else 1
            elif divisor == 4 and k == 2 or divisor == 2:
                nivel = 2
            else:
                nivel = 3
            puntos.append(_Punto(tiempo, nivel, min(0.035, paso * 0.4)))
    return puntos


# ---------------------------------------------------------------------------
# 2. Selección de eventos
# ---------------------------------------------------------------------------

def _cambio_melodico(analisis: Analisis, t: float) -> float:
    confianza = analisis.maximo(analisis.confianza_melodia, t + 0.02, 0.02)
    if confianza < 0.25:
        return 0.0
    antes = analisis.valor(analisis.altura, t - 0.05)
    despues = analisis.valor(analisis.altura, t + 0.04)
    salto = abs(despues - antes)
    if salto < 0.5:
        return 0.0
    return confianza * min(1.0, salto / 3.0)


def puntuar(analisis: Analisis, puntos: list, perfil: PerfilDificultad, estilo: str) -> None:
    peso_golpe, peso_melodia = _PESOS_SELECCION[estilo]
    for p in puntos:
        p.golpe = analisis.maximo(analisis.env, p.tiempo, p.tolerancia)
        p.bajo = analisis.maximo(analisis.env_bajo, p.tiempo, p.tolerancia)
        p.alto = analisis.maximo(analisis.env_alto, p.tiempo, p.tolerancia)
        melodia = _cambio_melodico(analisis, p.tiempo)
        musical = peso_golpe * p.golpe + peso_melodia * melodia
        if analisis.valor(analisis.intensidad, p.tiempo) < 0.06 and musical < 0.15:
            p.puntaje = 0.0
            continue
        metrico = _PESO_NIVEL[p.nivel] * perfil.peso_metrico if musical > 0.1 else 0.0
        p.puntaje = musical + metrico


def _factor_seccion(analisis: Analisis, t: float) -> float:
    seccion = analisis.seccion_en(t)
    if seccion is None:
        return 1.0
    return {"tranquila": 0.6, "media": 0.9, "intensa": 1.1, "clímax": 1.25}[seccion.etiqueta]


def seleccionar_eventos(analisis: Analisis, puntos: list, perfil: PerfilDificultad,
                        densidad: float) -> list:
    duracion_compas = analisis.periodo * analisis.compas
    elegidos = []
    i = 0
    umbral = 0.12
    while i < len(puntos):
        inicio = puntos[i].tiempo
        j = i
        while j < len(puntos) and puntos[j].tiempo < inicio + duracion_compas - 1e-6:
            j += 1
        grupo = puntos[i:j]
        a = analisis.frame(inicio)
        b = max(analisis.frame(inicio + duracion_compas), a + 1)
        intensidad = float(analisis.intensidad[a:b].mean())
        objetivo = (perfil.nps * densidad * (0.45 + 1.1 * intensidad)
                    * _factor_seccion(analisis, inicio) * duracion_compas)
        cantidad = int(round(objetivo))

        tomados = []
        for p in sorted(grupo, key=lambda q: -q.puntaje):
            if len(tomados) >= cantidad or p.puntaje < umbral:
                break
            vecinos = tomados + elegidos[-2:]
            if any(abs(p.tiempo - q.tiempo) < perfil.separacion_min - 1e-6 for q in vecinos):
                continue
            tomados.append(p)
        elegidos.extend(sorted(tomados, key=lambda q: q.tiempo))
        i = j
    return elegidos


# ---------------------------------------------------------------------------
# 3. Asignación de columnas y 4. holds
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
        self.historial: list[tuple[float, tuple]] = []
        self.notas: list[Nota] = []
        self.holds_activos: dict[int, Nota] = {}
        self.direccion = 1
        self.seccion_actual = None
        self.trino = (1, 2)
        self.rangos_melodia = self._rangos_melodia()
        self.limite_holds = 1 if perfil.nombre in ("Easy", "Normal") and self.k == 4 else max(1, self.k // 2)
        self.paso_hold = self.a.periodo / (2 if perfil.divisor <= 2 else 4)
        self.hueco_hold = max(0.06, perfil.jack_min * 0.5)  # tras soltar un hold

    def _rangos_melodia(self):
        rangos = {}
        for s in self.a.secciones:
            a = self.a.frame(s.inicio)
            b = max(self.a.frame(s.fin), a + 1)
            confiables = self.a.confianza_melodia[a:b] > 0.3
            alturas = self.a.altura[a:b][confiables]
            if alturas.size < 10:
                alturas = self.a.altura[a:b]
            bajo, alto = np.percentile(alturas, [10, 90])
            rangos[id(s)] = (float(bajo), float(max(alto, bajo + 5)))
        return rangos

    # -- posición preferida ----------------------------------------------
    def _nuevo_motivo(self, seccion):
        self.seccion_actual = seccion
        self.direccion = int(self.rng.choice([-1, 1]))
        if self.k == 4:
            parejas = [(1, 2), (0, 3), (0, 1), (2, 3), (0, 2), (1, 3)]
        else:
            parejas = [(2, 4), (1, 5), (0, 6), (1, 2), (4, 5), (2, 5)]
        self.trino = parejas[int(self.rng.integers(len(parejas)))]

    def _preferencia(self, punto: _Punto) -> float:
        a, k = self.a, self.k
        t = punto.tiempo
        seccion = a.seccion_en(t)
        if seccion is not self.seccion_actual:
            self._nuevo_motivo(seccion)

        # Melodía: altura relativa dentro del rango de la sección.
        confianza = a.maximo(a.confianza_melodia, t + 0.02, 0.02)
        bajo, alto = self.rangos_melodia.get(id(seccion), (55.0, 75.0))
        altura = a.valor(a.altura, t + 0.03)
        pos_melodia = float(np.clip((altura - bajo) / (alto - bajo), 0, 1)) * (k - 1)

        # Motivo rítmico según el intervalo con el evento anterior.
        if self.historial:
            t_previo, previas = self.historial[-1]
            dt = t - t_previo
            previa = float(np.mean(previas))
        else:
            dt, previa = 10.0, (k - 1) / 2
        paso = a.periodo
        if dt <= paso / 3 + 1e-3:
            repetida = abs(altura - a.valor(a.altura, t - dt + 0.03)) < 0.5
            if repetida and confianza > 0.3:
                ultimo = int(round(previa))
                pos_ritmo = self.trino[1] if ultimo == self.trino[0] else self.trino[0]
            else:
                pos_ritmo = previa + self.direccion
                if pos_ritmo < 0 or pos_ritmo > k - 1:
                    self.direccion *= -1
                    pos_ritmo = previa + self.direccion
            peso_ritmo_extra = 1.0
        elif dt <= paso / 2 + 1e-3:
            pos_ritmo = (k - 1) - previa  # alternar manos
            peso_ritmo_extra = 0.7
        else:
            pos_ritmo = (k - 1) / 2 + self.rng.uniform(-1, 1) * (k - 1) / 2
            peso_ritmo_extra = 0.3

        # Banda dominante: graves a la izquierda, agudos a la derecha.
        total = punto.bajo + punto.alto + 1e-6
        pos_banda = (punto.alto / total) * (k - 1)

        w_mel, w_rit, w_ban = _PESOS_ESTILO[self.o.estilo]
        pesos = np.array([w_mel * confianza, w_rit * peso_ritmo_extra, w_ban])
        # Se sortea una fuente en vez de promediarlas: el promedio tira todo al centro.
        fuente = int(self.rng.choice(3, p=pesos / pesos.sum()))
        return (pos_melodia, pos_ritmo, pos_banda)[fuente]

    # -- costos -------------------------------------------------------------
    def _costo_columna(self, c: int, t: float, preferida: float, peso_distancia: float) -> float:
        if self.fin_hold[c] > t - self.hueco_hold:
            return 1000.0
        costo = abs(c - preferida) * peso_distancia
        dt = t - self.ultimo[c]
        jack = self.p.jack_min
        if dt < jack:
            return 100.0 + costo
        if dt < jack * 1.8:
            costo += 2.0 * (1 - (dt - jack) / (0.8 * jack))
        if self.historial:
            t_previo, previas = self.historial[-1]
            if c in previas and t - t_previo < 2 * self.a.periodo:
                costo += 1.2
        recientes = [col for _, cols in self.historial[-6:] for col in cols]
        costo += 0.4 * recientes.count(c)
        izquierda = sum(1 for col in recientes if col < (self.k - 1) / 2)
        derecha = sum(1 for col in recientes if col > (self.k - 1) / 2)
        if (c < (self.k - 1) / 2 and izquierda > derecha) or (c > (self.k - 1) / 2 and derecha > izquierda):
            costo += 0.15 * abs(izquierda - derecha)
        if self.total_notas > 16:
            exceso = self.uso[c] / self.total_notas - 1.0 / self.k
            costo += max(0.0, exceso) * self.k * 2.0
        if self.k == 7 and c == 3 and self.p.nombre in ("Easy", "Normal"):
            costo += 0.5
        return costo + self.rng.uniform(0, 0.35)

    def _tamano_acorde(self, punto: _Punto, previo: float | None) -> int:
        p = self.p
        if p.acorde_max <= 1 or punto.nivel > 1 or punto.golpe < 0.55:
            return 1
        intensidad = self.a.valor(self.a.intensidad, punto.tiempo)
        seccion = self.a.seccion_en(punto.tiempo)
        probabilidad = p.prob_acorde * (0.5 + intensidad)
        if seccion is not None and seccion.kiai:
            probabilidad *= 1.3
        if punto.bajo > punto.alto:
            probabilidad *= 1.4
        tamano = 1
        while tamano < p.acorde_max and self.rng.random() < probabilidad:
            tamano += 1
            probabilidad *= 0.55
        if previo is not None and punto.tiempo - previo < p.jack_min * 1.2:
            tamano = min(tamano, 2)
        return tamano

    def _elegir_columnas(self, t: float, preferida: float, tamano: int):
        if tamano == 1:
            costos = [self._costo_columna(c, t, preferida, 1.0) for c in range(self.k)]
            c = int(np.argmin(costos))
            return ((c,), costos[c]) if costos[c] < 100 else ((), None)
        individuales = [self._costo_columna(c, t, preferida, 0.5) for c in range(self.k)]
        libres = [c for c in range(self.k) if individuales[c] < 100]
        if len(libres) < tamano:
            return self._elegir_columnas(t, preferida, max(1, len(libres))) if libres else ((), None)
        previas = set(self.historial[-1][1]) if self.historial else set()
        mejor, mejor_costo = None, None
        for combo in combinations(libres, tamano):
            costo = sum(individuales[c] for c in combo)
            costo += abs(np.mean(combo) - preferida) * 0.5
            if set(combo) == previas:
                costo += 1.5
            if mejor_costo is None or costo < mejor_costo:
                mejor, mejor_costo = combo, costo
        return mejor, mejor_costo

    def _liberar_holds(self, t: float):
        for c, nota in list(self.holds_activos.items()):
            if nota.fin <= t:
                del self.holds_activos[c]

    def _recortar_hold(self, t: float) -> bool:
        """Si todas las columnas están ocupadas, acorta el hold que termina antes."""
        if not self.holds_activos:
            return False
        c, nota = min(self.holds_activos.items(), key=lambda par: par[1].fin)
        nuevo_fin = t - max(self.hueco_hold, self.paso_hold)
        if nuevo_fin - nota.tiempo < 0.5 * self.a.periodo:
            nota.fin = None
        else:
            nota.fin = nuevo_fin
        self.fin_hold[c] = nota.fin if nota.fin is not None else nota.tiempo
        del self.holds_activos[c]
        return True

    def _quizas_hold(self, nota: Nota, siguiente: float | None):
        p, a = self.p, self.a
        if len(self.holds_activos) >= self.limite_holds:
            return
        if a.maximo(a.confianza_melodia, nota.tiempo + 0.03, 0.03) < 0.25:
            return
        sostenido = a.sostenido(nota.tiempo)
        minimo = p.hold_min_pulsos * a.periodo
        if sostenido < minimo:
            return
        probabilidad = p.prob_hold * self.o.holds * (1.3 if self.o.estilo == "melodia" else 1.0)
        if self.rng.random() >= probabilidad:
            return
        pasos = np.floor((nota.tiempo + sostenido - a.offset) / self.paso_hold + 1e-6)
        fin = a.offset + pasos * self.paso_hold
        if siguiente is not None and self.p.nombre == "Easy":
            fin = min(fin, siguiente - self.paso_hold)
        fin = min(fin, a.duracion - 0.05)
        if fin - nota.tiempo < minimo - 1e-6:
            return
        nota.fin = fin
        self.fin_hold[nota.columna] = fin
        self.holds_activos[nota.columna] = nota

    def asignar(self, eventos: list) -> list:
        previo = None
        for indice, punto in enumerate(eventos):
            t = punto.tiempo
            self._liberar_holds(t)
            preferida = self._preferencia(punto)
            tamano = self._tamano_acorde(punto, previo)
            columnas, _ = self._elegir_columnas(t, preferida, tamano)
            if not columnas and self._recortar_hold(t):
                columnas, _ = self._elegir_columnas(t, preferida, 1)
            if not columnas:
                continue
            nuevas = [Nota(t, c) for c in columnas]
            for nota in nuevas:
                self.ultimo[nota.columna] = t
                self.uso[nota.columna] += 1
            self.total_notas += len(nuevas)
            self.notas.extend(nuevas)
            self.historial.append((t, tuple(columnas)))
            siguiente = eventos[indice + 1].tiempo if indice + 1 < len(eventos) else None
            self._quizas_hold(nuevas[int(self.rng.integers(len(nuevas)))], siguiente)
            previo = t
        return self.notas


# ---------------------------------------------------------------------------
# Punto de entrada
# ---------------------------------------------------------------------------

def generar_mapa(analisis: Analisis, opciones: OpcionesGeneracion) -> Mapa:
    perfil = obtener_perfil(opciones.dificultad, opciones.teclas)
    puntos = construir_rejilla(analisis, perfil)
    puntuar(analisis, puntos, perfil, opciones.estilo)
    eventos = seleccionar_eventos(analisis, puntos, perfil, opciones.densidad)
    notas = _Asignador(analisis, opciones, perfil).asignar(eventos)
    notas = [n for n in notas if 0 <= n.tiempo < analisis.duracion]
    notas.sort(key=lambda n: (n.tiempo, n.columna))
    divisor = 4 if perfil.divisor >= 4 else 2
    return Mapa(opciones.teclas, opciones.dificultad, perfil, notas, divisor_editor=divisor)
