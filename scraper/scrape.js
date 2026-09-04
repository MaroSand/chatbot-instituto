// scraper/scrape.js
//
// Recorre ispmantovani-cha.infd.edu.ar en dos niveles:
//   1) páginas índice (/profesorados/, /tecnicaturas-2/) -> juntan los links a cada carrera
//   2) página de cada carrera -> de ahí sale el link a "Datos Generales" (texto real)
//      y, si existe, el link al "Plan de Estudio" (PDF en Google Drive)
// También saca de la Home el estado de cupos, fechas importantes, preguntas
// frecuentes y documentación del legajo.
//
// Uso: node scraper/scrape.js
//
// Requiere Node 18+ (usa fetch nativo) y las deps del package.json (cheerio, pdf-parse).

import * as cheerio from "cheerio";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "data", "institucion.json");

const BASE = "https://ispmantovani-cha.infd.edu.ar/sitio";
const HOME_URL = `${BASE}/`;
const INDEX_PAGES = [
  { url: `${BASE}/profesorados/`, tipo: "profesorado" },
  { url: `${BASE}/tecnicaturas-2/`, tipo: "tecnicatura" },
];

// Links que aparecen en el menú de navegación y en los banners institucionales,
// para no confundirlos con links a carreras. Si el instituto agrega secciones
// nuevas al menú, puede hacer falta sumarlas acá.
const RUTAS_A_IGNORAR = new Set(
  [
    "/", "", "autoridades", "contacto", "acciones", "investigacion",
    "actualizacion-superior-en-gestion-educativa", "actualizaciones-academicas",
    "convenios-institucionales", "biblioteca", "guarderia-maternal", "anexos",
    "carreras", "institucional", "profesorados", "tecnicaturas-2",
  ].map((p) => p.replace(/^\/|\/$/g, ""))
);

function normalizar(texto) {
  return (texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // saca acentos
    .toLowerCase()
    .trim();
}

async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (chatbot-instituto scraper)" },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return cheerio.load(await res.text());
}

// Saca el path relativo (sin barras al inicio/final) de una URL del mismo sitio.
function pathDe(url) {
  try {
    const u = new URL(url, BASE);
    if (u.hostname !== new URL(BASE).hostname) return null;
    return u.pathname.replace(/^\/sitio\/?/, "").replace(/^\/|\/$/g, "");
  } catch {
    return null;
  }
}

async function extraerLinksDeCarreras(indexUrl) {
  const $ = await fetchHTML(indexUrl);
  const links = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const p = pathDe(href);
    if (p === null) return; // link externo
    if (RUTAS_A_IGNORAR.has(p)) return;
    if (p.startsWith("wp-content")) return;
    const texto = normalizar($(el).text());
    if (texto.includes("volver")) return;
    links.add(new URL(href, indexUrl).toString());
  });
  return [...links];
}

// Busca, dentro de la página de una carrera, el link de "Datos Generales"
// y el de "Plan de Estudio" (según el texto visible del link).
function extraerLinksInternos($) {
  let datosGenerales = null;
  let planDeEstudio = null;
  $("a[href]").each((_, el) => {
    const texto = normalizar($(el).text());
    const href = $(el).attr("href");
    if (!href) return;
    if (!datosGenerales && texto.includes("datos generales")) {
      datosGenerales = href;
    }
    if (!planDeEstudio && texto.includes("plan de estudio")) {
      planDeEstudio = href;
    }
  });
  return { datosGenerales, planDeEstudio };
}

// Extrae el texto "real" de una página, sacando menú, header, footer y ruido.
function extraerTextoPrincipal($) {
  const $copia = cheerio.load($.html());
  $copia("nav, header, footer, script, style, .menu, #menu, .addtoany_share_save_container")
    .remove();
  // saca también los links de navegación "VOLVER A ..."
  $copia("a").each((_, el) => {
    const t = normalizar($copia(el).text());
    if (t.startsWith("volver a")) $copia(el).remove();
  });
  return $copia("body")
    .text()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Convierte un link de Google Drive (.../file/d/ID/view) en URL de descarga directa.
function driveIdDesdeUrl(url) {
  const m = url && url.match(/\/file\/d\/([^/]+)/);
  return m ? m[1] : null;
}

async function extraerTextoPDF(driveUrl) {
  const id = driveIdDesdeUrl(driveUrl);
  if (!id) return { texto: "", nota: "No es un link de Google Drive reconocido." };
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${id}`;
  try {
    const res = await fetch(downloadUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    // Si el archivo es grande, Drive devuelve una página HTML de "confirmar descarga"
    // en vez del PDF. Lo detectamos chequeando la cabecera mágica %PDF.
    if (buf.slice(0, 4).toString() !== "%PDF") {
      return {
        texto: "",
        nota: "Google Drive no devolvió el PDF directamente (posible pantalla de confirmación por archivo grande). Revisar manualmente: " + driveUrl,
      };
    }
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buf);
    return { texto: data.text.trim(), nota: null };
  } catch (err) {
    return { texto: "", nota: `Error al leer el PDF: ${err.message}` };
  }
}

// Del texto de la Home, intenta encontrar la línea de "estado de cupos" que
// corresponde a una carrera por nombre (matching aproximado, sin acentos).
function buscarEstadoCupos(homeTexto, nombreCarrera) {
  const nombreNorm = normalizar(nombreCarrera);
  const lineas = homeTexto.split("\n");
  for (const linea of lineas) {
    const lineaNorm = normalizar(linea);
    if (
      lineaNorm.includes("cupo") &&
      (lineaNorm.includes(nombreNorm) || nombreNorm.includes(lineaNorm.split(".")[0]))
    ) {
      return linea.trim();
    }
  }
  return "";
}

async function main() {
  console.log("Descargando Home...");
  const $home = await fetchHTML(HOME_URL);
  const homeTexto = extraerTextoPrincipal($home);

  const carreras = [];

  for (const { url: indexUrl, tipo } of INDEX_PAGES) {
    console.log(`Descargando índice: ${indexUrl}`);
    const carreraLinks = await extraerLinksDeCarreras(indexUrl);
    console.log(`  -> ${carreraLinks.length} carreras encontradas`);

    for (const carreraUrl of carreraLinks) {
      console.log(`  Procesando carrera: ${carreraUrl}`);
      try {
        const $carrera = await fetchHTML(carreraUrl);
        const nombre = $carrera("h1").first().text().trim() || pathDe(carreraUrl);
        const { datosGenerales, planDeEstudio } = extraerLinksInternos($carrera);

        let datosGeneralesTexto = "";
        if (datosGenerales) {
          const $dg = await fetchHTML(new URL(datosGenerales, carreraUrl).toString());
          datosGeneralesTexto = extraerTextoPrincipal($dg);
        } else {
          console.warn(`    (!) No se encontró link "Datos Generales" en ${carreraUrl}`);
        }

        let planTexto = "";
        if (planDeEstudio) {
          const { texto, nota } = await extraerTextoPDF(planDeEstudio);
          planTexto = texto || (nota ?? "");
        }

        carreras.push({
          nombre,
          tipo,
          estado_cupos: buscarEstadoCupos(homeTexto, nombre),
          datos_generales: datosGeneralesTexto,
          plan_de_estudio: planTexto,
          url_fuente: carreraUrl,
        });
      } catch (err) {
        console.error(`    Error procesando ${carreraUrl}: ${err.message}`);
      }
    }
  }

  const institucion = {
    carreras,
    documentacion_legajo:
      "1. Fotocopia autenticada del Título secundario o Constancia de Título en trámite (original). " +
      "2. Fotocopia autenticada del Acta de Nacimiento (Actualizada). " +
      "3. Dos Fotocopias autenticadas del D.N.I (actualizado). " +
      "4. Dos fotos 4x4 tipo carnet. 5. Formulario de Inscripción. " +
      "6. Certificado Psicofísico. 7. Fotocopia del Grupo sanguíneo. " +
      "8. Un folio tamaño oficio. 9. Aporte voluntario de la cooperadora.",
    fechas_importantes: homeTexto, // texto completo de la Home; el prompt de Gemini filtra lo relevante
    preguntas_frecuentes: homeTexto,
    contacto: {
      direccion: "Pueyrredón N° 1530 (Calle 25 entre 32 y 34), barrio Yapeyú, Presidencia Roque Sáenz Peña",
      telefono: "0364 - 4426447",
      horario_atencion: "07:00 a 21:50",
      sitio_web: HOME_URL,
    },
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(institucion, null, 2), "utf-8");
  console.log(`\nListo. Se guardaron ${carreras.length} carreras en ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Error fatal en el scraper:", err);
  process.exit(1);
});