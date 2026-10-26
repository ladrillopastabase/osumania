// Interfaz: todo ocurre en el navegador. El análisis y la generación corren en
// un trabajador (js/trabajador.js); el audio se decodifica y se codifica a MP3 aquí.

import { canalesTramo, codificarMp3, decodificar, FRECUENCIA_ANALISIS, imagenAJpeg, leerEtiquetas, senalAnalisis }
  from "./audio.js";
import { descargarDeYoutube, buscarAyudante, esUrlYoutube, guardarServidor, servidorGuardado } from "./youtube.js";
import { crearZip } from "./zip.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- constantes

const CAPAS = ["bombo", "caja", "platillos", "bajo", "melodia"];
const NOMBRES_CAPA = {
  bombo: "Bombo", caja: "Caja", platillos: "Platillos", bajo: "Bajo", melodia: "Melodía / voz",
};
const DEFECTO_CAPAS = [100, 90, 50, 60, 100];
const PREAJUSTES = {
  equilibrado: { nombre: "Equilibrado", valores: DEFECTO_CAPAS },
  bateria: { nombre: "Batería", valores: [100, 100, 80, 20, 20] },
  melodia: { nombre: "Melodía / voz", valores: [30, 25, 10, 40, 100] },
  bajo: { nombre: "Bajo", valores: [50, 40, 10, 100, 40] },
  todo: { nombre: "Todo", valores: [100, 100, 100, 100, 100] },
};
// Opciones por sección: además de los preajustes, heredar lo global, silenciar o personalizar.
const OPCIONES_SECCION = [
  ["global", "Como toda la canción"],
  ...Object.entries(PREAJUSTES).map(([clave, p]) => [clave, p.nombre]),
  ["silencio", "Sin notas"],
  ["personalizado", "Personalizado…"],
];
const NOMBRE_ETIQUETA = { "tranquila": "Tranquila", "media": "Media", "intensa": "Intensa", "clímax": "Clímax" };
const VARIABLE_ETIQUETA = { "tranquila": "--s-tranquila", "media": "--s-media", "intensa": "--s-intensa", "clímax": "--s-climax" };

// Colores clásicos de skin mania (el campo de juego es oscuro en ambos temas):
// blanco y azul alternados desde los bordes, y amarillo en la columna central.
// De 12K a 18K hay dos escenarios, cada uno con sus colores.
function coloresColumnas(k) {
  const escenario = k > 10 ? k / 2 : k;
  return Array.from({ length: k }, (_, c) => {
    const i = c % escenario;
    if (escenario % 2 === 1 && i === (escenario - 1) / 2 && escenario > 1) return "#ffcc66";
    return Math.min(i, escenario - 1 - i) % 2 ? "#66ccff" : "#e8e8f0";
  });
}

const estado = {
  archivo: null,
  cancion: null,       // {bytes, buffer, senal, extension, nombre} de la canción analizada
  claveAnalisis: null, // BPM y offset forzados con los que se analizó
  fondoJpg: null,      // imagen de fondo ya convertida a JPG (Blob)
  fondoUrl: null,
  audioSalida: null,   // {clave, nombre, bytes, url}: el audio del .osz y de la vista previa
  descargas: [],       // URLs de la última generación (se liberan al regenerar)
  trabajo: null,       // canción ya cargada y analizada
  fuenteNueva: false,  // el usuario eligió otra canción desde la última carga
  resultado: null,     // última generación
  mapa: null,
  animacion: null,
  fondo: null,
  recorte: null,       // {inicio, fin} en segundos de la canción completa, o null
  secciones: [],       // por sección: {opcion, valores}
  arrastre: null,      // "inicio" | "fin" mientras se arrastra un borde del recorte
  sucio: false,        // hay ajustes cambiados desde la última generación
};

// ---------------------------------------------------------------- utilidades

function css(variable) {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

function conAlfa(color, alfa) {
  const hex = color.replace("#", "");
  const n = parseInt(hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}

function formatoTiempo(segundos, decimas = false) {
  const s = Math.max(0, segundos);
  const minutos = Math.floor(s / 60);
  const resto = s - minutos * 60;
  const texto = decimas ? resto.toFixed(1).padStart(4, "0") : String(Math.floor(resto)).padStart(2, "0");
  return `${minutos}:${texto}`;
}

function leerTiempo(texto) {
  const limpio = String(texto).trim().replace(",", ".");
  if (!limpio) return NaN;
  if (limpio.includes(":")) {
    const [m, s] = limpio.split(":");
    return Number(m) * 60 + Number(s);
  }
  return Number(limpio);
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

function mostrarEstado(texto, esError = false) {
  const nodo = $("estado");
  nodo.textContent = texto;
  nodo.classList.toggle("error", esError);
}

/** Barra de progreso de la barra de acción (null la oculta). */
function mostrarProgreso(fraccion) {
  const barra = $("progreso");
  barra.hidden = fraccion === null;
  if (fraccion !== null) barra.value = Math.min(1, Math.max(0, fraccion));
}

// Espera a que el navegador pinte el estado antes de un trabajo pesado en este hilo.
const pintar = () => new Promise((resolver) => requestAnimationFrame(() => setTimeout(resolver, 0)));

// ---------------------------------------------------------------- tema

const TEMAS = [["auto", "☀☾", "Auto"], ["claro", "☀", "Claro"], ["oscuro", "☾", "Oscuro"]];

function temaGuardado() {
  try { return localStorage.getItem("tema") || "auto"; } catch (e) { return "auto"; }
}

function aplicarTema(tema) {
  const raiz = document.documentElement;
  if (tema === "claro") raiz.dataset.theme = "light";
  else if (tema === "oscuro") raiz.dataset.theme = "dark";
  else delete raiz.dataset.theme;
  const [, icono, nombre] = TEMAS.find(([clave]) => clave === tema) || TEMAS[0];
  $("tema-icono").textContent = icono;
  $("tema-nombre").textContent = nombre;
  try { localStorage.setItem("tema", tema); } catch (e) { /* sin almacenamiento */ }
  redibujarTodo();
}

$("tema").addEventListener("click", () => {
  const actual = temaGuardado();
  const indice = TEMAS.findIndex(([clave]) => clave === actual);
  aplicarTema(TEMAS[(indice + 1) % TEMAS.length][0]);
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => redibujarTodo());

// ---------------------------------------------------------------- controles de capas

function crearDeslizadorCapa(contenedor, capa, valor, alCambiar, nombreInput) {
  const fila = document.createElement("label");
  fila.className = "deslizador capa-fila";
  fila.innerHTML = `<span><i class="punto" style="background:var(--c-${capa})"></i>${NOMBRES_CAPA[capa]}</span>
    <input type="range" min="0" max="100" step="5" value="${valor}"${nombreInput ? ` name="${nombreInput}"` : ""}>
    <output>${valor}%</output>`;
  const entrada = fila.querySelector("input");
  entrada.addEventListener("input", () => {
    fila.querySelector("output").textContent = `${entrada.value}%`;
    alCambiar?.();
  });
  contenedor.appendChild(fila);
  return entrada;
}

const formulario = $("formulario");
const entradasGlobales = CAPAS.map((capa, i) =>
  crearDeslizadorCapa($("controles-globales"), capa, DEFECTO_CAPAS[i], marcarPreajusteGlobal, `capa_${capa}`));

function valoresGlobales() {
  return entradasGlobales.map((e) => Number(e.value));
}

function fijarGlobales(valores) {
  entradasGlobales.forEach((entrada, i) => {
    entrada.value = valores[i];
    entrada.closest("label").querySelector("output").textContent = `${valores[i]}%`;
  });
  marcarPreajusteGlobal();
}

for (const [clave, preajuste] of Object.entries(PREAJUSTES)) {
  const boton = document.createElement("button");
  boton.type = "button";
  boton.className = "ficha";
  boton.dataset.preajuste = clave;
  boton.textContent = preajuste.nombre;
  boton.addEventListener("click", () => fijarGlobales(preajuste.valores));
  $("preajustes-globales").appendChild(boton);
}

function marcarPreajusteGlobal() {
  const actual = valoresGlobales().join(",");
  document.querySelectorAll("#preajustes-globales [data-preajuste]").forEach((b) => {
    b.classList.toggle("activa", PREAJUSTES[b.dataset.preajuste].valores.join(",") === actual);
  });
}
marcarPreajusteGlobal();

for (const nombre of ["densidad", "holds"]) {
  const control = formulario.elements[nombre];
  const salida = $(`v-${nombre}`);
  control.addEventListener("input", () => { salida.textContent = `${Number(control.value).toFixed(1)}×`; });
}

// ---------------------------------------------------------------- fuente de audio

const zona = $("zona-audio");
const entradaAudio = $("audio");

function elegirArchivo(archivo) {
  if (!archivo) return;
  estado.archivo = archivo;
  estado.fuenteNueva = true;
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
  if (!$("url").value.trim()) return;
  estado.fuenteNueva = true;
  if (estado.archivo) {
    estado.archivo = null;
    entradaAudio.value = "";
    $("nombre-audio").textContent = "Arrastra o elige un audio";
  }
});
// Al pegar un enlace se busca el ayudante, para avisar antes de analizar si falta.
$("url").addEventListener("change", () => {
  if (esUrlYoutube($("url").value)) comprobarAyudante();
});

// ---------------------------------------------------------------- ayudante de YouTube

function mostrarAyudante(texto, clase = "") {
  const nodo = $("estado-ayudante");
  nodo.textContent = texto;
  nodo.className = `ayudante-estado ${clase}`;
}

async function comprobarAyudante() {
  mostrarAyudante("Buscando el ayudante de YouTube…");
  const ayudante = await buscarAyudante((base) => mostrarAyudante(`Buscando el ayudante en ${base}…`));
  if (ayudante) {
    const sinJs = ayudante.js.length ? "" : " (sin Deno/Node: YouTube podría fallar)";
    mostrarAyudante(`✔ Ayudante conectado (yt-dlp ${ayudante.version})${sinJs}.`, "listo");
  } else {
    mostrarAyudante("✖ No se encontró el ayudante. Ábrelo en tu computador (ver abajo) o sube el audio.", "error");
    $("ayudante").open = true;
  }
  return ayudante;
}

$("probar-ayudante").addEventListener("click", comprobarAyudante);
$("servidor-youtube").value = servidorGuardado();
$("servidor-youtube").addEventListener("change", () => {
  const valor = $("servidor-youtube").value.trim();
  guardarServidor(valor);
  if (valor) comprobarAyudante();
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

$("otra-cancion").addEventListener("click", () => {
  estado.trabajo = null;
  estado.resultado = null;
  estado.archivo = null;
  estado.recorte = null;
  estado.secciones = [];
  estado.mapa = null;
  estado.sucio = false;
  estado.cancion = null;
  estado.audioSalida = null;
  fijarFondo(null);
  entradaAudio.value = "";
  $("url").value = "";
  $("imagen").value = "";
  $("titulo").value = "";
  $("artista").value = "";
  $("nombre-audio").textContent = "Arrastra o elige un audio";
  $("cancion-cargada").hidden = true;
  $("fuente").hidden = false;
  $("paso-resultados").hidden = true;
  reproductor.pause();
  for (const id of ["paso-estructura", "paso-instrumentos", "paso-mapas"]) $(id).classList.add("bloqueada");
  mostrarEstado("Elige una canción para empezar.");
  actualizarAccion();
});

function usarTrabajo(json) {
  const nuevo = !estado.trabajo || estado.trabajo.id !== json.id;
  const seccionesCambiaron = !estado.trabajo
    || JSON.stringify(estado.trabajo.analisis.secciones) !== JSON.stringify(json.analisis.secciones);
  estado.trabajo = json;
  estado.fuenteNueva = false;
  if (nuevo) estado.recorte = null;
  if (nuevo || seccionesCambiaron) {
    estado.secciones = json.analisis.secciones.map(() => ({ opcion: "global", valores: valoresGlobales() }));
  }
  $("cancion-cargada").hidden = false;
  $("fuente").hidden = true;
  for (const id of ["paso-estructura", "paso-instrumentos", "paso-mapas"]) $(id).classList.remove("bloqueada");

  const a = json.analisis;
  const datos = [
    ["BPM", a.bpm],
    ["Offset", `${a.offset_ms} ms`],
    ["Duración", formatoTiempo(a.duracion)],
    ["Secciones", a.secciones.length],
  ];
  $("datos-analisis").innerHTML = datos.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  $("leyenda-secciones").innerHTML = Object.entries(VARIABLE_ETIQUETA)
    .map(([k, v]) => `<span><i style="background:var(${v})"></i>${NOMBRE_ETIQUETA[k]}</span>`).join("")
    + `<span><i style="background:var(--texto)"></i>Intensidad</span>`;

  mostrarFondo(json.fondo);

  actualizarCamposRecorte();
  dibujarLineaTiempo();
  renderizarSecciones();
  dibujarCapas();
  actualizarAccion();
}

// ---------------------------------------------------------------- acción y cambios sin aplicar

function actualizarAccion() {
  const boton = $("boton-accion");
  const necesitaAnalisis = !estado.trabajo || estado.fuenteNueva;
  boton.classList.remove("atenuado");
  if (necesitaAnalisis) {
    boton.textContent = "Analizar canción";
  } else if (!estado.resultado) {
    boton.textContent = "Generar mapas";
  } else {
    boton.textContent = estado.sucio ? "Aplicar cambios y regenerar" : "Regenerar";
    boton.classList.toggle("atenuado", !estado.sucio);
  }
  $("cambios").hidden = !(estado.resultado && estado.sucio && !necesitaAnalisis);
  // Navegación de pasos: listos, pendientes o inactivos.
  const hecho = { cancion: !!estado.trabajo, estructura: !!estado.trabajo, instrumentos: !!estado.trabajo,
    mapas: !!estado.trabajo, resultados: !!estado.resultado };
  document.querySelectorAll(".pasos a").forEach((a) => {
    a.classList.toggle("listo", hecho[a.dataset.paso]);
    a.classList.toggle("inactivo", a.dataset.paso !== "cancion" && !estado.trabajo);
  });
}

function marcarCambios() {
  if (!estado.resultado) return;
  estado.sucio = true;
  actualizarAccion();
}

// Controles que no cambian el mapa (fuente de audio, ayudante y vista previa).
const FUERA_DE_AJUSTES = ["audio", "url", "servidor-youtube", "mapa-vista", "velocidad", "posicion"];
// Cualquier cambio de ajustes después de generar queda "sin aplicar" hasta regenerar.
formulario.addEventListener("input", (e) => {
  if (FUERA_DE_AJUSTES.includes(e.target.id)) { actualizarAccion(); return; }
  marcarCambios();
});
formulario.addEventListener("change", (e) => {
  if (FUERA_DE_AJUSTES.includes(e.target.id)) { actualizarAccion(); return; }
  marcarCambios();
});

// ---------------------------------------------------------------- fondo

function fijarFondo(jpg) {
  if (estado.fondoUrl) URL.revokeObjectURL(estado.fondoUrl);
  estado.fondoJpg = jpg;
  estado.fondoUrl = jpg ? URL.createObjectURL(jpg) : null;
  if (estado.trabajo) {
    estado.trabajo.fondo = estado.fondoUrl;
    mostrarFondo(estado.fondoUrl);
  }
}

function mostrarFondo(url) {
  const miniatura = $("miniatura");
  miniatura.hidden = !url;
  if (!url) {
    estado.fondo = null;
    delete miniatura.dataset.fuente;
    dibujarCampo();
    return;
  }
  if (miniatura.dataset.fuente === url) return;
  miniatura.dataset.fuente = url;
  miniatura.src = url;
  const imagenFondo = new Image();
  imagenFondo.onload = () => { estado.fondo = imagenFondo; dibujarCampo(); };
  imagenFondo.src = url;
}

$("imagen").addEventListener("change", async () => {
  const archivo = $("imagen").files[0];
  if (!archivo) return;
  const jpg = await imagenAJpeg(archivo);
  if (!jpg) {
    mostrarEstado("No se pudo leer la imagen. Usa JPG, PNG o WEBP.", true);
    return;
  }
  fijarFondo(jpg);
  marcarCambios();
});

// ---------------------------------------------------------------- envío

// El motor corre en un trabajador; cada pedido espera su respuesta por id.
const motor = new Worker(new URL("./trabajador.js", import.meta.url), { type: "module" });
const pendientes = new Map();
let siguienteId = 0;

motor.onmessage = (e) => {
  const pedido = pendientes.get(e.data.id);
  if (!pedido) return;
  if (e.data.tipo === "progreso") {
    pedido.alAvanzar?.(e.data.fraccion, e.data.etapa);
    return;
  }
  pendientes.delete(e.data.id);
  if (e.data.tipo === "listo") pedido.resolver(e.data.resultado);
  else pedido.rechazar(new Error(e.data.mensaje));
};
motor.onerror = (e) => {
  for (const pedido of pendientes.values()) pedido.rechazar(new Error(`Falló el motor: ${e.message || "error desconocido"}`));
  pendientes.clear();
};

function pedir(tipo, datos, alAvanzar = null) {
  return new Promise((resolver, rechazar) => {
    const id = ++siguienteId;
    pendientes.set(id, { resolver, rechazar, alAvanzar });
    motor.postMessage({ id, tipo, ...datos });
  });
}

function numeroCampo(nombre) {
  const valor = formulario.elements[nombre].value.trim().replace(",", ".");
  if (!valor) return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero)) throw new Error(`Valor inválido para ${nombre}.`);
  return numero;
}

function bpmYOffset() {
  const bpm = numeroCampo("bpm");
  if (bpm !== null && !(bpm >= 30 && bpm <= 400)) throw new Error("El BPM debe estar entre 30 y 400.");
  return { bpm, offsetMs: numeroCampo("offset_ms") };
}

/** Analiza (o vuelve a analizar con otro BPM/offset) la señal ya decodificada. */
async function pedirAnalisis(forzado) {
  const resultado = await pedir("analizar", { senal: estado.cancion.senal, sr: FRECUENCIA_ANALISIS, ...forzado },
    (fraccion, etapa) => {
      mostrarProgreso(fraccion);
      mostrarEstado(`Analizando: ${etapa.toLowerCase()}…`);
    });
  estado.claveAnalisis = JSON.stringify(forzado);
  return resultado;
}

function valoresMarcados(nombre) {
  return [...formulario.querySelectorAll(`input[name="${nombre}"]:checked`)].map((c) => c.value).join(",");
}

function valoresDeSeccion(ajuste) {
  if (ajuste.opcion === "global") return null;
  if (ajuste.opcion === "silencio") return CAPAS.map(() => 0);
  if (ajuste.opcion === "personalizado") return ajuste.valores;
  return PREAJUSTES[ajuste.opcion].valores;
}

function ajustesPorSeccion() {
  if (!estado.trabajo) return [];
  return estado.trabajo.analisis.secciones.flatMap((s, i) => {
    const valores = estado.secciones[i] ? valoresDeSeccion(estado.secciones[i]) : null;
    if (!valores) return [];
    return [{ inicio: s.inicio, fin: s.fin, capas: Object.fromEntries(CAPAS.map((c, j) => [c, valores[j] / 100])) }];
  });
}

/** Baja el audio del enlace con el ayudante; completa título, artista y miniatura. */
async function bajarDeYoutube(url) {
  const descarga = await descargarDeYoutube(url, (etapa, fraccion) => {
    if (etapa === "buscando") mostrarEstado("Buscando el ayudante de YouTube…");
    else if (etapa === "descargando") mostrarEstado("Descargando el audio de YouTube (puede tardar unos segundos)…");
    else mostrarEstado("Recibiendo el audio…");
    mostrarProgreso(fraccion ?? 0);
  });
  mostrarAyudante("✔ Ayudante conectado.", "listo");
  if (descarga.titulo && !$("titulo").value) $("titulo").value = descarga.titulo;
  if (descarga.artista && (!$("artista").value || $("artista").value === "Desconocido")) $("artista").value = descarga.artista;
  return descarga;
}

async function analizar() {
  const url = $("url").value.trim();
  if (!estado.archivo && !url) {
    mostrarEstado("Elige un archivo de audio o pega un enlace de YouTube.", true);
    return;
  }
  if (!estado.archivo && !esUrlYoutube(url)) {
    mostrarEstado("El enlace no es de YouTube.", true);
    return;
  }
  const forzado = bpmYOffset();
  let archivo = estado.archivo;
  let miniatura = null;
  mostrarProgreso(0);
  if (!archivo) {
    ({ archivo, miniatura } = await bajarDeYoutube(url));
  }
  mostrarEstado("Leyendo el audio…");
  mostrarProgreso(0);
  await pintar();
  const bytes = await archivo.arrayBuffer();
  const buffer = await decodificar(bytes);
  mostrarEstado("Preparando la señal…");
  await pintar();
  const senal = await senalAnalisis(buffer);
  const extension = (archivo.name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
  estado.cancion = { bytes: new Uint8Array(bytes), buffer, senal, extension, nombre: archivo.name,
    fuente: estado.archivo ? "" : url };
  estado.audioSalida = null;

  // Título, artista y carátula incrustados (MP3/FLAC) completan lo que falte.
  const etiquetas = leerEtiquetas(bytes);
  const base = archivo.name.replace(/\.[^.]+$/, "");
  if (etiquetas.titulo && (!$("titulo").value || $("titulo").value === base
      || base.endsWith($("titulo").value))) $("titulo").value = etiquetas.titulo;
  if (etiquetas.artista && (!$("artista").value || $("artista").value === "Desconocido"
      || base.startsWith($("artista").value))) $("artista").value = etiquetas.artista;
  if (!$("artista").value) $("artista").value = "Desconocido";
  // Fondo: la imagen elegida a mano; si no, la miniatura del video o la carátula.
  if (!$("imagen").files[0]) {
    const origen = miniatura
      || (etiquetas.portada ? new Blob([etiquetas.portada.datos], { type: etiquetas.portada.tipo }) : null);
    fijarFondo(origen ? await imagenAJpeg(origen) : null);
  }

  const resultado = await pedirAnalisis(forzado);
  estado.resultado = null;
  estado.sucio = false;
  estado.trabajo = null;
  $("paso-resultados").hidden = true;
  usarTrabajo({ id: siguienteId, ...resultado, fondo: estado.fondoUrl,
    metadatos: { titulo: $("titulo").value, artista: $("artista").value } });
  mostrarProgreso(null);
  mostrarEstado(`Canción analizada en ${resultado.tiempo_analisis} s. Revisa el recorte, los instrumentos y los mapas, y genera.`);
  $("paso-estructura").scrollIntoView({ behavior: "smooth", block: "start" });
}

/** El audio del .osz: el original si osu! lo reproduce tal cual; si no, MP3 (recortado o completo). */
async function prepararAudio(recorte, fundido) {
  const c = estado.cancion;
  const original = !recorte && ["mp3", "ogg"].includes(c.extension);
  const clave = original ? "original" : JSON.stringify(recorte ? [recorte.inicio, recorte.fin, fundido] : "completo");
  if (estado.audioSalida && estado.audioSalida.clave === clave) return estado.audioSalida;
  let bytes, nombre, tipo;
  if (original) {
    bytes = c.bytes;
    nombre = `audio.${c.extension}`;
    tipo = c.extension === "ogg" ? "audio/ogg" : "audio/mpeg";
  } else {
    mostrarEstado("Codificando el audio a MP3…");
    mostrarProgreso(0);
    const canales = recorte ? canalesTramo(c.buffer, recorte.inicio, recorte.fin, fundido) : canalesTramo(c.buffer);
    bytes = await codificarMp3(canales, c.buffer.sampleRate, (f) => mostrarProgreso(f));
    nombre = "audio.mp3";
    tipo = "audio/mpeg";
  }
  if (estado.audioSalida) URL.revokeObjectURL(estado.audioSalida.url);
  estado.audioSalida = { clave, nombre, bytes, url: URL.createObjectURL(new Blob([bytes], { type: tipo })) };
  return estado.audioSalida;
}

async function generar() {
  const porSeccion = ajustesPorSeccion();
  if (valoresGlobales().every((v) => v === 0) && !porSeccion.some((s) => Object.values(s.capas).some((v) => v > 0))) {
    mostrarEstado("Al menos un instrumento tiene que tener influencia.", true);
    return;
  }
  const teclas = valoresMarcados("teclas");
  const dificultades = valoresMarcados("dificultades");
  if (!teclas || !dificultades) {
    mostrarEstado("Elige al menos un modo y una dificultad (paso 4).", true);
    return;
  }
  // Un BPM u offset manual nuevo obliga a rehacer el análisis.
  const forzado = bpmYOffset();
  if (JSON.stringify(forzado) !== estado.claveAnalisis) {
    mostrarProgreso(0);
    const resultado = await pedirAnalisis(forzado);
    usarTrabajo({ ...estado.trabajo, ...resultado });
  }
  const titulo = $("titulo").value.trim() || estado.trabajo.metadatos.titulo || "Sin título";
  const artista = $("artista").value.trim() || estado.trabajo.metadatos.artista || "Desconocido";
  const recorte = recorteVigente();
  const fundido = Number($("fundido").value);
  // El nombre del audio depende de si se recorta; se decide antes de exportar.
  const original = !recorte && ["mp3", "ogg"].includes(estado.cancion.extension);
  const parametros = {
    teclas: teclas.split(",").map(Number),
    dificultades: dificultades.split(","),
    percusion: 0.5,
    melodia: 0.5,
    densidad: Number(formulario.elements.densidad.value),
    holds: Number(formulario.elements.holds.value),
    semilla: numeroCampo("semilla") ?? 0,
    capas: Object.fromEntries(CAPAS.map((capa, i) => [capa, valoresGlobales()[i] / 100])),
    capasSecciones: porSeccion,
    recorte: recorte ? { inicio: recorte.inicio, fin: recorte.fin, ajustarCompas: $("recorte-compas").checked } : null,
    fundido,
    meta: { titulo, artista, creador: formulario.elements.creador.value.trim() || "Generador osu!mania",
      fuente: estado.cancion.fuente, etiquetas: "generado automatico" },
    audio: original ? `audio.${estado.cancion.extension}` : "audio.mp3",
    fondo: estado.fondoJpg ? "fondo.jpg" : null,
  };
  mostrarEstado("Generando mapas…");
  mostrarProgreso(0);
  const primeraVez = !estado.resultado;
  const json = await pedir("generar", { parametros }, (fraccion, etapa) => {
    mostrarProgreso(fraccion);
    mostrarEstado(`${etapa}…`);
  });
  if (json.recorte) estado.recorte = { inicio: json.recorte.inicio, fin: json.recorte.fin };
  const audio = await prepararAudio(json.recorte, fundido);

  mostrarEstado("Empaquetando el .osz…");
  await pintar();
  for (const url of estado.descargas) URL.revokeObjectURL(url);
  estado.descargas = [];
  const archivos = [{ nombre: audio.nombre, datos: audio.bytes }];
  if (estado.fondoJpg) archivos.push({ nombre: "fondo.jpg", datos: new Uint8Array(await estado.fondoJpg.arrayBuffer()) });
  json.archivos.forEach((a, i) => {
    archivos.push(a);
    json.mapas[i].url = URL.createObjectURL(new Blob([a.datos], { type: "text/plain" }));
    estado.descargas.push(json.mapas[i].url);
  });
  const osz = URL.createObjectURL(crearZip(archivos));
  estado.descargas.push(osz);

  estado.sucio = false;
  usarTrabajo({ ...estado.trabajo, analisis: json.analisis, metadatos: { titulo, artista } });
  mostrarResultados({ ...json, id: estado.trabajo.id, osz, oszNombre: json.osz, audio: audio.url,
    metadatos: { titulo, artista } });
  mostrarProgreso(null);
  const extra = json.recorte ? ` · tramo ${formatoTiempo(json.recorte.inicio, true)}–${formatoTiempo(json.recorte.fin, true)}` : "";
  mostrarEstado(`Listo: ${json.mapas.length} mapas${extra}.`);
  if (primeraVez) $("paso-resultados").scrollIntoView({ behavior: "smooth", block: "start" });
}

formulario.addEventListener("submit", async (e) => {
  e.preventDefault();
  const boton = $("boton-accion");
  boton.disabled = true;
  try {
    if (!estado.trabajo || estado.fuenteNueva) await analizar();
    else await generar();
  } catch (error) {
    mostrarProgreso(null);
    mostrarEstado(error.message, true);
  } finally {
    boton.disabled = false;
    actualizarAccion();
  }
});

// ---------------------------------------------------------------- resultados

function mostrarResultados(json) {
  estado.resultado = json;
  $("paso-resultados").hidden = false;
  $("resumen-resultado").textContent = `${json.metadatos.artista} - ${json.metadatos.titulo} · `
    + (json.recorte ? `tramo de ${formatoTiempo(json.reproduccion.duracion)}` : "canción completa");
  dibujarCapas();

  $("descargar-osz").href = json.osz;
  $("descargar-osz").download = json.oszNombre;
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
        <li>${e.nps_medio} NPS medio · ${e.nps_max} máx.</li>
        <li>Patrones (${e.largo_frase} por frase): ${Object.entries(e.patrones || {}).slice(0, 3).map(([t, n]) => `${t} ${n}`).join(", ")}</li>
        ${errores}${avisos}
      </ul>
      <span class="${v.valido ? "valido" : "invalido"}">${v.valido ? "✔ Válido" : "✖ Con errores"}</span>
      <div class="acciones">
        <button type="button" class="boton-secundario" data-ver="${mapa.indice}">Ver</button>
        <a class="boton-secundario" href="${mapa.url}" download="${mapa.archivo.replace(/&/g, "&amp;")}">.osu</a>
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

  // Al regenerar se conserva la dificultad que se estaba viendo (y la posición, sin recorte).
  const versionAnterior = estado.mapa ? estado.mapa.version : null;
  const posicion = reproductor.currentTime;
  if (reproductor.dataset.fuente !== json.audio) {
    reproductor.src = json.audio;
    reproductor.dataset.fuente = json.audio;
  } else if (!json.recorte) {
    reproductor.currentTime = posicion;
  }
  const mismo = json.mapas.find((m) => m.version === versionAnterior) || json.mapas[0];
  selector.value = mismo.indice;
  elegirMapa(mismo.indice);
}

// ---------------------------------------------------------------- línea de tiempo y recorte

function duracionCancion() {
  return estado.trabajo ? estado.trabajo.analisis.duracion : 1;
}

function recorteVigente() {
  const r = estado.recorte;
  if (!r) return null;
  if (r.inicio <= 0.05 && r.fin >= duracionCancion() - 0.05) return null;
  return r;
}

function ajustarACompas(t) {
  const a = estado.trabajo.analisis;
  const compas = (60 / a.bpm) * a.compas;
  const offset = a.offset_ms / 1000;
  let ajustado = offset + Math.round((t - offset) / compas) * compas;
  if (ajustado < 0) ajustado += compas;
  return Math.min(Math.max(ajustado, 0), a.duracion);
}

function actualizarCamposRecorte() {
  const r = estado.recorte || { inicio: 0, fin: duracionCancion() };
  $("recorte-inicio").value = formatoTiempo(r.inicio, true);
  $("recorte-fin").value = formatoTiempo(r.fin, true);
}

function fijarBorde(borde, t, ajustar) {
  const duracion = duracionCancion();
  const r = estado.recorte || { inicio: 0, fin: duracion };
  let valor = Math.min(Math.max(t, 0), duracion);
  if (ajustar && $("recorte-compas").checked && valor > 0.05 && valor < duracion - 0.05) valor = ajustarACompas(valor);
  if (borde === "inicio") r.inicio = Math.min(valor, r.fin - 10);
  else r.fin = Math.max(valor, r.inicio + 10);
  r.inicio = Math.max(0, r.inicio);
  r.fin = Math.min(duracion, r.fin);
  estado.recorte = r;
  actualizarCamposRecorte();
  dibujarLineaTiempo();
  renderizarSecciones();
  marcarCambios();
}

const lineaTiempo = $("linea-tiempo");

function tiempoEn(evento) {
  const rect = lineaTiempo.getBoundingClientRect();
  return ((evento.clientX - rect.left) / rect.width) * duracionCancion();
}

lineaTiempo.addEventListener("pointerdown", (e) => {
  if (!estado.trabajo) return;
  const t = tiempoEn(e);
  const r = estado.recorte || { inicio: 0, fin: duracionCancion() };
  const porPixel = duracionCancion() / lineaTiempo.clientWidth;
  // Se toma el borde más cercano (y si el clic cae lejos, ese borde salta ahí).
  estado.arrastre = Math.abs(t - r.inicio) <= Math.abs(t - r.fin) ? "inicio" : "fin";
  if (Math.abs(t - r[estado.arrastre]) > 10 * porPixel) fijarBorde(estado.arrastre, t, false);
  lineaTiempo.setPointerCapture(e.pointerId);
});
lineaTiempo.addEventListener("pointermove", (e) => {
  if (estado.arrastre) fijarBorde(estado.arrastre, tiempoEn(e), false);
});
lineaTiempo.addEventListener("pointerup", (e) => {
  if (!estado.arrastre) return;
  fijarBorde(estado.arrastre, tiempoEn(e), true);
  estado.arrastre = null;
});

for (const [id, borde] of [["recorte-inicio", "inicio"], ["recorte-fin", "fin"]]) {
  $(id).addEventListener("change", () => {
    const t = leerTiempo($(id).value);
    if (Number.isFinite(t)) fijarBorde(borde, t, true);
    else actualizarCamposRecorte();
  });
}
$("recorte-completa").addEventListener("click", () => {
  estado.recorte = null;
  actualizarCamposRecorte();
  dibujarLineaTiempo();
  renderizarSecciones();
  marcarCambios();
});

function dibujarLineaTiempo() {
  if (!estado.trabajo) return;
  const a = estado.trabajo.analisis;
  const [ctx, ancho, alto] = ajustarCanvas(lineaTiempo);
  ctx.clearRect(0, 0, ancho, alto);
  const x = (t) => (t / a.duracion) * ancho;
  for (const s of a.secciones) {
    ctx.fillStyle = conAlfa(css(VARIABLE_ETIQUETA[s.etiqueta] || "--s-media"), 0.55);
    ctx.fillRect(x(s.inicio), 0, x(s.fin) - x(s.inicio) - 1, alto);
  }
  ctx.strokeStyle = css("--texto");
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  a.intensidad.forEach((v, i) => {
    const px = (i / (a.intensidad.length - 1)) * ancho;
    const py = alto - v * (alto - 14) - 6;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // Recorte: lo que queda fuera se oscurece; los bordes se pueden arrastrar.
  const r = estado.recorte || { inicio: 0, fin: a.duracion };
  ctx.fillStyle = conAlfa(css("--fondo"), 0.72);
  ctx.fillRect(0, 0, x(r.inicio), alto);
  ctx.fillRect(x(r.fin), 0, ancho - x(r.fin), alto);
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.textBaseline = "top";
  for (const [borde, t] of [["inicio", r.inicio], ["fin", r.fin]]) {
    const px = Math.min(Math.max(x(t), 2), ancho - 2);
    ctx.fillStyle = css("--acento");
    ctx.fillRect(px - 2, 0, 4, alto);
    ctx.fillRect(px - 6, alto / 2 - 12, 12, 24);
    const etiqueta = formatoTiempo(t, true);
    const anchoTexto = ctx.measureText(etiqueta).width;
    const tx = borde === "inicio" ? Math.min(px + 8, ancho - anchoTexto - 4) : Math.max(px - anchoTexto - 8, 4);
    ctx.fillStyle = css("--tarjeta");
    ctx.fillRect(tx - 3, 4, anchoTexto + 6, 16);
    ctx.fillStyle = css("--texto");
    ctx.fillText(etiqueta, tx, 6);
  }
}

// ---------------------------------------------------------------- secciones

function renderizarSecciones() {
  if (!estado.trabajo) return;
  const contenedor = $("secciones");
  contenedor.innerHTML = "";
  const r = estado.recorte || { inicio: 0, fin: duracionCancion() };
  estado.trabajo.analisis.secciones.forEach((s, i) => {
    const ajuste = estado.secciones[i] || (estado.secciones[i] = { opcion: "global", valores: valoresGlobales() });
    const fuera = s.fin <= r.inicio + 0.01 || s.inicio >= r.fin - 0.01;
    const fila = document.createElement("div");
    fila.className = ajuste.opcion === "global" ? "seccion" : "seccion cambiada";
    fila.style.opacity = fuera ? "0.5" : "1";
    fila.innerHTML = `
      <span class="franja" style="background:var(${VARIABLE_ETIQUETA[s.etiqueta] || "--s-media"})"></span>
      <div><strong>${i + 1}. ${NOMBRE_ETIQUETA[s.etiqueta] || s.etiqueta}${s.kiai ? " · kiai" : ""}</strong>
        <small>${formatoTiempo(s.inicio)} – ${formatoTiempo(s.fin)}${fuera ? " · fuera del recorte" : ""}</small></div>
      <select aria-label="Instrumentos de la sección ${i + 1}">
        ${OPCIONES_SECCION.map(([clave, nombre]) => `<option value="${clave}"${clave === ajuste.opcion ? " selected" : ""}>${nombre}</option>`).join("")}
      </select>`;
    const selector = fila.querySelector("select");
    selector.addEventListener("change", () => {
      ajuste.opcion = selector.value;
      if (selector.value === "personalizado") ajuste.valores = valoresGlobales();
      renderizarSecciones();
    });
    if (ajuste.opcion === "personalizado") {
      const controles = document.createElement("div");
      controles.className = "personalizado";
      CAPAS.forEach((capa, j) => {
        const entrada = crearDeslizadorCapa(controles, capa, ajuste.valores[j], () => {
          ajuste.valores[j] = Number(entrada.value);
        });
      });
      fila.appendChild(controles);
    }
    contenedor.appendChild(fila);
  });
}

// ---------------------------------------------------------------- capas

function dibujarCapas() {
  // Antes de generar se ven las capas; después, también el instrumento destacado.
  const json = estado.resultado || estado.trabajo;
  if (!json || !$("capas").clientWidth) return;
  const a = json.analisis;
  const desplazamiento = json.reproduccion ? json.reproduccion.inicio * 1000 : 0;
  const destacados = json.mapas && json.mapas.length ? json.mapas[0].destacados : null;
  const [ctx, ancho, alto] = ajustarCanvas($("capas"));
  ctx.clearRect(0, 0, ancho, alto);
  const capas = CAPAS.filter((n) => a.capas && a.capas[n]).map((n) => [n, a.capas[n]]);
  if (!capas.length) return;
  const etiqueta = Math.min(120, ancho * 0.3);
  const filas = capas.length + (destacados ? 1 : 0);
  const fila = alto / filas;
  const escalaX = (ancho - etiqueta) / a.duracion;
  ctx.font = "12px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  if (destacados) {
    // Primera fila: qué instrumento lleva cada tramo (lo que siguen las notas).
    ctx.fillStyle = css("--texto");
    ctx.fillText("Destacado", 4, fila / 2);
    for (const [inicio, fin, capa] of destacados) {
      ctx.fillStyle = css(`--c-${capa}`) || "#888";
      const x0 = etiqueta + ((inicio + desplazamiento) / 1000) * escalaX;
      ctx.fillRect(x0, 3, Math.max(1, ((fin - inicio) / 1000) * escalaX - 1), fila - 6);
    }
  }
  capas.forEach(([nombre, capa], i) => {
    const y = (i + (destacados ? 1 : 0)) * fila;
    const color = css(`--c-${nombre}`);
    ctx.fillStyle = css("--suave");
    ctx.fillText(`${NOMBRES_CAPA[nombre]} (${capa.onsets})`, 4, y + fila / 2);
    const valores = capa.actividad;
    const paso = (ancho - etiqueta) / valores.length;
    valores.forEach((v, j) => {
      ctx.fillStyle = conAlfa(color, (0.06 + 0.94 * v).toFixed(3));
      ctx.fillRect(etiqueta + j * paso, y + 2, Math.ceil(paso), fila - 4);
    });
  });
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

function duracionReproduccion() {
  return estado.resultado ? estado.resultado.reproduccion.duracion : 1;
}

function dibujarDensidad() {
  if (!estado.mapa) return;
  const [ctx, ancho, alto] = ajustarCanvas($("densidad-mapa"));
  ctx.clearRect(0, 0, ancho, alto);
  const duracion = duracionReproduccion() * 1000;
  const columnas = Math.max(1, Math.floor(ancho / 3));
  const conteo = new Array(columnas).fill(0);
  for (const [t] of estado.mapa.notas) {
    conteo[Math.min(columnas - 1, Math.floor((t / duracion) * columnas))] += 1;
  }
  const maximo = Math.max(1, ...conteo);
  ctx.fillStyle = css("--acento");
  conteo.forEach((c, i) => {
    const h = (c / maximo) * (alto - 4);
    ctx.fillRect(i * 3, alto - h, 2, h);
  });
  ctx.fillStyle = css("--texto");
  ctx.fillRect((reproductor.currentTime * 1000 / duracion) * ancho, 0, 2, alto);
}

$("densidad-mapa").addEventListener("click", (e) => {
  if (!estado.resultado) return;
  const rect = e.currentTarget.getBoundingClientRect();
  reproductor.currentTime = ((e.clientX - rect.left) / rect.width) * duracionReproduccion();
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
  const doble = k > 10; // dos escenarios separados por un hueco
  const anchoColumna = Math.min(70, (ancho - 20) / (k + (doble ? 0.8 : 0)));
  const hueco = doble ? anchoColumna * 0.8 : 0;
  const izquierda = (ancho - anchoColumna * k - hueco) / 2;
  const xColumna = (c) => izquierda + c * anchoColumna + (doble && c >= k / 2 ? hueco : 0);
  const anchoTotal = anchoColumna * k + hueco;
  const colores = coloresColumnas(k);
  const visibleMs = lineaJuicio / velocidad;

  ctx.fillStyle = "#0e0d14";
  ctx.fillRect(0, 0, ancho, alto);
  if (estado.fondo) {
    // Fondo del beatmap, recortado para cubrir el campo y oscurecido como en osu!.
    const img = estado.fondo;
    const escala = Math.max(ancho / img.width, alto / img.height);
    const w = img.width * escala;
    const h = img.height * escala;
    ctx.drawImage(img, (ancho - w) / 2, (alto - h) / 2, w, h);
    ctx.fillStyle = "rgba(14, 13, 20, 0.72)";
    ctx.fillRect(0, 0, ancho, alto);
  }
  for (let c = 0; c < k; c++) {
    ctx.fillStyle = c % 2 ? "rgba(21, 19, 29, 0.85)" : "rgba(25, 23, 35, 0.85)";
    ctx.fillRect(xColumna(c), 0, anchoColumna, alto);
  }

  // Líneas de compás (con el offset del audio que suena, recortado o no).
  const a = estado.resultado.analisis;
  const offset = estado.resultado.reproduccion.offset_ms;
  const compasMs = (60000 / a.bpm) * a.compas;
  ctx.strokeStyle = "#ffffff22";
  ctx.lineWidth = 1;
  const primero = offset + Math.ceil((ahora - offset) / compasMs) * compasMs;
  for (let t = primero; t < ahora + visibleMs; t += compasMs) {
    const y = lineaJuicio - (t - ahora) * velocidad;
    ctx.beginPath();
    ctx.moveTo(izquierda, y);
    ctx.lineTo(izquierda + anchoTotal, y);
    ctx.stroke();
  }

  const pulsadas = new Array(k).fill(false);
  const altoNota = 14;
  for (const [t, c, fin] of estado.mapa.notas) {
    const final = fin > 0 ? fin : t;
    if (final < ahora - 200) continue;
    if (t > ahora + visibleMs) break;
    const borde = Math.min(3, anchoColumna * 0.12);
    const x = xColumna(c) + borde;
    const w = anchoColumna - 2 * borde;
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

  ctx.fillStyle = "#ff66aa";
  ctx.fillRect(izquierda, lineaJuicio, anchoTotal, 3);
  for (let c = 0; c < k; c++) {
    ctx.fillStyle = pulsadas[c] ? colores[c] : "#2a2639";
    const borde = Math.min(4, anchoColumna * 0.15);
    ctx.fillRect(xColumna(c) + borde, lineaJuicio + 12, anchoColumna - 2 * borde, 36);
  }

  const duracion = duracionReproduccion();
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
  reproductor.currentTime = (Number(e.target.value) / 1000) * duracionReproduccion();
  dibujarCampo();
  dibujarDensidad();
});
const salidaVelocidad = $("velocidad").closest("label").querySelector("output");
function mostrarVelocidad() { salidaVelocidad.textContent = `${(Number($("velocidad").value) / 22).toFixed(1)}×`; }
$("velocidad").addEventListener("input", () => { mostrarVelocidad(); dibujarCampo(); });
mostrarVelocidad();

document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(document.activeElement.tagName)) {
    e.preventDefault();
    alternarReproduccion();
  }
});

$("capas").closest("details").addEventListener("toggle", dibujarCapas);

function redibujarTodo() {
  if (!estado.trabajo) return;
  dibujarLineaTiempo();
  dibujarCapas();
  dibujarDensidad();
  dibujarCampo();
}
window.addEventListener("resize", redibujarTodo);

aplicarTema(temaGuardado());
actualizarAccion();
