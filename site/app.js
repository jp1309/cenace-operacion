/* Dashboard de consulta de la base diaria CENACE. Sin dependencias salvo Plotly. */
"use strict";

const estado = {
  resumen: [], curva: [], detalle: [], mensual: [], anual: [], operativo: [], meta: null,
  rango: { desde: null, hasta: null }, dia: null, periodo: { desde: null, hasta: null },
  vista: "diario", tablas: {}, modoTabla: {},
};

const FUENTES = [
  { clave: "hidraulica", nombre: "Hidráulica", color: "--serie-hidro" },
  { clave: "termica", nombre: "Térmica", color: "--serie-termica" },
  { clave: "no_convencional", nombre: "No convencional", color: "--serie-noconv" },
  { clave: "importacion", nombre: "Importación", color: "--serie-import" },
];

// ---------------------------------------------------------------- utilidades

function parseCSV(texto) {
  texto = texto.replace(/^﻿/, "");
  const filas = [];
  let fila = [], campo = "", comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      fila.push(campo); filas.push(fila); fila = []; campo = "";
    } else campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  const [cab, ...resto] = filas.filter((f) => f.length > 1 || f[0]);
  return resto.map((f) => Object.fromEntries(cab.map((k, i) => [k, f[i] ?? ""])));
}

const num = (v) => (v === "" || v == null ? null : Number(v));
const fmt = (v, dec = 0) => (v == null || Number.isNaN(v) ? "—" :
  new Intl.NumberFormat("es-EC", { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v));
const pct = (a, b) => (b ? fmt((100 * a) / b, 1) + " %" : "—");
const dias = (n) => `${n} ${n === 1 ? "día" : "días"}`;
const aFecha = (iso) => new Date(iso + "T00:00:00Z");
const isoDe = (d) => d.toISOString().slice(0, 10);
const fechaLarga = (iso) => new Intl.DateTimeFormat("es-EC", {
  weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(aFecha(iso));
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function css(variable) {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

function el(tag, attrs = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else if (k === "html") n.innerHTML = v; else n.setAttribute(k, v);
  }
  for (const h of hijos) n.append(h);
  return n;
}

function tile(etiqueta, valor, unidad = "", detalle = "") {
  return el("div", { class: "tile" },
    el("div", { class: "etiqueta" }, etiqueta),
    el("div", { class: "valor", html: `${valor}${unidad ? `<small>${unidad}</small>` : ""}` }),
    el("div", { class: "detalle" }, detalle));
}

// Rellena días faltantes con null para que las líneas no unan fechas lejanas.
function serieCompleta(filas, desde, hasta) {
  const porFecha = new Map(filas.map((f) => [f.fecha, f]));
  const salida = [];
  for (let d = aFecha(desde); d <= aFecha(hasta); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = isoDe(d);
    salida.push(porFecha.get(iso) || { fecha: iso, _vacio: true });
  }
  return salida;
}

// ---------------------------------------------------------------- Plotly

function layoutBase(extra = {}) {
  const tinta2 = css("--tinta-2"), rejilla = css("--rejilla"), eje = css("--eje");
  return {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 12, color: tinta2 },
    margin: { l: 56, r: 12, t: 8, b: 40 },
    separators: ",.",
    hovermode: "x unified",
    hoverlabel: { bgcolor: css("--superficie"), bordercolor: css("--borde"), font: { color: css("--tinta") } },
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { color: tinta2 }, traceorder: "normal" },
    xaxis: { gridcolor: rejilla, linecolor: eje, tickcolor: eje, showgrid: false, zeroline: false },
    yaxis: { gridcolor: rejilla, linecolor: eje, zeroline: true, zerolinecolor: eje, rangemode: "tozero",
      tickformat: ",~r" },
    bargap: 0.25, barcornerradius: 4,
    ...extra,
  };
}

const CONFIG = { displayModeBar: false, responsive: true, locale: "es" };

function registrarLocale() {
  Plotly.register({
    moduleType: "locale", name: "es", dictionary: {},
    format: {
      days: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
      shortDays: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
      months: MESES_LARGOS,
      shortMonths: MESES, date: "%d/%m/%Y", decimal: ",", thousands: ".",
    },
  });
}

function dibujar(id, trazas, layout, tabla) {
  estado.tablas[id] = tabla;
  const nodo = document.getElementById(id);
  if (estado.modoTabla[id]) { mostrarTabla(id); return; }
  if (!trazas.length || trazas.every((t) => !(t.y || t.x || []).some((v) => v != null))) {
    Plotly.purge(nodo); nodo.innerHTML = '<p class="vacio">Sin datos para este filtro.</p>'; return;
  }
  // Plotly.react actualiza en el lugar; solo se limpia si el nodo tenía otro contenido.
  if (!nodo.classList.contains("js-plotly-plot")) nodo.innerHTML = "";
  Plotly.react(nodo, trazas, layout, CONFIG);
}

function construirTabla({ columnas, filas }) {
  const t = el("table");
  t.append(el("thead", {}, el("tr", {}, ...columnas.map((c) => el("th", {}, c.titulo)))));
  const cuerpo = el("tbody");
  for (const f of filas) cuerpo.append(el("tr", {}, ...columnas.map((c) => el("td", {}, c.fmt ? c.fmt(f[c.clave], f) : f[c.clave] ?? ""))));
  t.append(cuerpo);
  return el("div", { class: "tabla-contenedor" }, t);
}

function mostrarTabla(id) {
  const nodo = document.getElementById(id);
  Plotly.purge(nodo);
  nodo.innerHTML = "";
  nodo.style.height = "auto";
  nodo.append(construirTabla(estado.tablas[id] || { columnas: [], filas: [] }));
}

// ---------------------------------------------------------------- vista: serie diaria

function filasEnRango() {
  const { desde, hasta } = estado.rango;
  return estado.resumen.filter((f) => f.fecha >= desde && f.fecha <= hasta);
}

function renderDiario() {
  const filas = filasEnRango();
  const { desde, hasta } = estado.rango;

  const total = filas.reduce((s, f) => s + (num(f.produccion_total_mwh) || 0), 0);
  const suma = (k) => filas.reduce((s, f) => s + (num(f[k]) || 0), 0);
  const pico = filas.reduce((m, f) => (num(f.demanda_max_mw) > (m ? num(m.demanda_max_mw) : -1) ? f : m), null);
  const neto = suma("importacion_mwh") - suma("exportacion_mwh");
  document.getElementById("tiles-diario").replaceChildren(
    tile("Producción total", fmt(total / 1000, 1), "GWh", `${dias(filas.length)} con datos`),
    tile("Hidráulica", pct(suma("hidraulica_mwh"), total), "", `${fmt(suma("hidraulica_mwh") / 1000, 1)} GWh`),
    tile("Térmica", pct(suma("termica_mwh"), total), "", `${fmt(suma("termica_mwh") / 1000, 1)} GWh`),
    tile("Demanda máxima", pico ? fmt(num(pico.demanda_max_mw)) : "—", "MW",
      pico ? `${fechaLarga(pico.fecha)}, ${pico.hora_demanda_max}` : ""),
    tile("Intercambio neto", fmt(neto), "MWh", neto >= 0 ? "importación neta" : "exportación neta"),
  );

  const completa = filas.length ? serieCompleta(filas, desde, hasta) : [];
  const x = completa.map((f) => f.fecha);
  // Con rangos largos cada barra mide pocos píxeles: sin separador para que no desaparezca.
  const pxPorDia = (document.getElementById("g-produccion").clientWidth - 70) / Math.max(completa.length, 1);
  const separador = pxPorDia >= 8 ? 1.5 : 0;
  const trazas = FUENTES.map((s) => ({
    type: "bar", name: s.nombre, x,
    y: completa.map((f) => (f._vacio ? null : num(f[`${s.clave}_mwh`]) / 1000)),
    marker: { color: css(s.color), line: { color: css("--superficie"), width: separador } },
    hovertemplate: `${s.nombre}: %{y:,.2f} GWh<extra></extra>`,
  }));
  dibujar("g-produccion", trazas, layoutBase({ barmode: "stack", xaxis: { ...layoutBase().xaxis, type: "date" } }), {
    columnas: [
      { clave: "fecha", titulo: "Fecha" },
      ...FUENTES.map((s) => ({ clave: `${s.clave}_mwh`, titulo: `${s.nombre} (MWh)`, fmt: (v) => fmt(num(v)) })),
      { clave: "exportacion_mwh", titulo: "Exportación (MWh)", fmt: (v) => fmt(num(v)) },
      { clave: "produccion_total_mwh", titulo: "Total (MWh)", fmt: (v) => fmt(num(v)) },
    ],
    filas: [...filas].reverse(),
  });

  dibujar("g-demanda", [{
    type: "scatter", mode: "lines+markers", name: "Demanda máxima", x,
    y: completa.map((f) => (f._vacio ? null : num(f.demanda_max_mw))),
    customdata: completa.map((f) => f.hora_demanda_max || ""),
    line: { color: css("--tinta"), width: 2 }, marker: { size: 8, color: css("--tinta"), line: { color: css("--superficie"), width: 2 } },
    connectgaps: false, hovertemplate: "Demanda máxima: %{y:,.0f} MW a las %{customdata}<extra></extra>",
  }], layoutBase({ showlegend: false, yaxis: { ...layoutBase().yaxis, rangemode: "normal" }, xaxis: { ...layoutBase().xaxis, type: "date" } }), {
    columnas: [
      { clave: "fecha", titulo: "Fecha" },
      { clave: "demanda_max_mw", titulo: "Demanda máx. (MW)", fmt: (v) => fmt(num(v)) },
      { clave: "hora_demanda_max", titulo: "Hora" },
      { clave: "demanda_min_mw", titulo: "Demanda mín. (MW)", fmt: (v) => fmt(num(v)) },
      { clave: "hora_demanda_min", titulo: "Hora" },
    ],
    filas: [...filas].reverse(),
  });

  const huecos = completa.filter((f) => f._vacio).length;
  const primero = estado.resumen[0]?.fecha;
  document.getElementById("nota-cobertura").textContent = [
    primero ? `La serie diaria empieza el ${fechaLarga(primero)} y suma un día nuevo cada día.` : "",
    huecos ? `El rango tiene ${dias(huecos)} sin datos.` : "",
  ].join(" ").trim();
}

// ---------------------------------------------------------------- vista: consulta por día

function renderDia() {
  const fecha = estado.dia;
  const r = estado.resumen.find((f) => f.fecha === fecha);
  if (!r) return;
  const total = num(r.produccion_total_mwh);
  document.getElementById("tiles-dia").replaceChildren(
    tile("Producción total", fmt(total), "MWh", fechaLarga(fecha)),
    tile("Hidráulica", pct(num(r.hidraulica_mwh), total), "", `${fmt(num(r.hidraulica_mwh))} MWh`),
    tile("Térmica", pct(num(r.termica_mwh), total), "", `${fmt(num(r.termica_mwh))} MWh`),
    tile("Demanda máxima", fmt(num(r.demanda_max_mw)), "MW", r.hora_demanda_max ? `a las ${r.hora_demanda_max}` : ""),
    tile("Demanda mínima", fmt(num(r.demanda_min_mw)), "MW", r.hora_demanda_min ? `a las ${r.hora_demanda_min}` : ""),
    tile("Intercambio neto", fmt(num(r.importacion_mwh) - num(r.exportacion_mwh)), "MWh",
      `import. ${fmt(num(r.importacion_mwh))} · export. ${fmt(num(r.exportacion_mwh))}`),
  );

  const curva = estado.curva.filter((f) => f.fecha === fecha);
  const horas = curva.map((f) => f.hora);
  const capas = [
    { k: "hidraulica_mw", n: "Hidráulica", c: "--serie-hidro" },
    { k: "termica_mw", n: "Térmica", c: "--serie-termica" },
    { k: "renovable_mw", n: "No convencional", c: "--serie-noconv" },
    { k: "importacion_mw", n: "Importación", c: "--serie-import" },
  ];
  const trazas = capas.map((s) => ({
    type: "scatter", mode: "lines", stackgroup: "produccion", name: s.n, x: horas,
    y: curva.map((f) => num(f[s.k])), line: { width: 0.5, color: css("--superficie") },
    fillcolor: css(s.c), hovertemplate: `${s.n}: %{y:,.0f} MW<extra></extra>`,
  }));
  trazas.push({
    type: "scatter", mode: "lines", name: "Exportación", x: horas, y: curva.map((f) => num(f.exportacion_mw)),
    line: { width: 0 }, showlegend: false, hovertemplate: "Exportación: %{y:,.0f} MW<extra></extra>",
  });
  trazas.push({
    type: "scatter", mode: "lines", name: "Demanda nacional", x: horas, y: curva.map((f) => num(f.demanda_nacional_mw)),
    line: { color: css("--tinta"), width: 2 }, hovertemplate: "Demanda nacional: %{y:,.0f} MW<extra></extra>",
  });
  dibujar("g-curva", trazas, layoutBase({ xaxis: { ...layoutBase().xaxis, type: "category", nticks: 12 } }), {
    columnas: [
      { clave: "hora", titulo: "Hora" },
      ...capas.map((s) => ({ clave: s.k, titulo: `${s.n} (MW)`, fmt: (v) => fmt(num(v)) })),
      { clave: "exportacion_mw", titulo: "Exportación (MW)", fmt: (v) => fmt(num(v)) },
      { clave: "demanda_nacional_mw", titulo: "Demanda (MW)", fmt: (v) => fmt(num(v)) },
    ],
    filas: curva,
  });

  const detalle = estado.detalle.filter((f) => f.fecha === fecha);
  const barras = (grupo, id, colorDe) => {
    const filas = detalle.filter((f) => f.grupo === grupo).sort((a, b) => num(a.mwh) - num(b.mwh));
    dibujar(id, [{
      type: "bar", orientation: "h", y: filas.map((f) => f.nombre), x: filas.map((f) => num(f.mwh)),
      marker: { color: filas.map((f) => css(colorDe(f.nombre))) },
      text: filas.map((f) => fmt(num(f.mwh))), textposition: "outside", cliponaxis: false,
      textfont: { color: css("--tinta-2") }, hovertemplate: "%{y}: %{x:,.0f} MWh<extra></extra>",
    }], layoutBase({ showlegend: false, hovermode: "closest", margin: { l: 140, r: 56, t: 8, b: 32 },
      xaxis: { ...layoutBase().xaxis, showgrid: true, rangemode: "tozero" }, yaxis: { automargin: true, linecolor: css("--eje") } }), {
      columnas: [{ clave: "nombre", titulo: "Nombre" }, { clave: "mwh", titulo: "MWh", fmt: (v) => fmt(num(v)) }],
      filas: [...filas].reverse(),
    });
  };
  barras("hidraulica", "g-hidro", () => "--serie-hidro");
  barras("termica_y_otras", "g-otras", (n) => (/renovable/i.test(n) ? "--serie-noconv" : "--serie-termica"));

  const csv = ["fecha,hora,hidraulica_mw,termica_mw,renovable_mw,importacion_mw,exportacion_mw,produccion_total_mw,demanda_nacional_mw",
    ...curva.map((f) => [f.fecha, f.hora, f.hidraulica_mw, f.termica_mw, f.renovable_mw, f.importacion_mw,
      f.exportacion_mw, f.produccion_total_mw, f.demanda_nacional_mw].join(","))].join("\n");
  const enlace = document.getElementById("descarga-dia");
  if (enlace.href.startsWith("blob:")) URL.revokeObjectURL(enlace.href);
  enlace.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  enlace.download = `cenace_curva_${fecha}.csv`;

  const fechas = estado.resumen.map((f) => f.fecha);
  const i = fechas.indexOf(fecha);
  document.getElementById("dia-anterior").disabled = i <= 0;
  document.getElementById("dia-siguiente").disabled = i >= fechas.length - 1;
}

// ---------------------------------------------------------------- vista: serie mensual

const claveMes = (f) => `${f.anio}-${String(f.mes).padStart(2, "0")}`;
const nombreMes = (clave) => `${MESES_LARGOS[+clave.slice(5) - 1]} de ${clave.slice(0, 4)}`;
const listaMeses = (claves) => {
  const mismoAnio = claves.every((c) => c.slice(0, 4) === claves[0].slice(0, 4));
  const nombres = claves.map((c) => (mismoAnio ? MESES_LARGOS[+c.slice(5) - 1] : nombreMes(c)));
  const texto = nombres.length > 1 ? `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}` : nombres[0];
  return mismoAnio ? `${texto} de ${claves[0].slice(0, 4)}` : texto;
};
const mesCorto = (clave) => `${MESES[+clave.slice(5) - 1]} ${clave.slice(0, 4)}`;
const restarMeses = (clave, n) => {
  const total = +clave.slice(0, 4) * 12 + (+clave.slice(5) - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
};

function renderMensual() {
  const { desde, hasta } = estado.periodo;
  const filas = estado.mensual.filter((f) => claveMes(f) >= desde && claveMes(f) <= hasta);
  const noconv = (f) => ["biogas_gwh", "biomasa_gwh", "eolica_gwh", "fotovoltaica_gwh"].reduce((s, k) => s + (num(f[k]) || 0), 0);
  const x = filas.map((f) => `${f.anio}-${String(f.mes).padStart(2, "0")}-01`);
  const capas = [
    { n: "Hidroeléctrica", c: "--serie-hidro", v: (f) => num(f.hidroelectrica_gwh) },
    { n: "Térmica", c: "--serie-termica", v: (f) => num(f.termica_gwh) },
    { n: "No convencional", c: "--serie-noconv", v: noconv },
  ];
  dibujar("g-mensual", capas.map((s) => ({
    type: "scatter", mode: "lines", stackgroup: "m", name: s.n, x, y: filas.map(s.v),
    line: { width: 0.5, color: css("--superficie") }, fillcolor: css(s.c),
    hovertemplate: `${s.n}: %{y:,.1f} GWh<extra></extra>`,
  })), layoutBase({ xaxis: { ...layoutBase().xaxis, type: "date", hoverformat: "%b %Y" } }), {
    columnas: [
      { clave: "anio", titulo: "Año" }, { clave: "mes", titulo: "Mes", fmt: (v) => MESES[v - 1] },
      { clave: "hidroelectrica_gwh", titulo: "Hidroeléctrica", fmt: (v) => fmt(num(v), 1) },
      { clave: "termica_gwh", titulo: "Térmica", fmt: (v) => fmt(num(v), 1) },
      { clave: "_noconv", titulo: "No convencional", fmt: (_, f) => fmt(noconv(f), 1) },
      { clave: "total_gwh", titulo: "Total", fmt: (v) => fmt(num(v), 1) },
    ],
    filas: [...filas].reverse(),
  });

  // Hasta qué mes hay datos: siempre visible, independiente del filtro.
  const primero = claveMes(estado.mensual[0]), ultimo = claveMes(estado.mensual[estado.mensual.length - 1]);
  const hoy = new Date().toISOString().slice(0, 7);
  const pendientes = [];
  for (let m = restarMeses(hoy, 1); m > ultimo; m = restarMeses(m, 1)) pendientes.unshift(m);
  document.getElementById("aviso-mensual").innerHTML =
    `Datos oficiales disponibles de <strong>${nombreMes(primero)}</strong> a <strong>${nombreMes(ultimo)}</strong>.` +
    (pendientes.length ? ` CENACE todavía no publica ${listaMeses(pendientes)}.` : "");
  document.getElementById("periodo-mensual").textContent =
    `GWh · ${mesCorto(desde)} – ${mesCorto(hasta)}`;

  // Indicadores del período elegido, comparados con el mismo período un año antes.
  const sum = (a, k) => a.reduce((s, f) => s + (num(f[k]) || 0), 0);
  const total = sum(filas, "total_gwh");
  const previas = estado.mensual.filter((f) => claveMes(f) >= restarMeses(desde, 12) && claveMes(f) <= restarMeses(hasta, 12));
  const comparable = previas.length === filas.length && filas.length > 0;
  const variacion = comparable ? (100 * (total - sum(previas, "total_gwh"))) / sum(previas, "total_gwh") : null;
  document.getElementById("tiles-mensual").replaceChildren(
    tile("Producción del período", fmt(total, 0), "GWh",
      `${mesCorto(desde)} – ${mesCorto(hasta)} · ${filas.length} ${filas.length === 1 ? "mes" : "meses"}`),
    tile("Hidroeléctrica", pct(sum(filas, "hidroelectrica_gwh"), total), "", `${fmt(sum(filas, "hidroelectrica_gwh"), 0)} GWh`),
    tile("Térmica", pct(sum(filas, "termica_gwh"), total), "", `${fmt(sum(filas, "termica_gwh"), 0)} GWh`),
    tile("No convencional", pct(filas.reduce((s, f) => s + noconv(f), 0), total), "",
      `${fmt(filas.reduce((s, f) => s + noconv(f), 0), 0)} GWh`),
    tile("Variación interanual", variacion == null ? "—" : `${variacion >= 0 ? "+" : ""}${fmt(variacion, 1)} %`, "",
      comparable ? `vs ${mesCorto(restarMeses(desde, 12))} – ${mesCorto(restarMeses(hasta, 12))}` : "sin período previo comparable"),
  );

  // Producción anual oficial; los años con menos de 12 meses publicados se marcan como parciales.
  const mesesPorAnio = {};
  for (const f of estado.mensual) (mesesPorAnio[f.anio] ||= []).push(+f.mes);
  const anual = estado.anual.filter((f) => f.anio >= desde.slice(0, 4) && f.anio <= hasta.slice(0, 4));
  const parcial = (anio) => (mesesPorAnio[anio]?.length ?? 0) < 12;
  const rotulo = (anio) => `${MESES[Math.min(...mesesPorAnio[anio]) - 1]}–${MESES[Math.max(...mesesPorAnio[anio]) - 1]}`;
  dibujar("g-anual", [{
    type: "bar", name: "Producción", x: anual.map((f) => f.anio), y: anual.map((f) => num(f.produccion_gwh)),
    marker: { color: anual.map((f) => (parcial(f.anio) ? css("--eje") : css("--tinta-2"))) },
    text: anual.map((f) => (parcial(f.anio) && mesesPorAnio[f.anio] ? `${rotulo(f.anio)} (parcial)` : "")),
    textposition: "outside", cliponaxis: false, textfont: { color: css("--tinta-2"), size: 11 },
    customdata: anual.map((f) => (parcial(f.anio) && mesesPorAnio[f.anio] ? ` (${rotulo(f.anio)}, parcial)` : "")),
    hovertemplate: "%{x}%{customdata}: %{y:,.0f} GWh<extra></extra>",
  }], layoutBase({ showlegend: false, hovermode: "closest", margin: { l: 56, r: 12, t: 24, b: 40 },
    xaxis: { ...layoutBase().xaxis, type: "category" } }), {
    columnas: [
      { clave: "anio", titulo: "Año" },
      { clave: "produccion_gwh", titulo: "Producción (GWh)", fmt: (v) => fmt(num(v), 0) },
      { clave: "demanda_interna_gwh", titulo: "Demanda interna (GWh)", fmt: (v) => fmt(num(v), 0) },
      { clave: "exportacion_gwh", titulo: "Exportación (GWh)", fmt: (v) => fmt(num(v), 1) },
    ],
    filas: [...anual].reverse(),
  });

  renderIntercambio();
}

// Importación y exportación: acumulado de cada mes que el robot captura desde oct-2026.
// No depende del filtro de período porque la serie oficial termina antes.
function renderIntercambio() {
  const ops = estado.operativo;
  const parcial = (f) => f.completo !== "si";
  const ult = ops[ops.length - 1];
  let nota = "El robot todavía no ha capturado ningún mes.";
  if (ult) {
    const neto = num(ult.importacion_mwh) - num(ult.exportacion_mwh);
    const mes = MESES_LARGOS[ult.mes - 1];
    nota = `${mes[0].toUpperCase()}${mes.slice(1)} de ${ult.anio}` +
      (parcial(ult) ? `, acumulado hasta el día ${ult.hasta_dia}` : "") +
      `: importación ${fmt(num(ult.importacion_mwh))} MWh, exportación ${fmt(num(ult.exportacion_mwh))} MWh ` +
      `(saldo ${neto >= 0 ? "importador" : "exportador"} de ${fmt(Math.abs(neto))} MWh). ` +
      "Serie desde octubre de 2026; las barras claras son meses todavía en curso.";
  }
  document.getElementById("nota-intercambio").textContent = nota;

  const serie = (nombre, clave, color) => ({
    type: "bar", name: nombre, x: ops.map((f) => `${MESES[f.mes - 1]} ${f.anio}`), y: ops.map((f) => num(f[clave])),
    marker: { color: css(color), opacity: ops.map((f) => (parcial(f) ? 0.55 : 1)), line: { color: css("--superficie"), width: 1.5 } },
    customdata: ops.map((f) => (parcial(f) ? ` (hasta el día ${f.hasta_dia})` : "")),
    hovertemplate: `${nombre}: %{y:,.0f} MWh%{customdata}<extra></extra>`,
    text: ops.length <= 12 ? ops.map((f) => fmt(num(f[clave]))) : undefined,
    textposition: "outside", cliponaxis: false, textfont: { color: css("--tinta-2") },
  });
  dibujar("g-intercambio", ops.length ? [
    serie("Importación", "importacion_mwh", "--serie-import"),
    serie("Exportación", "exportacion_mwh", "--serie-export"),
  ] : [], layoutBase({ barmode: "group", margin: { l: 56, r: 12, t: 32, b: 40 }, xaxis: { ...layoutBase().xaxis, type: "category" } }), {
    columnas: [
      { clave: "anio", titulo: "Año" }, { clave: "mes", titulo: "Mes", fmt: (v) => MESES[v - 1] },
      { clave: "hasta_dia", titulo: "Hasta el día", fmt: (v, f) => (parcial(f) ? v : `${v} (mes completo)`) },
      { clave: "importacion_mwh", titulo: "Importación (MWh)", fmt: (v) => fmt(num(v)) },
      { clave: "exportacion_mwh", titulo: "Exportación (MWh)", fmt: (v) => fmt(num(v)) },
      { clave: "_neto", titulo: "Neto (MWh)", fmt: (_, f) => fmt(num(f.importacion_mwh) - num(f.exportacion_mwh)) },
    ],
    filas: [...ops].reverse(),
  });
}

// ---------------------------------------------------------------- vista: datos

function renderDatos() {
  const cont = document.getElementById("tabla-resumen");
  cont.replaceChildren(construirTabla({
    columnas: [
      { clave: "fecha", titulo: "Fecha" },
      { clave: "produccion_total_mwh", titulo: "Producción (MWh)", fmt: (v) => fmt(num(v)) },
      { clave: "hidraulica_mwh", titulo: "Hidráulica", fmt: (v) => fmt(num(v)) },
      { clave: "termica_mwh", titulo: "Térmica", fmt: (v) => fmt(num(v)) },
      { clave: "no_convencional_mwh", titulo: "No conv.", fmt: (v) => fmt(num(v)) },
      { clave: "importacion_mwh", titulo: "Import.", fmt: (v) => fmt(num(v)) },
      { clave: "exportacion_mwh", titulo: "Export.", fmt: (v) => fmt(num(v)) },
      { clave: "demanda_max_mw", titulo: "Dem. máx. (MW)", fmt: (v) => fmt(num(v)) },
    ],
    filas: [...estado.resumen].reverse(),
  }).firstChild);
}

// ---------------------------------------------------------------- controles

function render() {
  if (estado.vista === "diario") renderDiario();
  else if (estado.vista === "dia") renderDia();
  else if (estado.vista === "mensual") renderMensual();
  else renderDatos();
}

function fijarRango(dias) {
  const fechas = estado.resumen.map((f) => f.fecha);
  if (!fechas.length) return;
  const hasta = fechas[fechas.length - 1];
  let desde = fechas[0];
  if (dias !== "todo") {
    const d = aFecha(hasta); d.setUTCDate(d.getUTCDate() - (+dias - 1));
    desde = isoDe(d) > fechas[0] ? isoDe(d) : fechas[0];
  }
  estado.rango = { desde, hasta };
  document.getElementById("desde").value = desde;
  document.getElementById("hasta").value = hasta;
  document.querySelectorAll("#presets-diario button").forEach((b) => b.classList.toggle("activo", b.dataset.rango === String(dias)));
}

function iniciarControles() {
  document.querySelectorAll(".pestanas button").forEach((b) => b.addEventListener("click", () => {
    estado.vista = b.dataset.vista;
    document.querySelectorAll(".pestanas button").forEach((x) => {
      x.classList.toggle("activa", x === b); x.setAttribute("aria-selected", x === b);
    });
    document.querySelectorAll(".vista").forEach((v) => v.classList.toggle("activa", v.id === `vista-${estado.vista}`));
    history.replaceState(null, "", `#${estado.vista}`);
    render();
  }));

  document.querySelectorAll("#presets-diario button").forEach((b) => b.addEventListener("click", () => { fijarRango(b.dataset.rango); render(); }));
  for (const id of ["desde", "hasta"]) {
    document.getElementById(id).addEventListener("change", (e) => {
      if (!e.target.value) return;
      estado.rango[id] = e.target.value;
      document.querySelectorAll("#presets-diario button").forEach((b) => b.classList.remove("activo"));
      render();
    });
  }

  const selDia = document.getElementById("dia");
  selDia.replaceChildren(...[...estado.resumen].reverse().map((f) => el("option", { value: f.fecha }, fechaLarga(f.fecha))));
  selDia.addEventListener("change", () => { estado.dia = selDia.value; renderDia(); });
  const mover = (paso) => {
    const fechas = estado.resumen.map((f) => f.fecha);
    const i = fechas.indexOf(estado.dia) + paso;
    if (i >= 0 && i < fechas.length) { estado.dia = fechas[i]; selDia.value = estado.dia; renderDia(); }
  };
  document.getElementById("dia-anterior").addEventListener("click", () => mover(-1));
  document.getElementById("dia-siguiente").addEventListener("click", () => mover(1));

  // Serie mensual: período por mes y año, acotado a los meses publicados.
  const claves = estado.mensual.map(claveMes);
  const [primerMes, ultimoMes] = [claves[0], claves[claves.length - 1]];
  const sel = Object.fromEntries(["mes-desde", "anio-desde", "mes-hasta", "anio-hasta"].map((id) => [id, document.getElementById(id)]));
  for (const id of ["mes-desde", "mes-hasta"]) {
    sel[id].replaceChildren(...MESES_LARGOS.map((m, i) => el("option", { value: String(i + 1).padStart(2, "0") }, m)));
  }
  for (const id of ["anio-desde", "anio-hasta"]) {
    sel[id].replaceChildren(...[...new Set(estado.mensual.map((f) => f.anio))].map((a) => el("option", { value: a }, a)));
  }
  const mostrarPeriodo = () => {
    for (const lado of ["desde", "hasta"]) {
      const anio = estado.periodo[lado].slice(0, 4);
      sel[`anio-${lado}`].value = anio;
      sel[`mes-${lado}`].value = estado.periodo[lado].slice(5);
      for (const o of sel[`mes-${lado}`].options) o.disabled = `${anio}-${o.value}` < primerMes || `${anio}-${o.value}` > ultimoMes;
    }
  };
  const marcarPreset = (meses) => document.querySelectorAll("#presets-mensual button")
    .forEach((b) => b.classList.toggle("activo", b.dataset.meses === meses));
  const fijarPeriodo = (meses) => {
    const desde = meses === "todo" ? primerMes : [restarMeses(ultimoMes, +meses - 1), primerMes].sort().pop();
    estado.periodo = { desde, hasta: ultimoMes };
    marcarPreset(meses);
    mostrarPeriodo();
  };
  document.querySelectorAll("#presets-mensual button").forEach((b) => b.addEventListener("click", () => {
    fijarPeriodo(b.dataset.meses); renderMensual();
  }));
  for (const s of Object.values(sel)) {
    s.addEventListener("change", () => {
      const acotar = (c) => (c < primerMes ? primerMes : c > ultimoMes ? ultimoMes : c);
      let desde = acotar(`${sel["anio-desde"].value}-${sel["mes-desde"].value}`);
      let hasta = acotar(`${sel["anio-hasta"].value}-${sel["mes-hasta"].value}`);
      if (desde > hasta) [desde, hasta] = [hasta, desde];
      estado.periodo = { desde, hasta };
      marcarPreset(null);
      mostrarPeriodo();
      renderMensual();
    });
  }
  if (claves.length) fijarPeriodo("todo");

  document.querySelectorAll(".ver-tabla").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.grafico;
    estado.modoTabla[id] = !estado.modoTabla[id];
    b.textContent = estado.modoTabla[id] ? "Ver gráfico" : "Ver tabla";
    const nodo = document.getElementById(id);
    if (!estado.modoTabla[id]) { Plotly.purge(nodo); nodo.innerHTML = ""; nodo.style.height = ""; }
    render();
  }));

  document.getElementById("tema").addEventListener("click", () => {
    const raiz = document.documentElement;
    const oscuro = raiz.dataset.theme ? raiz.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    raiz.dataset.theme = oscuro ? "light" : "dark";
    try { localStorage.setItem("tema", raiz.dataset.theme); } catch { /* sin almacenamiento */ }
    render();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
}

// ---------------------------------------------------------------- arranque

async function cargar() {
  registrarLocale();
  try {
    const t = localStorage.getItem("tema");
    if (t) document.documentElement.dataset.theme = t;
  } catch { /* sin almacenamiento */ }

  const texto = (ruta) => fetch(ruta, { cache: "no-cache" }).then((r) => (r.ok ? r.text() : ""));
  const [resumen, curva, detalle, mensual, anual, operativo, meta] = await Promise.all([
    texto("data/diario_resumen.csv"), texto("data/diario_curva.csv"), texto("data/diario_detalle.csv"),
    texto("data/mensual_tecnologia.csv"), texto("data/anual_produccion.csv"), texto("data/mensual_operativo.csv"),
    texto("data/meta.json"),
  ]);
  Object.assign(estado, {
    resumen: resumen ? parseCSV(resumen).sort((a, b) => a.fecha.localeCompare(b.fecha)) : [],
    curva: curva ? parseCSV(curva) : [], detalle: detalle ? parseCSV(detalle) : [],
    mensual: mensual ? parseCSV(mensual) : [], anual: anual ? parseCSV(anual) : [],
    operativo: operativo ? parseCSV(operativo) : [],
    meta: meta ? JSON.parse(meta) : null,
  });

  const ult = estado.resumen[estado.resumen.length - 1];
  document.getElementById("meta-cobertura").textContent = ult
    ? `${dias(estado.resumen.length)} · último: ${fechaLarga(ult.fecha)}` : "Sin datos diarios todavía";
  if (estado.meta?.actualizado_utc) {
    document.getElementById("meta-actualizado").textContent = "Base actualizada: " +
      new Intl.DateTimeFormat("es-EC", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Guayaquil" })
        .format(new Date(estado.meta.actualizado_utc)) + " (hora de Ecuador)";
  }
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  if (m && repo) document.getElementById("enlace-repo").href = `https://github.com/${m[1]}/${repo}`;

  estado.dia = ult?.fecha;
  fijarRango("90");
  iniciarControles();
  const inicial = location.hash.slice(1);
  const boton = document.querySelector(`.pestanas button[data-vista="${inicial}"]`);
  if (boton) boton.click(); else render();
}

window.addEventListener("DOMContentLoaded", () => {
  cargar().catch((e) => {
    document.querySelector("main").prepend(el("p", { class: "vacio" }, `No se pudieron cargar los datos: ${e.message}`));
  });
});
