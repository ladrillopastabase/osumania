"""Parámetros de cada dificultad para 4K y 7K."""

from dataclasses import dataclass, replace


@dataclass(frozen=True)
class PerfilDificultad:
    nombre: str
    divisor: int            # subdivisión máxima del pulso (2 = corcheas, 4 = semicorcheas)
    tresillos: bool         # permite rejilla 1/3 donde la música lo pide
    nps: float              # notas por segundo objetivo en una sección de intensidad media
    acorde_max: int         # notas simultáneas máximas
    prob_acorde: float      # probabilidad base de convertir un golpe fuerte en acorde
    prob_hold: float        # probabilidad base de convertir una nota sostenida en hold
    hold_min_pulsos: float  # duración mínima de un hold, en pulsos
    separacion_min: float   # tiempo mínimo entre eventos consecutivos (s)
    jack_min: float         # tiempo mínimo entre dos notas en la misma columna (s)
    peso_metrico: float     # cuánto se privilegian los tiempos fuertes frente a los onsets
    od: float
    hp: float


_BASE = {
    "Easy": PerfilDificultad("Easy", 2, False, 1.6, 1, 0.05, 0.30, 1.0, 0.24, 0.45, 2.0, 5.0, 6.0),
    "Normal": PerfilDificultad("Normal", 2, False, 3.0, 2, 0.15, 0.26, 1.0, 0.13, 0.28, 1.4, 6.5, 7.0),
    "Hard": PerfilDificultad("Hard", 4, True, 5.2, 2, 0.25, 0.30, 0.75, 0.075, 0.17, 1.0, 7.5, 7.5),
    "Insane": PerfilDificultad("Insane", 4, True, 7.8, 3, 0.35, 0.26, 0.5, 0.05, 0.11, 0.8, 8.3, 8.0),
}

# En 7K hay más columnas: más acordes y algo más de densidad por la misma dificultad.
_AJUSTE_7K = {
    "Easy": dict(acorde_max=2, prob_acorde=0.10, nps=1.8),
    "Normal": dict(acorde_max=3, prob_acorde=0.22, nps=3.4),
    "Hard": dict(acorde_max=4, prob_acorde=0.32, nps=6.0),
    "Insane": dict(acorde_max=5, prob_acorde=0.42, nps=9.0),
}

NOMBRES = list(_BASE)


def perfil(nombre: str, teclas: int) -> PerfilDificultad:
    if nombre not in _BASE:
        raise ValueError(f"Dificultad desconocida: {nombre}")
    base = _BASE[nombre]
    if teclas >= 7:
        return replace(base, **_AJUSTE_7K[nombre])
    return base
