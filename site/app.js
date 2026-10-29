/* Dashboard de consulta de la base diaria CENACE. Sin dependencias salvo Plotly. */
"use strict";

const estado = {
  resumen: [], curva: [], detalle: [], mensual: [], anual: [], operativo: [], hidro: [], meta: null,
  rango: { desde: null, hasta: null }, dia: null, periodo: { desde: null, hasta: null },
  drill: { fuente: "", central: "" },
  vista: "diario", tablas: {}, modoTabla: {},
};

const FUENTES = [
  { clave: "hidraulica", nombre: "Hidráulica", color: "--serie-hidro" },
  { clave: "termica", nombre: "Térmica", color: "--serie-termica" },
  { clave: "no_convencional", nombre: "No convencional", color: "--serie-noconv" },
  { clave: "importacion", nombre: "Importación", color: "--serie-import" },
];

// Desglose de cada fuente según diario_detalle.csv, con un color fijo por central (en orden de
// la paleta categórica) para que no cambie al filtrar. Las centrales que no estén aquí van en gris.
const DESGLOSE = {
  hidraulica: [
    ["Coca Codo", "--cat-1"], ["Paute", "--cat-2"], ["Sopladora", "--cat-3"], ["Mazar", "--cat-4"],
    ["San Francisco", "--cat-5"], ["Agoyán", "--cat-6"], ["Delsitanisagua", "--cat-7"], ["Minas San Francisco", "--cat-8"],
  ],
  termica: [["Térmica", "--cat-2"], ["Gas Natural", "--cat-3"]],
  no_convencional: [["Renovable", "--cat-3"]],
};
// En el detalle de CENACE, "Renovable" es la producción no convencional; lo demás del grupo térmico es térmica.
const fuenteDe = (d) => (d.grupo === "hidraulica" ? "hidraulica" : /renovable/i.test(d.nombre) ? "no_convencional" : "termica");

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

// Eje de fechas diario: marcas de día completo (nunca horas), unas 10 como máximo.
const ejeDias = (n) => ({ type: "date", tickformat: "%d %b", hoverformat: "%a %d %b %Y", dtick: 86400000 * Math.max(1, Math.ceil(n / 10)) });

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

// Series del nivel elegido: todas las fuentes, las centrales de una fuente o una central.
// Cada serie es { nombre, color, valores: Map(fecha -> MWh), destino: nivel al que baja al hacer clic }.
function seriesDiarias(filas) {
  const { fuente, central } = estado.drill;
  const delResumen = (clave) => new Map(filas.map((f) => [f.fecha, num(f[`${clave}_mwh`])]));
  if (!fuente) {
    return FUENTES.map((s) => ({
      nombre: s.nombre, color: s.color, valores: delResumen(s.clave), destino: DESGLOSE[s.clave] ? { fuente: s.clave, central: "" } : null,
    }));
  }
  const info = FUENTES.find((s) => s.clave === fuente);
  if (!DESGLOSE[fuente]) return [{ nombre: info.nombre, color: info.color, valores: delResumen(fuente), destino: null }];

  const fechas = new Set(filas.map((f) => f.fecha));
  const detalle = estado.detalle.filter((d) => fechas.has(d.fecha) && fuenteDe(d) === fuente);
  const sumar = (incluye) => {
    const valores = new Map();
    for (const d of detalle) if (incluye(d.nombre)) valores.set(d.fecha, (valores.get(d.fecha) || 0) + num(d.mwh));
    return valores;
  };
  const colorDe = (nombre) => DESGLOSE[fuente].find(([n]) => n === nombre)?.[1] || "--otras";
  if (central) return [{ nombre: central, color: colorDe(central), valores: sumar((n) => n === central), destino: null }];

  // Las centrales con nombre fijo conservan su color; el resto se agrupa en gris.
  const fijas = DESGLOSE[fuente].map(([n]) => n);
  const series = DESGLOSE[fuente].map(([nombre, color]) => ({
    nombre, color, valores: sumar((n) => n === nombre), destino: { fuente, central: nombre },
  }));
  const resto = [...new Set(detalle.map((d) => d.nombre).filter((n) => !fijas.includes(n)))];
  if (resto.length) {
    series.push({
      nombre: resto.length === 1 ? resto[0] : "Otras", color: "--otras", valores: sumar((n) => resto.includes(n)),
      destino: resto.length === 1 ? { fuente, central: resto[0] } : null,
    });
  }
  return series.filter((s) => s.valores.size);
}

function centralesDe(fuente) {
  const fijas = (DESGLOSE[fuente] || []).map(([n]) => n);
  const todas = [...new Set(estado.detalle.filter((d) => fuenteDe(d) === fuente).map((d) => d.nombre))];
  return [...fijas.filter((n) => todas.includes(n)), ...todas.filter((n) => !fijas.includes(n))];
}

function irA(destino) {
  estado.drill = { fuente: destino.fuente || "", central: destino.central || "" };
  sincronizarDrill();
  renderDiario();
}

function sincronizarDrill() {
  const { fuente, central } = estado.drill;
  const selFuente = document.getElementById("drill-fuente");
  const selCentral = document.getElementById("drill-central");
  selFuente.value = fuente;
  const opciones = fuente && DESGLOSE[fuente] ? centralesDe(fuente) : [];
  selCentral.replaceChildren(el("option", { value: "" }, opciones.length ? "Todas" : "—"),
    ...opciones.map((n) => el("option", { value: n }, n)));
  selCentral.disabled = !opciones.length;
  selCentral.value = central;

  // Ruta de navegación: cada nivel anterior es un botón para volver.
  const niveles = [{ texto: "Todas las fuentes", destino: {} }];
  if (fuente) niveles.push({ texto: FUENTES.find((s) => s.clave === fuente).nombre, destino: { fuente } });
  if (central) niveles.push({ texto: central, destino: { fuente, central } });
  document.getElementById("ruta-diario").replaceChildren(...niveles.flatMap((n, i) => {
    const ultimo = i === niveles.length - 1;
    const nodo = ultimo ? el("span", { "aria-current": "page" }, n.texto) : el("button", { type: "button" }, n.texto);
    if (!ultimo) nodo.addEventListener("click", () => irA(n.destino));
    return i ? [el("span", { class: "separador", "aria-hidden": "true" }, "›"), nodo] : [nodo];
  }));
}

function renderDiario() {
  const filas = filasEnRango();
  const { desde, hasta } = estado.rango;
  const { fuente, central } = estado.drill;
  const series = seriesDiarias(filas);
  const nombreFuente = FUENTES.find((s) => s.clave === fuente)?.nombre;

  // Indicadores según el nivel.
  const total = filas.reduce((s, f) => s + (num(f.produccion_total_mwh) || 0), 0);
  const suma = (k) => filas.reduce((s, f) => s + (num(f[k]) || 0), 0);
  const nDias = dias(filas.length);
  let tiles;
  if (!fuente) {
    const pico = filas.reduce((m, f) => (num(f.demanda_max_mw) > (m ? num(m.demanda_max_mw) : -1) ? f : m), null);
    const neto = suma("importacion_mwh") - suma("exportacion_mwh");
    tiles = [
      tile("Producción total", fmt(total / 1000, 1), "GWh", `${nDias} con datos`),
      tile("Hidráulica", pct(suma("hidraulica_mwh"), total), "", `${fmt(suma("hidraulica_mwh") / 1000, 1)} GWh`),
      tile("Térmica", pct(suma("termica_mwh"), total), "", `${fmt(suma("termica_mwh") / 1000, 1)} GWh`),
      tile("Demanda máxima", pico ? fmt(num(pico.demanda_max_mw)) : "—", "MW",
        pico ? `${fechaLarga(pico.fecha)}, ${pico.hora_demanda_max}` : ""),
      tile("Intercambio neto", fmt(neto), "MWh", neto >= 0 ? "importación neta" : "exportación neta"),
    ];
  } else {
    // Energía del nivel por día y totales para comparar con el nivel superior.
    const porDia = filas.map((f) => ({ fecha: f.fecha, mwh: series.reduce((s, x) => s + (x.valores.get(f.fecha) || 0), 0) }));
    const energia = porDia.reduce((s, d) => s + d.mwh, 0);
    const conDatos = porDia.filter((d) => d.mwh > 0);
    const max = conDatos.reduce((m, d) => (!m || d.mwh > m.mwh ? d : m), null);
    const min = conDatos.reduce((m, d) => (!m || d.mwh < m.mwh ? d : m), null);
    const promedio = filas.length ? energia / filas.length : 0;
    const totalFuente = suma(`${fuente}_mwh`);
    tiles = [
      tile(central ? `Producción ${central}` : nombreFuente, fmt(energia / 1000, 1), "GWh", `${nDias} con datos`),
      tile("Promedio diario", fmt(promedio), "MWh", `≈ ${fmt(promedio / 24)} MW en promedio`),
      central
        ? tile(`Participación en ${nombreFuente.toLowerCase()}`, pct(energia, totalFuente), "", `de ${fmt(totalFuente / 1000, 1)} GWh`)
        : tile("Participación en la producción", pct(energia, total), "", `de ${fmt(total / 1000, 1)} GWh`),
    ];
    if (!central && series.length > 1) {
      const principal = series.map((s) => ({ s, mwh: [...s.valores.values()].reduce((a, b) => a + b, 0) }))
        .sort((a, b) => b.mwh - a.mwh)[0];
      tiles.push(tile("Mayor aporte", principal.s.nombre, "", `${pct(principal.mwh, energia)} de ${nombreFuente.toLowerCase()}`));
    }
    const que = fuente === "importacion" ? "importación" : "producción";
    tiles.push(tile(`Día de mayor ${que}`, max ? fmt(max.mwh) : "—", "MWh", max ? fechaLarga(max.fecha) : ""));
    if (central || series.length === 1) {
      tiles.push(tile(`Día de menor ${que}`, min ? fmt(min.mwh) : "—", "MWh", min ? fechaLarga(min.fecha) : ""));
    }
  }
  document.getElementById("tiles-diario").replaceChildren(...tiles);

  const titulos = {
    "": "Producción diaria por fuente",
    hidraulica: "Producción hidroeléctrica diaria por central",
    termica: "Producción térmica diaria por tipo",
    no_convencional: "Producción no convencional diaria",
    importacion: "Importación diaria",
  };
  document.getElementById("titulo-produccion").textContent = central ? `${central}: producción diaria` : titulos[fuente];
  const clicable = series.some((s) => s.destino);
  document.getElementById("pista-produccion").textContent = clicable
    ? "Haz clic en una barra para ver su detalle." : "";

  const completa = filas.length ? serieCompleta(filas, desde, hasta) : [];
  const x = completa.map((f) => f.fecha);
  // Con rangos largos cada barra mide pocos píxeles: sin separador para que no desaparezca.
  const nodo = document.getElementById("g-produccion");
  const pxPorDia = (nodo.clientWidth - 70) / Math.max(completa.length, 1);
  const separador = pxPorDia >= 8 ? 1.5 : 0;
  const trazas = series.map((s) => ({
    type: "bar", name: s.nombre, x,
    y: completa.map((f) => (f._vacio ? null : s.valores.get(f.fecha) ?? null)),
    marker: { color: css(s.color), line: { color: css("--superficie"), width: separador } },
    hovertemplate: `${s.nombre}: %{y:,.0f} MWh<extra></extra>`,
  }));
  dibujar("g-produccion", trazas, layoutBase({
    barmode: "stack", showlegend: series.length > 1, xaxis: { ...layoutBase().xaxis, ...ejeDias(completa.length) },
  }), {
    columnas: [
      { clave: "fecha", titulo: "Fecha" },
      ...series.map((s, i) => ({ clave: `s${i}`, titulo: `${s.nombre} (MWh)`, fmt: (v) => fmt(v) })),
      ...(series.length > 1 ? [{ clave: "total", titulo: "Total (MWh)", fmt: (v) => fmt(v) }] : []),
    ],
    filas: [...filas].reverse().map((f) => {
      const fila = { fecha: f.fecha };
      series.forEach((s, i) => { fila[`s${i}`] = s.valores.get(f.fecha) ?? null; });
      fila.total = series.reduce((t, s) => t + (s.valores.get(f.fecha) || 0), 0);
      return fila;
    }),
  });
  // Clic en una barra: bajar al detalle de esa serie.
  if (nodo.on) {
    nodo.removeAllListeners?.("plotly_click");
    nodo.on("plotly_click", (ev) => {
      const destino = series.find((s) => s.nombre === ev.points?.[0]?.data?.name)?.destino;
      if (destino) irA(destino);
    });
  }

  dibujar("g-demanda", [{
    type: "scatter", mode: "lines+markers", name: "Demanda máxima", x,
    y: completa.map((f) => (f._vacio ? null : num(f.demanda_max_mw))),
    customdata: completa.map((f) => f.hora_demanda_max || ""),
    line: { color: css("--tinta"), width: 2 }, marker: { size: 8, color: css("--tinta"), line: { color: css("--superficie"), width: 2 } },
    connectgaps: false, hovertemplate: "Demanda máxima: %{y:,.0f} MW a las %{customdata}<extra></extra>",
  }], layoutBase({ showlegend: false, yaxis: { ...layoutBase().yaxis, rangemode: "normal" }, xaxis: { ...layoutBase().xaxis, ...ejeDias(completa.length) } }), {
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

// ---------------------------------------------------------------- vista: alerta temprana

// Años de racionamientos y apagones; los demás años anteriores al actual son la referencia normal.
const ANIOS_CRISIS = ["2023", "2024"];
const ESTADOS = {
  normal: { texto: "Normal", icono: "✓" },
  vigilancia: { texto: "Vigilancia", icono: "!" },
  alerta: { texto: "Alerta", icono: "✕" },
};

const sumarDias = (iso, n) => { const d = aFecha(iso); d.setUTCDate(d.getUTCDate() + n); return isoDe(d); };
const esBisiesto = (a) => (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;
// El mismo día y mes en otro año (el 29 de febrero cae al 28 en años no bisiestos).
const mismaFecha = (iso, anio) => `${anio}-${iso.slice(5) === "02-29" && !esBisiesto(+anio) ? "02-28" : iso.slice(5)}`;
const fechaCorta = (iso) => new Intl.DateTimeFormat("es-EC", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(aFecha(iso));

function mediaVentana(porFecha, fin, dias, col) {
  const valores = [];
  for (let i = 0; i < dias; i++) {
    const v = num(porFecha.get(sumarDias(fin, -i))?.[col]);
    if (v != null) valores.push(v);
  }
  return valores.length >= dias / 2 ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
}

// Compara un valor con la misma fecha en años de crisis y normales. Solo hay vigilancia o alerta si
// el valor es claramente peor que todos los años normales (más allá de la holgura); es alerta si
// además es igual o peor que algún año de crisis. `seguro` es un valor que nunca alarma (embalse casi lleno).
function clasificar(valor, refs, { mayorEsMejor = true, holgura = 0, relativa = false, seguro = null } = {}) {
  const crisis = refs.filter((r) => ANIOS_CRISIS.includes(r.anio) && r.valor != null).map((r) => r.valor);
  const normales = refs.filter((r) => !ANIOS_CRISIS.includes(r.anio) && r.valor != null).map((r) => r.valor);
  if (valor == null || !crisis.length || !normales.length) return null;
  if (seguro != null && (mayorEsMejor ? valor >= seguro : valor <= seguro)) return "normal";
  const s = mayorEsMejor ? 1 : -1; // se evalúa como "más alto es mejor"
  const peorNormal = mayorEsMejor ? Math.min(...normales) : Math.max(...normales);
  const umbral = peorNormal - s * (relativa ? Math.abs(peorNormal) * holgura : holgura);
  if (s * valor >= s * umbral) return "normal";
  const mejorCrisis = mayorEsMejor ? Math.max(...crisis) : Math.min(...crisis);
  return s * valor <= s * mejorCrisis ? "alerta" : "vigilancia";
}
// Calibración (ver la metodología en la página): cota con 1 m de holgura y sin alarma a menos de 5 m
// del máximo histórico; caudales con 10 % de holgura; térmica con 1 punto porcentual.
const REGLA_COTA = { holgura: 1 };
const REGLA_CAUDAL = { holgura: 0.1, relativa: true };
const REGLA_TERMICA = { mayorEsMejor: false, holgura: 0.01 };

const promedio = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const difTexto = (d, ref, unidad, dec = 1) => `${fmt(Math.abs(d), dec)} ${unidad} ${d >= 0 ? "sobre" : "bajo"} ${ref}`;

function tileEstado(ind) {
  const e = ESTADOS[ind.estado];
  const nodo = tile(ind.titulo, ind.valor, ind.unidad, ind.detalle);
  nodo.classList.add("estado");
  if (e) {
    nodo.classList.add(ind.estado);
    nodo.append(el("div", { class: "estado-etiqueta" },
      el("span", { class: `insignia ${ind.estado}`, "aria-hidden": "true" }, e.icono), e.texto));
  } else {
    nodo.append(el("div", { class: "estado-etiqueta" }, "Sin datos suficientes"));
  }
  nodo.append(el("div", { class: "detalle" }, ind.fecha ? `Dato al ${fechaCorta(ind.fecha)}` : ""));
  return nodo;
}

function indicadoresAlerta() {
  const hidro = estado.hidro;
  const porFecha = new Map(hidro.map((f) => [f.fecha, f]));
  const ultimaCon = (col) => [...hidro].reverse().find((f) => num(f[col]) != null)?.fecha;
  const anios = [...new Set(hidro.map((f) => f.fecha.slice(0, 4)))];
  const refsDe = (fecha, valorEn) => anios.filter((a) => a < fecha.slice(0, 4))
    .map((a) => ({ anio: a, valor: valorEn(mismaFecha(fecha, a)) }));
  const normalesDe = (refs) => promedio(refs.filter((r) => !ANIOS_CRISIS.includes(r.anio) && r.valor != null).map((r) => r.valor));
  const de = (refs, anio) => refs.find((r) => r.anio === anio)?.valor;
  const out = {};

  // 1. Nivel de Mazar
  const fC = ultimaCon("mazar_cota_msnm");
  if (fC) {
    const v = num(porFecha.get(fC).mazar_cota_msnm);
    const refs = refsDe(fC, (d) => num(porFecha.get(d)?.mazar_cota_msnm));
    const parecido = refs.filter((r) => r.valor != null).sort((a, b) => Math.abs(a.valor - v) - Math.abs(b.valor - v))[0];
    const maxHistorico = Math.max(...hidro.map((f) => num(f.mazar_cota_msnm)).filter((x) => x != null));
    out.cota = {
      titulo: "Nivel de Mazar", valor: fmt(v, 1), unidad: "msnm", fecha: fC, parecido,
      estado: clasificar(v, refs, { ...REGLA_COTA, seguro: maxHistorico - 5 }),
      detalle: [de(refs, "2024") != null ? difTexto(v - de(refs, "2024"), "2024", "m") : "",
        normalesDe(refs) != null ? difTexto(v - normalesDe(refs), "años normales", "m") : ""].filter(Boolean).join(" · "),
    };

    // 3. Tendencia: días hasta el mínimo de los años de crisis al ritmo de los últimos 14 días.
    const minimo = hidro.filter((f) => ANIOS_CRISIS.includes(f.fecha.slice(0, 4)) && num(f.mazar_cota_msnm) != null)
      .reduce((m, f) => (!m || num(f.mazar_cota_msnm) < num(m.mazar_cota_msnm) ? f : m), null);
    const antes = num(porFecha.get(sumarDias(fC, -14))?.mazar_cota_msnm);
    if (minimo && antes != null) {
      const cotaMin = num(minimo.mazar_cota_msnm);
      const delta = v - antes;
      const ritmo = -delta / 14;
      const diasRestantes = ritmo > 0 ? (v - cotaMin) / ritmo : null;
      const est = v <= cotaMin ? "alerta" : diasRestantes == null ? "normal" : diasRestantes < 30 ? "alerta" : diasRestantes < 90 ? "vigilancia" : "normal";
      out.tendencia = {
        titulo: "Tendencia de Mazar (14 días)", valor: `${delta >= 0 ? "+" : "−"}${fmt(Math.abs(delta), 1)}`, unidad: "m", fecha: fC, estado: est,
        minimo: { fecha: minimo.fecha, cota: cotaMin },
        detalle: diasRestantes == null ? "El embalse está subiendo o estable."
          : `A este ritmo llegaría al mínimo de ${fechaCorta(minimo.fecha)} (${fmt(cotaMin, 1)}) en unos ${fmt(diasRestantes)} días.`,
      };
    }
  }

  // 2 y 4. Caudales: media de 14 días frente a la misma ventana de otros años.
  const caudal = (col, titulo) => {
    const f = ultimaCon(col);
    if (!f) return null;
    const v = mediaVentana(porFecha, f, 14, col);
    const refs = refsDe(f, (d) => mediaVentana(porFecha, d, 14, col));
    return {
      titulo, valor: fmt(v), unidad: "m³/s", fecha: f, estado: clasificar(v, refs, REGLA_CAUDAL),
      detalle: [de(refs, "2024") != null ? `2024: ${fmt(de(refs, "2024"))}` : "",
        normalesDe(refs) != null ? `años normales: ${fmt(normalesDe(refs))}` : ""].filter(Boolean).join(" · ") + " (media de 14 días)",
    };
  };
  out.caudal = caudal("mazar_caudal_m3s", "Caudal de entrada a Mazar");
  out.coca = caudal("coca_caudal_m3s", "Caudal del río Coca");

  // 5. Dependencia térmica del mes en curso frente al mismo mes de otros años.
  const op = estado.operativo[estado.operativo.length - 1];
  if (op) {
    const v = num(op.termica_mwh) / num(op.produccion_total_mwh);
    const refs = anios.filter((a) => a < op.anio).map((a) => {
      const m = estado.mensual.find((x) => x.anio === a && +x.mes === +op.mes);
      return { anio: a, valor: m ? num(m.termica_gwh) / num(m.total_gwh) : null };
    });
    const normales = refs.filter((r) => !ANIOS_CRISIS.includes(r.anio) && r.valor != null).map((r) => r.valor);
    out.termica = {
      titulo: "Dependencia térmica", valor: fmt(100 * v, 1), unidad: "%",
      fecha: `${op.anio}-${String(op.mes).padStart(2, "0")}-${String(op.hasta_dia).padStart(2, "0")}`,
      estado: clasificar(v, refs, REGLA_TERMICA),
      detalle: [...ANIOS_CRISIS.filter((a) => de(refs, a) != null).map((a) => `${MESES[op.mes - 1]} ${a}: ${fmt(100 * de(refs, a))} %`),
        normales.length ? `años normales: ${fmt(100 * Math.min(...normales))}–${fmt(100 * Math.max(...normales))} %` : ""].filter(Boolean).join(" · "),
    };
  }
  return out;
}

function renderAlerta() {
  if (!estado.hidro.length) {
    document.getElementById("estado-general").replaceChildren(el("p", {}, "No hay datos de hidrología todavía."));
    return;
  }
  const ind = indicadoresAlerta();
  const lista = [ind.cota, ind.tendencia, ind.caudal, ind.coca, ind.termica].filter(Boolean);
  const cuenta = (e) => lista.filter((i) => i.estado === e).length;
  const general = ind.cota?.estado === "alerta" || cuenta("alerta") >= 2 ? "alerta"
    : cuenta("alerta") >= 1 || cuenta("vigilancia") >= 2 ? "vigilancia" : "normal";
  const partes = [["alerta", "en alerta", "en alerta"], ["vigilancia", "en vigilancia", "en vigilancia"], ["normal", "normal", "normales"]]
    .filter(([e]) => cuenta(e)).map(([e, uno, varios]) => `${cuenta(e)} ${cuenta(e) === 1 ? uno : varios}`);
  const parecido = ind.cota?.parecido;
  document.getElementById("estado-general").className = `estado-general ${general}`;
  document.getElementById("estado-general").replaceChildren(
    el("span", { class: `insignia ${general}`, "aria-hidden": "true" }, ESTADOS[general].icono),
    el("div", {},
      el("h2", {}, `Estado general: ${ESTADOS[general].texto}`),
      el("p", {}, `De ${lista.length} indicadores: ${partes.join(", ")}.` +
        (parecido ? ` En esta fecha, la cota de Mazar se parece más a la de ${parecido.anio} (${fmt(parecido.valor, 1)} msnm).` : ""))),
  );
  document.getElementById("tiles-alerta").replaceChildren(...lista.map(tileEstado));

  // Gráficos por día del año: cada año es una línea; crisis en color, actual en tinta, el resto en gris.
  const hidro = estado.hidro;
  const porFecha = new Map(hidro.map((f) => [f.fecha, f]));
  const actual = hidro[hidro.length - 1].fecha.slice(0, 4);
  const estilo = (a) => (a === actual ? { color: css("--tinta"), width: 3, rango: 1 }
    : a === "2024" ? { color: css("--cat-2"), width: 2, rango: 2 }
    : a === "2023" ? { color: css("--cat-7"), width: 2, rango: 3 }
    : { color: css("--otras"), width: 1.2, rango: 10 });
  const ejeAnio = { ...layoutBase().xaxis, type: "date", tickformat: "%b", hoverformat: "%d %b", range: ["2000-01-01", "2000-12-31"], dtick: "M1" };
  const porAnio = (col, valor) => [...new Set(hidro.filter((f) => num(f[col]) != null).map((f) => f.fecha.slice(0, 4)))]
    .sort((a, b) => estilo(b).rango - estilo(a).rango)
    .map((a) => {
      const filas = hidro.filter((f) => f.fecha.startsWith(a) && num(f[col]) != null);
      const s = estilo(a);
      return {
        type: "scatter", mode: "lines", name: a, legendrank: s.rango, x: filas.map((f) => `2000-${f.fecha.slice(5)}`),
        y: filas.map(valor), line: { color: s.color, width: s.width }, connectgaps: false,
      };
    });
  const tablaReciente = (cols) => {
    const ultima = hidro[hidro.length - 1].fecha;
    const filas = [];
    for (let i = 0; i < 30; i++) filas.push(porFecha.get(sumarDias(ultima, -i)) || { fecha: sumarDias(ultima, -i) });
    return { columnas: [{ clave: "fecha", titulo: "Fecha" }, ...cols], filas };
  };

  const cota = porAnio("mazar_cota_msnm", (f) => num(f.mazar_cota_msnm));
  cota.forEach((t) => { t.hovertemplate = `${t.name}: %{y:,.1f} msnm<extra></extra>`; });
  const minimo = ind.tendencia?.minimo;
  dibujar("g-cota", cota, layoutBase({
    xaxis: ejeAnio, yaxis: { ...layoutBase().yaxis, rangemode: "normal", tickformat: ",~r" },
    shapes: minimo ? [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: minimo.cota, y1: minimo.cota, line: { color: css("--tinta-2"), width: 1 } }] : [],
    annotations: minimo ? [{ xref: "paper", x: 0.01, y: minimo.cota, yanchor: "bottom", xanchor: "left", showarrow: false,
      text: `Mínimo de ${fechaCorta(minimo.fecha)}: ${fmt(minimo.cota, 1)}`, font: { color: css("--tinta-2"), size: 11 } }] : [],
  }), tablaReciente([
    { clave: "mazar_cota_msnm", titulo: `Cota ${actual} (msnm)`, fmt: (v) => fmt(num(v), 2) },
    ...ANIOS_CRISIS.map((a) => ({ clave: `_${a}`, titulo: `Misma fecha ${a}`, fmt: (_, f) => fmt(num(porFecha.get(mismaFecha(f.fecha, a))?.mazar_cota_msnm), 2) })),
  ]));

  const media7 = (col) => (f) => mediaVentana(porFecha, f.fecha, 7, col);
  const caudal = porAnio("mazar_caudal_m3s", media7("mazar_caudal_m3s"));
  caudal.forEach((t) => { t.hovertemplate = `${t.name}: %{y:,.0f} m³/s<extra></extra>`; });
  dibujar("g-caudal", caudal, layoutBase({
    xaxis: ejeAnio, yaxis: { ...layoutBase().yaxis, type: "log", tickvals: [5, 10, 20, 50, 100, 200, 500], rangemode: "normal" },
  }), tablaReciente([
    { clave: "mazar_caudal_m3s", titulo: `Caudal ${actual} (m³/s)`, fmt: (v) => fmt(num(v), 1) },
    ...ANIOS_CRISIS.map((a) => ({ clave: `_${a}`, titulo: `Misma fecha ${a}`, fmt: (_, f) => fmt(num(porFecha.get(mismaFecha(f.fecha, a))?.mazar_caudal_m3s), 1) })),
  ]));

  const coca = porAnio("coca_caudal_m3s", media7("coca_caudal_m3s"));
  coca.forEach((t) => { t.hovertemplate = `${t.name}: %{y:,.0f} m³/s<extra></extra>`; });
  dibujar("g-coca", coca, layoutBase({ xaxis: ejeAnio, yaxis: { ...layoutBase().yaxis, rangemode: "tozero" } }), tablaReciente([
    { clave: "coca_caudal_m3s", titulo: `Río Coca ${actual} (m³/s)`, fmt: (v) => fmt(num(v), 1) },
    { clave: "_2024", titulo: "Misma fecha 2024", fmt: (_, f) => fmt(num(porFecha.get(mismaFecha(f.fecha, "2024"))?.coca_caudal_m3s), 1) },
  ]));

  // Participación térmica mensual oficial + mes en curso; franja de la crisis 2023–2024.
  const meses = estado.mensual.filter((m) => +m.anio >= 2019);
  const op = estado.operativo[estado.operativo.length - 1];
  const trazasTermica = [{
    type: "scatter", mode: "lines", name: "Mensual oficial", x: meses.map((m) => `${claveMes(m)}-01`),
    y: meses.map((m) => (100 * num(m.termica_gwh)) / num(m.total_gwh)), line: { color: css("--serie-termica"), width: 2 },
    hovertemplate: "%{x|%b %Y}: %{y:,.1f} %<extra></extra>",
  }];
  if (op) {
    trazasTermica.push({
      type: "scatter", mode: "markers+text", name: "Mes en curso", x: [`${op.anio}-${String(op.mes).padStart(2, "0")}-01`],
      y: [(100 * num(op.termica_mwh)) / num(op.produccion_total_mwh)],
      marker: { size: 10, color: css("--tinta"), line: { color: css("--superficie"), width: 2 } },
      text: [`${MESES[op.mes - 1]} ${op.anio} (al día ${op.hasta_dia})`], textposition: "top left", textfont: { color: css("--tinta-2"), size: 11 },
      hovertemplate: `${MESES[op.mes - 1]} ${op.anio}, al día ${op.hasta_dia}: %{y:,.1f} %<extra></extra>`,
    });
  }
  dibujar("g-termica", trazasTermica, layoutBase({
    hovermode: "closest", xaxis: { ...layoutBase().xaxis, type: "date", tickformat: "%Y", dtick: "M12" },
    yaxis: { ...layoutBase().yaxis, ticksuffix: " %" },
    shapes: [{ type: "rect", xref: "x", yref: "paper", x0: "2023-09-15", x1: "2024-12-31", y0: 0, y1: 1, fillcolor: css("--otras"), opacity: 0.25, line: { width: 0 }, layer: "below" }],
    annotations: [{ xref: "x", yref: "paper", x: "2024-05-01", y: 1, yanchor: "bottom", showarrow: false, text: "Crisis 2023–2024", font: { color: css("--tinta-2"), size: 11 } }],
  }), {
    columnas: [{ clave: "anio", titulo: "Año" }, { clave: "mes", titulo: "Mes", fmt: (v) => MESES[v - 1] },
      { clave: "_t", titulo: "Térmica (%)", fmt: (_, m) => fmt((100 * num(m.termica_gwh)) / num(m.total_gwh), 1) }],
    filas: [...meses].reverse(),
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
  else if (estado.vista === "alerta") renderAlerta();
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

  // Drilldown de la serie diaria: fuente → central.
  const selFuente = document.getElementById("drill-fuente");
  selFuente.replaceChildren(el("option", { value: "" }, "Todas"), ...FUENTES.map((s) => el("option", { value: s.clave }, s.nombre)));
  selFuente.addEventListener("change", () => irA({ fuente: selFuente.value }));
  document.getElementById("drill-central").addEventListener("change", (e) => irA({ fuente: estado.drill.fuente, central: e.target.value }));
  sincronizarDrill();

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
  const [resumen, curva, detalle, mensual, anual, operativo, hidro, meta] = await Promise.all([
    texto("data/diario_resumen.csv"), texto("data/diario_curva.csv"), texto("data/diario_detalle.csv"),
    texto("data/mensual_tecnologia.csv"), texto("data/anual_produccion.csv"), texto("data/mensual_operativo.csv"),
    texto("data/hidrologia.csv"), texto("data/meta.json"),
  ]);
  Object.assign(estado, {
    resumen: resumen ? parseCSV(resumen).sort((a, b) => a.fecha.localeCompare(b.fecha)) : [],
    curva: curva ? parseCSV(curva) : [], detalle: detalle ? parseCSV(detalle) : [],
    mensual: mensual ? parseCSV(mensual) : [], anual: anual ? parseCSV(anual) : [],
    operativo: operativo ? parseCSV(operativo) : [],
    hidro: hidro ? parseCSV(hidro).sort((a, b) => a.fecha.localeCompare(b.fecha)) : [],
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
