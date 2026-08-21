// ==========================================================================
// CONFIGURACIÓN — esto es lo único que normalmente necesitas tocar
// ==========================================================================
const CONFIG = {
  // El ID está en la URL de tu Google Sheet:
  // https://docs.google.com/spreadsheets/d/ESTE_ES_EL_ID/edit
  SHEET_ID: "TU_SHEET_ID_AQUI",
  // Nombre exacto de la pestaña donde el worker escribe las respuestas
  SHEET_TAB: "Respuestas",
  // Cada cuántos ms se refresca solo (60000 = 60s)
  REFRESH_MS: 60000,
};

// Orden de columnas esperado en la hoja (fila 1 = encabezados, se ignora)
// A: participant_session_id  B: respuesta_1  C: respuesta_2  D: respuesta_3
// E: fortaleza  F: oportunidad  G: eje_principal  H: eje_a_fortalecer
// I: compromiso  J: estado
const COLUMNS = [
  "participant_session_id",
  "respuesta_1",
  "respuesta_2",
  "respuesta_3",
  "fortaleza",
  "oportunidad",
  "eje_principal",
  "eje_a_fortalecer",
  "compromiso",
  "estado",
];

const EJES = ["Visión", "Objetivos", "Personas", "Resultados"];
const EJE_META = {
  "Visión": { color: "#5B3B96", track: "#EAE4F7" },
  "Objetivos": { color: "#F0791F", track: "#FDEBDB" },
  "Personas": { color: "#2F6FE0", track: "#E1EAFB" },
  "Resultados": { color: "#1FA95C", track: "#DEF3E7" },
};
const EJE_DESC = {
  "Visión": "Cultura, estándares y coherencia.",
  "Objetivos": "Claridad de expectativas y responsabilidades.",
  "Personas": "Escucha, respeto y ausencia de favoritismo.",
  "Resultados": "Actuación, documentación y cumplimiento.",
};
const ACCENTS = ["#5B3B96", "#F0791F", "#1FA95C"];

// ==========================================================================
// CSV — descarga y parseo (soporta comillas, comas y saltos de línea dentro de celdas)
// ==========================================================================
function buildCsvUrl() {
  return `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(CONFIG.SHEET_TAB)}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') { field += '"'; i++; }
      else if (char === '"') { inQuotes = false; }
      else { field += char; }
    } else {
      if (char === '"') inQuotes = true;
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (char === "\r") { /* ignore */ }
      else { field += char; }
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function rowsToRecords(rows) {
  // rows[0] = encabezados -> se salta
  return rows.slice(1)
    .filter((r) => r.some((cell) => (cell || "").trim() !== ""))
    .map((r) => {
      const record = {};
      COLUMNS.forEach((key, i) => { record[key] = (r[i] || "").trim(); });
      return record;
    });
}

// ==========================================================================
// AGREGACIÓN — igual lógica que usaría un backend, pero corriendo en el navegador
// ==========================================================================
function normalizeText(value) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeEje(value) {
  const v = normalizeText(value);
  if (v.startsWith("vision")) return "Visión";
  if (v.startsWith("objetivo")) return "Objetivos";
  if (v.startsWith("persona")) return "Personas";
  if (v.startsWith("resultado")) return "Resultados";
  return null;
}

function isCompletado(estado) {
  const v = normalizeText(estado);
  return v === "completado" || v === "completo" || v === "finalizado";
}

function rankPatterns(values, denominator) {
  const counts = new Map();
  values.filter((v) => v.trim() !== "").forEach((raw) => {
    const key = normalizeText(raw);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { original: raw.trim(), count: 1 });
  });
  return Array.from(counts.values())
    .map(({ original, count }) => ({
      texto: original,
      conteo: count,
      porcentaje: denominator > 0 ? Math.round((count / denominator) * 100) : 0,
    }))
    .sort((a, b) => b.conteo - a.conteo);
}

function aggregate(records) {
  const completados = records.filter((r) => isCompletado(r.estado));
  const base = completados.length > 0 ? completados : records;
  const total = base.length;

  const ejeCounts = new Map(EJES.map((e) => [e, 0]));
  const aFortalecerCounts = new Map(EJES.map((e) => [e, 0]));

  base.forEach((row) => {
    const eje = normalizeEje(row.eje_principal);
    if (eje) ejeCounts.set(eje, ejeCounts.get(eje) + 1);
    const ejeAF = normalizeEje(row.eje_a_fortalecer);
    if (ejeAF) aFortalecerCounts.set(ejeAF, aFortalecerCounts.get(ejeAF) + 1);
  });

  const ejeStats = EJES.map((eje) => {
    const conteo = ejeCounts.get(eje) || 0;
    return { eje, conteo, porcentaje: total > 0 ? Math.round((conteo / total) * 100) : 0 };
  });

  const ejeMasPresente = total > 0
    ? ejeStats.reduce((a, b) => (b.conteo > a.conteo ? b : a)).eje
    : null;

  const ejeAFRanked = EJES.map((eje) => ({ eje, conteo: aFortalecerCounts.get(eje) || 0 }))
    .sort((a, b) => b.conteo - a.conteo);
  const ejeAFortalecer = total > 0 && ejeAFRanked[0].conteo > 0 ? ejeAFRanked[0].eje : null;

  const fortalezaRanked = rankPatterns(base.map((r) => r.fortaleza), total);
  const oportunidadRanked = rankPatterns(base.map((r) => r.oportunidad), total);
  const topInsights = [...fortalezaRanked, ...oportunidadRanked]
    .sort((a, b) => b.conteo - a.conteo)
    .slice(0, 3);

  const compromisos = base.map((r) => r.compromiso).filter((c) => c.trim() !== "").reverse();

  return {
    nParticipantesCompletados: completados.length,
    ejeStats,
    ejeMasPresente,
    fortalezaColectiva: fortalezaRanked[0] || null,
    oportunidadColectiva: oportunidadRanked[0] || null,
    topInsights,
    compromisos,
  };
}

// ==========================================================================
// DATOS DE DEMOSTRACIÓN — se usan si el Sheet no está configurado o falla la carga
// ==========================================================================
function buildDemoData() {
  const demoRows = [
    { fortaleza: "Objetividad", oportunidad: "Documentación", eje_principal: "Personas", eje_a_fortalecer: "Resultados", compromiso: "Voy a documentar cada llamado de atención, sin excepción.", estado: "completado" },
    { fortaleza: "Escucha activa", oportunidad: "Documentación", eje_principal: "Personas", eje_a_fortalecer: "Resultados", compromiso: "Aplicar el mismo criterio sin importar la cercanía con la persona.", estado: "completado" },
    { fortaleza: "Objetividad", oportunidad: "Reporte oportuno", eje_principal: "Resultados", eje_a_fortalecer: "Personas", compromiso: "Reportar a tiempo aunque la conversación ya se haya dado en privado.", estado: "completado" },
    { fortaleza: "Consistencia", oportunidad: "Documentación", eje_principal: "Objetivos", eje_a_fortalecer: "Personas", compromiso: "Escuchar a todo el equipo antes de decidir.", estado: "completado" },
    { fortaleza: "Escucha activa", oportunidad: "Seguimiento", eje_principal: "Personas", eje_a_fortalecer: "Resultados", compromiso: "Dar seguimiento por escrito a cada acuerdo verbal.", estado: "completado" },
  ];
  return aggregate(demoRows);
}

// ==========================================================================
// RENDER
// ==========================================================================
function renderGauges(ejeStats, ejeMasPresente) {
  const container = document.getElementById("gauges");
  container.innerHTML = "";

  ejeStats.forEach((stat) => {
    const meta = EJE_META[stat.eje];
    const size = 100, stroke = 9;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (Math.min(Math.max(stat.porcentaje, 0), 100) / 100) * circumference;

    const item = document.createElement("div");
    item.className = "gauge-item";
    item.innerHTML = `
      <div class="gauge-wrap">
        <svg class="gauge-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
          <circle cx="${size/2}" cy="${size/2}" r="${radius}" fill="none" stroke="${meta.track}" stroke-width="${stroke}" />
          <circle cx="${size/2}" cy="${size/2}" r="${radius}" fill="none" stroke="${meta.color}" stroke-width="${stroke}"
            stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" />
        </svg>
        <div class="gauge-percent">${stat.porcentaje}%</div>
      </div>
      <span class="gauge-label">${stat.eje}</span>
    `;
    container.appendChild(item);
  });

  const titulo = document.getElementById("eje-predominante-titulo");
  const desc = document.getElementById("eje-predominante-desc");
  if (ejeMasPresente) {
    titulo.textContent = `EJE PREDOMINANTE: ${ejeMasPresente.toUpperCase()}`;
    desc.textContent = EJE_DESC[ejeMasPresente];
  } else {
    titulo.textContent = "EJE PREDOMINANTE: SIN DATOS AÚN";
    desc.textContent = "Se mostrará en cuanto lleguen respuestas del grupo.";
  }
}

function renderInsights(insights) {
  const container = document.getElementById("insights");
  container.innerHTML = "";
  const items = insights.length > 0 ? insights : [null, null, null];

  items.forEach((insight, i) => {
    const card = document.createElement("div");
    card.className = "insight-card";
    card.innerHTML = `
      <span class="insight-number" style="background:${ACCENTS[i]}">${i + 1}</span>
      <p class="insight-text">${insight ? escapeHtml(insight.texto) : "Aún sin suficientes respuestas."}</p>
      <div class="insight-bar-row">
        <div class="insight-bar-track">
          <div class="insight-bar-fill" style="width:${insight ? insight.porcentaje : 0}%; background:${ACCENTS[i]}"></div>
        </div>
        <span class="insight-pct">${insight ? insight.porcentaje + "%" : "—"}</span>
      </div>
    `;
    container.appendChild(card);
  });
}

function renderStrengthOpportunity(fortaleza, oportunidad) {
  const fBox = document.getElementById("fortaleza-box");
  fBox.innerHTML = fortaleza ? `
    <div class="strength-icon" style="background:${EJE_META["Personas"] ? "#F5F2FB" : "#F5F2FB"}; color:#5B3B96;">●</div>
    <div>
      <p class="strength-text">El grupo demuestra una fuerte presencia de "${escapeHtml(fortaleza.texto)}" en sus decisiones.</p>
      <p class="strength-tag" style="color:#5B3B96;">${fortaleza.porcentaje}% de las respuestas lo evidencian.</p>
    </div>
  ` : `<p class="strength-text">Aún no hay suficientes respuestas para identificar un patrón.</p>`;

  const oBox = document.getElementById("oportunidad-box");
  oBox.innerHTML = oportunidad ? `
    <div class="strength-icon" style="background:#FDEBDB; color:#F0791F;">▲</div>
    <div>
      <p class="strength-text">"${escapeHtml(oportunidad.texto)}" es el patrón de mejora más señalado por el grupo.</p>
      <p class="strength-tag" style="color:#F0791F;">Es la oportunidad más señalada por el grupo.</p>
    </div>
  ` : `<p class="strength-text">Aún no hay suficientes respuestas para identificar un patrón.</p>`;
}

function renderCommitments(compromisos) {
  const track = document.getElementById("compromisos-track");
  track.innerHTML = "";
  if (compromisos.length === 0) {
    track.innerHTML = `<p class="empty-text">Los compromisos del equipo aparecerán aquí en cuanto los participantes completen la simulación.</p>`;
    return;
  }
  compromisos.forEach((texto) => {
    const card = document.createElement("div");
    card.className = "commitment-card";
    card.innerHTML = `
      <div class="commitment-quote">&ldquo;</div>
      <p class="commitment-text">${escapeHtml(texto)}</p>
      <p class="commitment-author">Participante anónimo</p>
    `;
    track.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ==========================================================================
// CARGA PRINCIPAL
// ==========================================================================
let cargando = false;

async function cargarDatos() {
  if (cargando) return;
  cargando = true;
  setRefreshButtonState(true);

  const demoBanner = document.getElementById("banner-demo");
  const errorBanner = document.getElementById("banner-error");
  errorBanner.hidden = true;

  try {
    if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID === "TU_SHEET_ID_AQUI") {
      demoBanner.hidden = false;
      applyData(buildDemoData());
      return;
    }

    const res = await fetch(buildCsvUrl());
    if (!res.ok) throw new Error("No se pudo leer el Google Sheet (revisa que esté compartido como 'Cualquiera con el enlace - Lector').");
    const text = await res.text();
    const records = rowsToRecords(parseCsv(text));
    demoBanner.hidden = true;
    applyData(aggregate(records), records.length);
  } catch (err) {
    console.error(err);
    errorBanner.textContent = err.message || "Ocurrió un error al cargar los datos.";
    errorBanner.hidden = false;
    demoBanner.hidden = false;
    applyData(buildDemoData());
  } finally {
    cargando = false;
    setRefreshButtonState(false);
    document.getElementById("ultima-actualizacion").textContent =
      "Actualizado " + new Date().toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  }
}

function applyData(data, totalFilas) {
  renderGauges(data.ejeStats, data.ejeMasPresente);
  renderInsights(data.topInsights);
  renderStrengthOpportunity(data.fortalezaColectiva, data.oportunidadColectiva);
  renderCommitments(data.compromisos);
  document.getElementById("footer-count").textContent =
    typeof data.nParticipantesCompletados === "number"
      ? ` · ${data.nParticipantesCompletados} participantes completados.`
      : "";
}

function setRefreshButtonState(isLoading) {
  const btn = document.getElementById("btn-actualizar");
  const icon = document.getElementById("refresh-icon");
  btn.disabled = isLoading;
  icon.className = isLoading ? "spin" : "";
  btn.childNodes[btn.childNodes.length - 1].textContent = isLoading ? " Actualizando…" : " Actualizar datos";
}

// Carrusel de compromisos
document.getElementById("btn-prev").addEventListener("click", () => {
  document.getElementById("compromisos-track").scrollBy({ left: -300, behavior: "smooth" });
});
document.getElementById("btn-next").addEventListener("click", () => {
  document.getElementById("compromisos-track").scrollBy({ left: 300, behavior: "smooth" });
});
document.getElementById("btn-actualizar").addEventListener("click", cargarDatos);

cargarDatos();
setInterval(cargarDatos, CONFIG.REFRESH_MS);
