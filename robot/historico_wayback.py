"""Recupera días anteriores desde las copias de la página en Internet Archive.

CENACE no publica un histórico diario; Internet Archive guardó la página en
fechas sueltas. Este script toma cada copia con el formato actual (Plotly),
extrae su pestaña diaria y la agrega a data/ sin pisar días ya capturados
directamente de CENACE.

Uso:  python robot/historico_wayback.py [--desde 2025]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request

import cenace

CDX = ("https://web.archive.org/cdx/search/cdx?url=cenace.gob.ec/info-operativa/InformacionOperativa.htm"
       "&output=json&fl=timestamp,statuscode&filter=statuscode:200&collapse=timestamp:8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--desde", default="2025", help="año (o AAAAMMDD) desde el que buscar copias")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    with urllib.request.urlopen(CDX, timeout=90) as r:
        capturas = [fila[0] for fila in json.load(r)[1:] if fila[0] >= args.desde]
    print(f"{len(capturas)} copias en Internet Archive desde {args.desde}")

    agregados = 0
    for ts in capturas:
        url = f"https://web.archive.org/web/{ts}id_/https://www.cenace.gob.ec/info-operativa/InformacionOperativa.htm"
        try:
            html = cenace.descargar(url).decode("utf-8", errors="replace")
            dia = cenace.extraer_diario(html, fuente=f"wayback:{ts}")
        except cenace.ErrorFormato as e:
            print(f"  {ts}: formato antiguo o incompleto ({e})")
            continue
        except Exception as e:
            print(f"  {ts}: error al descargar ({e})")
            continue
        estado = cenace.guardar_dia(dia, html=html, sobrescribir=False)
        agregados += estado == "nuevo"
        print(f"  {ts}: día {dia['fecha']} -> {estado}")
        time.sleep(2)  # ser amable con Internet Archive

    if agregados:
        cenace.actualizar_meta()
    print(f"Días agregados: {agregados}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
