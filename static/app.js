"use strict";

const $ = (id) => document.getElementById(id);

const COLORES_SECCION = {
  "tranquila": "#4b6b8a",
  "media": "#6a5acd",
  "intensa": "#d0608f",
  "clímax": "#ffb347",
};

// Colores clásicos de skin mania por número de teclas.
const COLORES_COLUMNA = {
  4: ["#e8e8f0", "#66ccff", "#66ccff", "#e8e8f0"],
  7: ["#e8e8f0", "#66ccff", "#e8e8f0", "#ffcc66", "#e8e8f0", "#66ccff", "#e8e8f0"],
};

const estado = {
  archivo: null,
  resultado: null,
  mapa: null,
  animacion: null,
};

// ---------------------------------------------------------------- formulario

const formulario = $("formulario");
const zona = $("zona-audio");
const entradaAudio = $("audio");

function elegirArchivo(archivo) {
  if (!archivo) return;
  estado.archivo = archivo;
  $("url").value = "";
  $("nombre-audio").textContent = archivo.name;
  // "Artista - Título.mp3" rellena los metadatos si están vacíos.
  const base = archivo.name.replace(/\.[^.]+$/, "");
  const partes = base.split(" - ");
  if (partes.length >= 2) {
    if (!$("artista").value) $("artista").value = partes[0].trim();
    if (!$("titulo").value) $("titulo").value = partes.slice(1).join(" - ").trim();
  } else if (!$("titulo").value) {
    $("titulo").value = base;
  }
}

entradaAudio.addEventListener("change", () => elegirArchivo(entradaAudio.files[0]));
$("url").addEventListener("input", () => {
  if (!$("url").value.trim() || !estado.archivo) return;
  // Un enlace reemplaza al archivo elegido.
  estado.archivo = null;
  entradaAudio.value = "";
  $("nombre-audio").textContent = "Arrastra o elige un audio";
});
["dragenter", "dragover"].forEach((ev) => zona.addEventListener(ev, (e) => {
  e.preventDefault();
  zona.classList.add("arrastrando");
}));
["dragleave", "drop"].forEach((ev) => zona.addEventListener(ev, (e) => {
  e.preventDefault();
  zona.classList.remove("arrastrando");
}));
zona.addEventListener("drop", (e) => {
  const archivo = e.dataTransfer.files[0];
  if (!archivo) return;
  const transferencia = new DataTransfer();
  transferencia.items.add(archivo);
  entradaAudio.files = transferencia.files;
  elegirArchivo(archivo);
});

for (const nombre of ["densidad", "holds"]) {
  const control = formulario.elements[nombre];
  const salida = $(`v-${nombre}`);
  control.addEventListener("input", () => { salida.textContent = `${Number(control.value).toFixed(1)}×`; });
}

function valoresMarcados(nombre) {
  return [...formulario.querySelectorAll(`input[name="${nombre}"]:checked`)].map((c) => c.value).join(",");
}

formulario.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("url").value.trim();
  if (!estado.archivo && !url) {
    mostrarEstado("Elige un archivo de audio o pega un enlace de YouTube.", true);
    return;
  }
  const teclas = valoresMarcados("teclas");
  const dificultades = valoresMarcados("dificultades");
  if (!teclas || !dificultades) {
    mostrarEstado("Elige al menos un modo y una dificultad.", true);
    return;
  }
  const datos = new FormData();
  if (estado.archivo) datos.append("audio", estado.archivo);
  else datos.append("url", url);
  datos.append("teclas", teclas);
  datos.append("dificultades", dificultades);
  for (const campo of ["titulo", "artista", "creador", "estilo", "densidad", "holds", "bpm", "offset_ms", "semilla"]) {
    datos.append(campo, formulario.elements[campo].value);
  }

  const boton = $("boton-generar");
  boton.disabled = true;
  mostrarEstado(estado.archivo ? "Analizando la canción y generando mapas…"
    : "Descargando el audio de YouTube, analizando y generando mapas…");
  try {
    const respuesta = await fetch("/api/generar", { method: "POST", body: datos });
    const json = await respuesta.json().catch(() => ({ error: "Respuesta inválida del servidor." }));
    if (!respuesta.ok) throw new Error(json.error || "Error al generar.");
    mostrarEstado(`Listo: ${json.mapas.length} mapas en ${json.tiempo_analisis}s de análisis.`);
    mostrarResultados(json);
  } catch (error) {
    mostrarEstado(error.message, true);
  } finally {
    boton.disabled = false;
  }
});

function mostrarEstado(texto, esError = false) {
  const nodo = $("estado");
  nodo.textContent = texto;
  nodo.classList.toggle("error", esError);
}

// ---------------------------------------------------------------- resultados

function formatoTiempo(segundos) {
  const s = Math.max(0, Math.floor(segundos));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function mostrarResultados(json) {
  estado.resultado = json;
  $("resultados").hidden = false;

  const a = json.analisis;
  const datos = [
    ["BPM", a.bpm],
    ["Offset", `${a.offset_ms} ms`],
    ["Duración", formatoTiempo(a.duracion)],
    ["Onsets", a.onsets],
    ["Secciones", a.secciones.length],
  ];
  $("datos-analisis").innerHTML = datos.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  dibujarLineaTiempo(a);
  $("leyenda-secciones").innerHTML = Object.entries(COLORES_SECCION)
    .map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join("")
    + `<span><i style="background:#ffffff"></i>intensidad</span>`;

  $("descargar-osz").href = json.osz;

  const lista = $("lista-mapas");
  lista.innerHTML = "";
  const selector = $("mapa-vista");
  selector.innerHTML = "";
  for (const mapa of json.mapas) {
    const v = mapa.validacion;
    const e = v.estadisticas;
    const tarjeta = document.createElement("article");
    tarjeta.className = "mapa";
    const errores = v.errores.map((t) => `<li class="invalido">${t}</li>`).join("");
    const avisos = v.advertencias.map((t) => `<li class="aviso">${t}</li>`).join("");
    tarjeta.innerHTML = `
      <h3>${mapa.version} <span class="estrellas">≈${e.estrellas_aprox}★</span></h3>
      <ul>
        <li>${e.notas} notas · ${e.holds} holds</li>
        <li>${e.nps_medio} NPS medio · ${e.nps_max} NPS máx.</li>
        <li>Acordes: ${Object.entries(e.acordes).map(([t, n]) => `${t}→${n}`).join(", ")}</li>
        <li>Patrones (${e.largo_frase} notas por frase): ${Object.entries(e.patrones || {}).slice(0, 4).map(([t, n]) => `${t} ${n}`).join(", ")}</li>
        ${errores}${avisos}
      </ul>
      <span class="${v.valido ? "valido" : "invalido"}">${v.valido ? "✔ Mapa válido" : "✖ Con errores"}</span>
      <div class="acciones">
        <button type="button" data-ver="${mapa.indice}">Previsualizar</button>
        <a class="boton" href="/api/trabajos/${json.id}/osu/${mapa.indice}">.osu</a>
      </div>`;
    lista.appendChild(tarjeta);
    const opcion = document.createElement("option");
    opcion.value = mapa.indice;
    opcion.textContent = mapa.version;
    selector.appendChild(opcion);
  }
  lista.querySelectorAll("[data-ver]").forEach((b) => b.addEventListener("click", () => {
    selector.value = b.dataset.ver;
    elegirMapa(Number(b.dataset.ver));
    $("campo").scrollIntoView({ behavior: "smooth", block: "center" });
  }));

  if (!$("titulo").value) $("titulo").value = json.metadatos.titulo;
  if (!$("artista").value) $("artista").value = json.metadatos.artista;
  reproductor.src = json.audio;
  elegirMapa(json.mapas[0].indice);
}

function ajustarCanvas(canvas) {
  const escala = window.devicePixelRatio || 1;
  const ancho = canvas.clientWidth;
  const alto = canvas.clientHeight;
  if (canvas.width !== Math.round(ancho * escala) || canvas.height !== Math.round(alto * escala)) {
    canvas.width = Math.round(ancho * escala);
    canvas.height = Math.round(alto * escala);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(escala, 0, 0, escala, 0, 0);
  return [ctx, ancho, alto];
}

function dibujarLineaTiempo(a) {
  const [ctx, ancho, alto] = ajustarCanvas($("linea-tiempo"));
  ctx.clearRect(0, 0, ancho, alto);
  for (const s of a.secciones) {
    const x0 = (s.inicio / a.duracion) * ancho;
    const x1 = (s.fin / a.duracion) * ancho;
    ctx.fillStyle = COLORES_SECCION[s.etiqueta] || "#555";
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x0, 0, x1 - x0 - 1, alto);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  a.intensidad.forEach((v, i) => {
    const x = (i / (a.intensidad.length - 1)) * ancho;
    const y = alto - v * (alto - 8) - 4;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ---------------------------------------------------------------- previsualización

const reproductor = $("reproductor");
const campo = $("campo");

$("mapa-vista").addEventListener("change", (e) => elegirMapa(Number(e.target.value)));

function elegirMapa(indice) {
  estado.mapa = estado.resultado.mapas.find((m) => m.indice === indice);
  dibujarDensidad();
  dibujarCampo();
}

function dibujarDensidad() {
  const canvas = $("densidad-mapa");
  const [ctx, ancho, alto] = ajustarCanvas(canvas);
  ctx.clearRect(0, 0, ancho, alto);
  const duracion = estado.resultado.analisis.duracion * 1000;
  const columnas = Math.max(1, Math.floor(ancho / 3));
  const conteo = new Array(columnas).fill(0);
  for (const [t] of estado.mapa.notas) {
    conteo[Math.min(columnas - 1, Math.floor((t / duracion) * columnas))] += 1;
  }
  const maximo = Math.max(1, ...conteo);
  ctx.fillStyle = "#ff66aa";
  conteo.forEach((c, i) => {
    const h = (c / maximo) * (alto - 4);
    ctx.fillRect(i * 3, alto - h, 2, h);
  });
  const x = (reproductor.currentTime * 1000 / duracion) * ancho;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, 0, 2, alto);
}

$("densidad-mapa").addEventListener("click", (e) => {
  if (!estado.resultado) return;
  const rect = e.currentTarget.getBoundingClientRect();
  reproductor.currentTime = ((e.clientX - rect.left) / rect.width) * estado.resultado.analisis.duracion;
  dibujarCampo();
  dibujarDensidad();
});

function dibujarCampo() {
  if (!estado.mapa) return;
  const [ctx, ancho, alto] = ajustarCanvas(campo);
  const k = estado.mapa.teclas;
  const ahora = reproductor.currentTime * 1000;
  const velocidad = Number($("velocidad").value) / 40; // píxeles por ms
  const lineaJuicio = alto - 60;
  const anchoColumna = Math.min(70, (ancho - 20) / k);
  const izquierda = (ancho - anchoColumna * k) / 2;
  const colores = COLORES_COLUMNA[k];
  const visibleMs = lineaJuicio / velocidad;

  ctx.fillStyle = "#0e0d14";
  ctx.fillRect(0, 0, ancho, alto);
  for (let c = 0; c < k; c++) {
    ctx.fillStyle = c % 2 ? "#15131d" : "#191723";
    ctx.fillRect(izquierda + c * anchoColumna, 0, anchoColumna, alto);
  }

  // Líneas de compás.
  const a = estado.resultado.analisis;
  const compasMs = (60000 / a.bpm) * a.compas;
  ctx.strokeStyle = "#ffffff22";
  ctx.lineWidth = 1;
  let primero = a.offset_ms + Math.ceil((ahora - a.offset_ms) / compasMs) * compasMs;
  for (let t = primero; t < ahora + visibleMs; t += compasMs) {
    const y = lineaJuicio - (t - ahora) * velocidad;
    ctx.beginPath();
    ctx.moveTo(izquierda, y);
    ctx.lineTo(izquierda + anchoColumna * k, y);
    ctx.stroke();
  }

  const pulsadas = new Array(k).fill(false);
  const altoNota = 14;
  for (const [t, c, fin] of estado.mapa.notas) {
    const final = fin > 0 ? fin : t;
    if (final < ahora - 200) continue;
    if (t > ahora + visibleMs) break;
    const x = izquierda + c * anchoColumna + 3;
    const w = anchoColumna - 6;
    const y = lineaJuicio - (t - ahora) * velocidad;
    ctx.fillStyle = colores[c];
    if (fin > 0) {
      const yFin = lineaJuicio - (fin - ahora) * velocidad;
      const yInicio = Math.min(y, lineaJuicio);
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x + w * 0.15, yFin, w * 0.7, yInicio - yFin);
      ctx.globalAlpha = 1;
      if (t <= ahora && fin >= ahora) pulsadas[c] = true;
      if (t > ahora) ctx.fillRect(x, y - altoNota, w, altoNota);
    } else if (t >= ahora - 30) {
      ctx.fillRect(x, y - altoNota, w, altoNota);
    }
    if (Math.abs(t - ahora) < 60) pulsadas[c] = true;
  }

  // Línea de juicio y teclas.
  ctx.fillStyle = "#ff66aa";
  ctx.fillRect(izquierda, lineaJuicio, anchoColumna * k, 3);
  for (let c = 0; c < k; c++) {
    ctx.fillStyle = pulsadas[c] ? colores[c] : "#2a2639";
    ctx.fillRect(izquierda + c * anchoColumna + 4, lineaJuicio + 12, anchoColumna - 8, 36);
  }

  const duracion = a.duracion;
  $("reloj").textContent = `${formatoTiempo(reproductor.currentTime)} / ${formatoTiempo(duracion)}`;
  $("posicion").value = Math.round((reproductor.currentTime / duracion) * 1000);
}

function bucle() {
  dibujarCampo();
  dibujarDensidad();
  if (!reproductor.paused) estado.animacion = requestAnimationFrame(bucle);
}

function alternarReproduccion() {
  if (!estado.mapa) return;
  if (reproductor.paused) reproductor.play(); else reproductor.pause();
}

$("reproducir").addEventListener("click", alternarReproduccion);
reproductor.addEventListener("play", () => {
  $("reproducir").textContent = "❚❚ Pausar";
  cancelAnimationFrame(estado.animacion);
  estado.animacion = requestAnimationFrame(bucle);
});
reproductor.addEventListener("pause", () => { $("reproducir").textContent = "▶ Reproducir"; });
$("posicion").addEventListener("input", (e) => {
  if (!estado.resultado) return;
  reproductor.currentTime = (Number(e.target.value) / 1000) * estado.resultado.analisis.duracion;
  dibujarCampo();
  dibujarDensidad();
});
$("velocidad").addEventListener("input", dibujarCampo);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(document.activeElement.tagName)) {
    e.preventDefault();
    alternarReproduccion();
  }
});
window.addEventListener("resize", () => {
  if (!estado.resultado) return;
  dibujarLineaTiempo(estado.resultado.analisis);
  dibujarDensidad();
  dibujarCampo();
});
