"""Robot de la Información Operativa Diaria del CENACE (Ecuador).

Descarga la página pública de información operativa del Operador Nacional de
Electricidad, extrae la pestaña "Información operativa diaria" (el último día
completo publicado) y la acumula en archivos CSV dentro de data/.

También actualiza la serie mensual oficial por tecnología (desde 2010) que
CENACE publica en su página de indicadores.

Solo usa la biblioteca estándar de Python 3.10+.

Uso:
    python robot/cenace.py                 # descarga y actualiza data/
    python robot/cenace.py --archivo x.htm # procesa un HTML ya descargado
    python robot/cenace.py --inseguro      # sin verificar TLS (redes con proxy que inspecciona HTTPS)
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import gzip
import json
import re
import ssl
import struct
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

RAIZ = Path(__file__).resolve().parent.parent
DATOS = RAIZ / "data"
CERT_INTERMEDIO = RAIZ / "certs" / "sectigo-dv-r36.pem"

URL_PAGINA = "https://www.cenace.gob.ec/info-operativa/InformacionOperativa.htm"
URL_INDICADORES = "https://www.cenace.gob.ec/wp-content/plugins/ez-addons/data/indicadores.xlsx"
USER_AGENT = "Mozilla/5.0 (compatible; cenace-operacion-robot/1.0)"

MESES = {
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6, "julio": 7,
    "agosto": 8, "septiembre": 9, "setiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12,
}

# Columnas fijas de cada tabla; si CENACE agrega series nuevas se añaden al final.
COLUMNAS_RESUMEN = [
    "fecha", "produccion_total_mwh", "hidraulica_mwh", "termica_mwh", "no_convencional_mwh",
    "importacion_mwh", "exportacion_mwh", "demanda_max_mw", "hora_demanda_max",
    "demanda_min_mw", "hora_demanda_min", "fuente", "capturado_utc",
]
COLUMNAS_DETALLE = ["fecha", "grupo", "nombre", "mwh"]
COLUMNAS_CURVA = [
    "fecha", "hora", "hidraulica_mw", "renovable_mw", "termica_mw", "importacion_mw",
    "exportacion_mw", "produccion_total_mw", "demanda_nacional_mw",
]
# Campos que no cuentan como "cambio de datos" al comparar una nueva captura.
CAMPOS_TRAZABILIDAD = {"fuente", "capturado_utc"}

# Etiquetas de la página (sin tildes, en mayúsculas) -> clave interna.
COMPONENTES = {
    "PRODUCCION TOTAL": "produccion_total",
    "HIDRAULICA": "hidraulica",
    "HIDROELECTRICA": "hidraulica",
    "TERMICA": "termica",
    "R. NO CONVENCIONAL": "no_convencional",
    "RENOVABLE": "no_convencional",
    "IMPORTACION": "importacion",
    "EXPORTACION": "exportacion",
}
SERIES_CURVA = {
    "HIDRAULICA": "hidraulica_mw",
    "RENOVABLE": "renovable_mw",
    "TERMICA": "termica_mw",
    "IMPORTACION": "importacion_mw",
    "EXPORTACION": "exportacion_mw",
    "PRODUCCION TOTAL": "produccion_total_mw",
    "DEMANDA NACIONAL": "demanda_nacional_mw",
}
GRUPOS_DETALLE = ["hidraulica", "termica_y_otras"]


class ErrorFormato(Exception):
    """La página no tiene la estructura esperada (CENACE cambió el formato)."""


# --------------------------------------------------------------------------- descarga

def _contexto_tls(inseguro: bool) -> ssl.SSLContext:
    if inseguro:
        return ssl._create_unverified_context()
    ctx = ssl.create_default_context()
    # El servidor de CENACE no envía el certificado intermedio de Sectigo; lo
    # agregamos para que la cadena se pueda validar hasta la raíz de confianza.
    if CERT_INTERMEDIO.exists():
        ctx.load_verify_locations(cafile=str(CERT_INTERMEDIO))
    return ctx


def descargar(url: str, inseguro: bool = False, intentos: int = 3) -> bytes:
    pedido = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    ctx = _contexto_tls(inseguro)
    for intento in range(1, intentos + 1):
        try:
            with urllib.request.urlopen(pedido, context=ctx, timeout=90) as r:
                datos = r.read()
            if datos[:2] == b"\x1f\x8b":
                datos = gzip.decompress(datos)
            return datos
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError) or intento == intentos:
                raise
            print(f"  intento {intento} falló ({e}); reintento…", file=sys.stderr)
            time.sleep(15 * intento)
    raise RuntimeError("inalcanzable")


# --------------------------------------------------------------------------- parser

def _normalizar(texto: str) -> str:
    sin_tildes = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", sin_tildes).strip().upper()


def _numero(texto: str) -> float:
    limpio = re.sub(r"[\s  ]", "", texto)
    return float(limpio)


def _decodificar(valor):
    """Plotly >= 6 guarda los arreglos numéricos como base64 ({dtype, bdata})."""
    if isinstance(valor, dict) and "bdata" in valor:
        crudo = base64.b64decode(valor["bdata"])
        fmt = {"f8": "d", "f4": "f", "i4": "i", "i2": "h", "i1": "b", "u1": "B", "u2": "H", "u4": "I"}[valor["dtype"]]
        n = len(crudo) // struct.calcsize(fmt)
        return list(struct.unpack(f"<{n}{fmt}", crudo))
    return valor


def _pestanas(pagina: str) -> list[str]:
    cortes = [m.start() for m in re.finditer(r'<div class="tab-content', pagina)]
    if not cortes:
        raise ErrorFormato("no se encontraron pestañas (div.tab-content)")
    return [pagina[a:b] for a, b in zip(cortes, cortes[1:] + [len(pagina)])]


def _graficos(segmento: str) -> list[list[dict]]:
    decodificador = json.JSONDecoder()
    graficos = []
    for m in re.finditer(r'Plotly\.newPlot\(\s*"[^"]*"\s*,\s*', segmento):
        trazas, _ = decodificador.raw_decode(segmento, m.end())
        graficos.append(trazas)
    return graficos


def _fecha_pestana(segmento: str) -> dt.date:
    m = re.search(r"(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})", segmento[:4000], re.I)
    if not m:
        raise ErrorFormato("no se encontró la fecha de la pestaña diaria")
    mes = MESES.get(_normalizar(m.group(2)).lower())
    if not mes:
        raise ErrorFormato(f"mes desconocido: {m.group(2)}")
    return dt.date(int(m.group(3)), mes, int(m.group(1)))


def _fmt(valor) -> str:
    if valor is None:
        return ""
    if isinstance(valor, float):
        return f"{valor:.4f}".rstrip("0").rstrip(".")
    return str(valor)


def extraer_diario(pagina: str, fuente: str = "cenace") -> dict:
    """Extrae la pestaña "Información operativa diaria" de la página de CENACE.

    Devuelve {"fecha", "resumen": dict, "detalle": [dict], "curva": [dict]}.
    """
    diaria = next((p for p in _pestanas(pagina) if "DIARIA" in _normalizar(re.sub(r"<[^>]+>", " ", p[:3000]))), None)
    if diaria is None:
        raise ErrorFormato("no se encontró la pestaña 'Información operativa diaria'")
    fecha = _fecha_pestana(diaria)

    # Cajas de resumen (valores redondeados que muestra la página).
    cajas = {}
    for etiqueta, valor in re.findall(r'<div class="resumen-box [^"]*">\s*<div>([^<]+)</div>\s*<div>([^<]+)</div>', diaria):
        clave = COMPONENTES.get(_normalizar(etiqueta))
        if clave:
            cajas[clave] = _numero(valor)
    if "produccion_total" not in cajas:
        raise ErrorFormato("no se encontró la caja de PRODUCCIÓN TOTAL")

    graficos = _graficos(diaria)
    torta = next((g[0] for g in graficos if g and g[0].get("type") == "pie"), None)
    barras = [g for g in graficos if g and all(t.get("type") == "bar" for t in g)]
    curva = next((g for g in graficos if g and any(t.get("stackgroup") or t.get("mode") == "lines" for t in g)), None)

    # Componentes con decimales desde el gráfico de torta; si falta, las cajas.
    componentes = {k: v for k, v in cajas.items() if k != "produccion_total"}
    if torta:
        for etiqueta, valor in zip(torta.get("labels", []), _decodificar(torta.get("values", []))):
            clave = COMPONENTES.get(_normalizar(etiqueta))
            if clave:
                componentes[clave] = float(valor)
    total = cajas["produccion_total"]
    suma = sum(componentes.get(k, 0.0) for k in ("hidraulica", "termica", "no_convencional", "importacion"))
    if abs(suma - total) <= 1.0:
        total = suma
    else:
        print(f"  aviso {fecha}: la suma de componentes ({suma:.1f}) no cuadra con el total ({total:.0f})", file=sys.stderr)

    detalle = []
    for grupo, grafico in zip(GRUPOS_DETALLE, barras):
        for traza in grafico:
            y = _decodificar(traza.get("y", []))
            if y:
                detalle.append({"fecha": fecha.isoformat(), "grupo": grupo,
                                "nombre": traza.get("name", "").strip(), "mwh": _fmt(float(y[0]))})

    filas_curva = []
    if curva:
        horas = None
        series = {}
        for traza in curva:
            horas = horas or _decodificar(traza.get("x", []))
            nombre = _normalizar(traza.get("name", ""))
            columna = SERIES_CURVA.get(nombre) or re.sub(r"[^a-z0-9]+", "_", nombre.lower()).strip("_") + "_mw"
            # En el área apilada, "Hidráulica" se dibuja neta de exportación; el
            # valor real va en customdata.
            extra = _decodificar(traza.get("customdata"))
            plano = isinstance(extra, list) and all(isinstance(v, (int, float)) or v is None for v in extra)
            series[columna] = extra if plano and extra else _decodificar(traza.get("y", []))
        for i, hora in enumerate(horas or []):
            fila = {"fecha": fecha.isoformat(), "hora": hora}
            for columna, valores in series.items():
                v = valores[i] if i < len(valores) else None
                fila[columna] = _fmt(float(v)) if v is not None else ""
            filas_curva.append(fila)

    resumen = {
        "fecha": fecha.isoformat(),
        "produccion_total_mwh": _fmt(total),
        **{f"{k}_mwh": _fmt(componentes.get(k)) for k in ("hidraulica", "termica", "no_convencional", "importacion", "exportacion")},
        "fuente": fuente,
        "capturado_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    demanda = [(f["hora"], float(f["demanda_nacional_mw"])) for f in filas_curva if f.get("demanda_nacional_mw")]
    if demanda:
        hmax, vmax = max(demanda, key=lambda x: x[1])
        hmin, vmin = min(demanda, key=lambda x: x[1])
        resumen.update(demanda_max_mw=_fmt(vmax), hora_demanda_max=hmax, demanda_min_mw=_fmt(vmin), hora_demanda_min=hmin)

    return {"fecha": fecha, "resumen": resumen, "detalle": detalle, "curva": filas_curva}


# --------------------------------------------------------------------------- almacenamiento

def _leer_csv(ruta: Path) -> tuple[list[str], list[dict]]:
    if not ruta.exists():
        return [], []
    with ruta.open(encoding="utf-8-sig", newline="") as f:
        lector = csv.DictReader(f)
        return list(lector.fieldnames or []), list(lector)


def _escribir_csv(ruta: Path, columnas: list[str], filas: list[dict]) -> None:
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with ruta.open("w", encoding="utf-8-sig", newline="") as f:
        escritor = csv.DictWriter(f, fieldnames=columnas, lineterminator="\n", extrasaction="ignore")
        escritor.writeheader()
        escritor.writerows(filas)


def _comparable(filas: list[dict]) -> list[tuple]:
    return sorted(tuple(sorted((k, v or "") for k, v in f.items() if k not in CAMPOS_TRAZABILIDAD and v)) for f in filas)


def guardar_dia(dia: dict, html: str | None = None, sobrescribir: bool = True, datos: Path = DATOS) -> str:
    """Inserta o actualiza un día en los CSV. Devuelve 'nuevo', 'actualizado' o 'sin cambios'."""
    fecha = dia["fecha"].isoformat()
    tablas = [
        ("diario_resumen.csv", COLUMNAS_RESUMEN, [dia["resumen"]]),
        ("diario_detalle.csv", COLUMNAS_DETALLE, dia["detalle"]),
        ("diario_curva.csv", COLUMNAS_CURVA, dia["curva"]),
    ]
    actuales = {nombre: _leer_csv(datos / nombre) for nombre, _, _ in tablas}
    existe = any(f.get("fecha") == fecha for f in actuales["diario_resumen.csv"][1])
    if existe and not sobrescribir:
        return "sin cambios"
    if existe and all(
        _comparable([f for f in actuales[nombre][1] if f.get("fecha") == fecha]) == _comparable(nuevas)
        for nombre, _, nuevas in tablas
    ):
        return "sin cambios"

    for nombre, base, nuevas in tablas:
        columnas, filas = actuales[nombre]
        columnas = list(dict.fromkeys(base + columnas + [c for f in nuevas for c in f]))
        filas = [f for f in filas if f.get("fecha") != fecha] + nuevas
        filas.sort(key=lambda f: (f.get("fecha", ""), f.get("hora", ""), f.get("grupo", "")))
        _escribir_csv(datos / nombre, columnas, filas)

    if html is not None:
        crudo = datos / "raw" / fecha[:4] / f"{fecha}.html.gz"
        crudo.parent.mkdir(parents=True, exist_ok=True)
        with gzip.GzipFile(crudo, "wb", mtime=0) as f:
            f.write(html.encode("utf-8"))
    return "actualizado" if existe else "nuevo"


# --------------------------------------------------------------------------- serie mensual oficial

def _leer_xlsx(contenido: bytes) -> dict[str, list[list[str]]]:
    """Lector mínimo de .xlsx (valores de celdas) sin dependencias externas."""
    import io
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rel_ns = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    z = zipfile.ZipFile(io.BytesIO(contenido))
    compartidos = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
            compartidos.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    hojas = {}
    for hoja in ET.fromstring(z.read("xl/workbook.xml")).find("m:sheets", ns):
        destino = rels[hoja.get(rel_ns)].lstrip("/")
        destino = destino if destino.startswith("xl/") else f"xl/{destino}"
        filas = []
        for fila in ET.fromstring(z.read(destino)).iter(f"{{{ns['m']}}}row"):
            valores = []
            for celda in fila.findall("m:c", ns):
                col = re.match(r"[A-Z]+", celda.get("r", "A")).group()
                idx = 0
                for letra in col:
                    idx = idx * 26 + ord(letra) - 64
                while len(valores) < idx - 1:
                    valores.append("")
                v = celda.find("m:v", ns)
                if celda.get("t") == "inlineStr":
                    texto = "".join(t.text or "" for t in celda.iter(f"{{{ns['m']}}}t"))
                elif v is None:
                    texto = ""
                elif celda.get("t") == "s":
                    texto = compartidos[int(v.text)]
                else:
                    texto = v.text or ""
                valores.append(texto.strip())
            filas.append(valores)
        hojas[hoja.get("name")] = filas
    return hojas


def _slug(texto: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", _normalizar(texto).lower()).strip("_")


def actualizar_mensual(contenido: bytes, datos: Path = DATOS) -> bool:
    """Convierte indicadores.xlsx en mensual_tecnologia.csv y anual_produccion.csv."""
    hojas = _leer_xlsx(contenido)
    cambios = False

    filas = [f for f in hojas.get("datos", []) if any(f)]
    if filas:
        cab = [_slug(c) for c in filas[0]]
        salida = []
        for f in filas[1:]:
            reg = dict(zip(cab, f))
            mes = MESES.get(_normalizar(reg.get("mes", "")).lower())
            if not reg.get("ano") or not mes:
                continue
            fila = {"anio": reg["ano"], "mes": mes}
            for c in cab:
                if c not in ("ano", "mes") and reg.get(c, "") != "":
                    fila[f"{c}_gwh"] = _fmt(float(reg[c]))
            salida.append(fila)
        columnas = ["anio", "mes"] + [f"{c}_gwh" for c in cab if c not in ("ano", "mes")]
        cambios |= _escribir_si_cambia(datos / "mensual_tecnologia.csv", columnas, salida)

    filas = [f for f in hojas.get("produccion", []) if any(f)]
    if filas:
        cab = [_slug(c) for c in filas[0]]
        nombres = {"ano": "anio", "produccion": "produccion_gwh",
                   "generacion_demanda_interna": "demanda_interna_gwh",
                   "exportacion_colombia_y_peru": "exportacion_gwh", "comentario": "comentario"}
        salida = []
        for f in filas[1:]:
            reg = dict(zip(cab, f))
            if not reg.get("ano"):
                continue
            fila = {}
            for c, v in reg.items():
                nombre = nombres.get(c, c)
                fila[nombre] = _fmt(float(v)) if nombre.endswith("_gwh") and v else v
            salida.append(fila)
        columnas = list(dict.fromkeys(nombres.get(c, c) for c in cab))
        cambios |= _escribir_si_cambia(datos / "anual_produccion.csv", columnas, salida)
    return cambios


def _escribir_si_cambia(ruta: Path, columnas: list[str], filas: list[dict]) -> bool:
    columnas_previas, previas = _leer_csv(ruta)
    if columnas_previas == columnas and previas == [{c: str(f.get(c, "")) for c in columnas} for f in filas]:
        return False
    _escribir_csv(ruta, columnas, filas)
    return True


# --------------------------------------------------------------------------- metadatos

def actualizar_meta(datos: Path = DATOS) -> None:
    _, resumen = _leer_csv(datos / "diario_resumen.csv")
    _, mensual = _leer_csv(datos / "mensual_tecnologia.csv")
    fechas = sorted(f["fecha"] for f in resumen)
    meta = {
        "actualizado_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fuente": URL_PAGINA,
        "diario": {"dias": len(fechas), "desde": fechas[0] if fechas else None, "hasta": fechas[-1] if fechas else None},
        "mensual": {
            "meses": len(mensual),
            "desde": f"{mensual[0]['anio']}-{int(mensual[0]['mes']):02d}" if mensual else None,
            "hasta": f"{mensual[-1]['anio']}-{int(mensual[-1]['mes']):02d}" if mensual else None,
        },
    }
    (datos / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- principal

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Actualiza la base de información operativa diaria del CENACE.")
    parser.add_argument("--archivo", type=Path, help="procesar un HTML local en lugar de descargar la página")
    parser.add_argument("--inseguro", action="store_true",
                        help="no verificar el certificado TLS (solo para redes con proxy que inspecciona HTTPS)")
    parser.add_argument("--sin-mensual", action="store_true", help="no actualizar la serie mensual oficial")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if args.archivo:
        html = args.archivo.read_text(encoding="utf-8")
    else:
        print(f"Descargando {URL_PAGINA}")
        html = descargar(URL_PAGINA, inseguro=args.inseguro).decode("utf-8", errors="replace")

    dia = extraer_diario(html, fuente="cenace")
    estado = guardar_dia(dia, html=html, sobrescribir=True)
    r = dia["resumen"]
    print(f"Día {dia['fecha']}: {estado} | producción {r['produccion_total_mwh']} MWh, "
          f"demanda máx. {r.get('demanda_max_mw', '?')} MW a las {r.get('hora_demanda_max', '?')} | "
          f"{len(dia['detalle'])} centrales/grupos, {len(dia['curva'])} puntos de curva")
    cambios = estado != "sin cambios"

    if not args.sin_mensual and not args.archivo:
        try:
            if actualizar_mensual(descargar(URL_INDICADORES, inseguro=args.inseguro)):
                print("Serie mensual oficial: actualizada")
                cambios = True
            else:
                print("Serie mensual oficial: sin cambios")
        except Exception as e:  # la serie mensual es complementaria; no detiene el robot
            print(f"  aviso: no se pudo actualizar la serie mensual ({e})", file=sys.stderr)

    if cambios:
        actualizar_meta()
    return 0


if __name__ == "__main__":
    sys.exit(main())
