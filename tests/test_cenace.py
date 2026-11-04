"""Pruebas del parser con una captura real de la página (27-oct-2026).

Ejecutar desde la raíz del repo:  python -m unittest discover -s tests
"""

import datetime as dt
import gzip
import sys
import tempfile
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "robot"))

import cenace  # noqa: E402

FIXTURE = RAIZ / "tests" / "fixtures" / "InformacionOperativa_2026-10-27.html"


class TestExtraerDiario(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = FIXTURE.read_text(encoding="utf-8")
        cls.dia = cenace.extraer_diario(cls.html)

    def test_fecha(self):
        self.assertEqual(self.dia["fecha"], dt.date(2026, 10, 25))

    def test_resumen_cuadra_con_la_pagina(self):
        r = self.dia["resumen"]
        self.assertAlmostEqual(float(r["produccion_total_mwh"]), 92835, delta=1)
        self.assertAlmostEqual(float(r["hidraulica_mwh"]), 64498.6, places=1)
        self.assertAlmostEqual(float(r["termica_mwh"]), 27454.5475, places=3)
        self.assertAlmostEqual(float(r["no_convencional_mwh"]), 757.7475, places=3)
        self.assertAlmostEqual(float(r["importacion_mwh"]), 124.24, places=2)
        self.assertAlmostEqual(float(r["exportacion_mwh"]), 109.2, places=1)

    def test_detalle(self):
        hidro = {d["nombre"]: float(d["mwh"]) for d in self.dia["detalle"] if d["grupo"] == "hidraulica"}
        otras = {d["nombre"]: float(d["mwh"]) for d in self.dia["detalle"] if d["grupo"] == "termica_y_otras"}
        self.assertEqual(hidro["Coca Codo"], 24449)
        self.assertIn("Agoyán", hidro)  # se recorta el espacio final del nombre original
        self.assertEqual(len(hidro), 9)
        self.assertEqual(otras, {"Térmica": 24757, "Gas Natural": 2697, "Renovable": 758})

    def test_curva(self):
        curva = self.dia["curva"]
        self.assertEqual(len(curva), 48)
        primera = curva[0]
        self.assertEqual(primera["hora"], "00:00")
        # La hidráulica real sale de customdata, no del área apilada (neta de exportación).
        self.assertAlmostEqual(float(primera["hidraulica_mw"]), 2539.5, places=2)
        suma = sum(float(primera[c]) for c in ("hidraulica_mw", "renovable_mw", "termica_mw", "importacion_mw"))
        self.assertAlmostEqual(suma, float(primera["produccion_total_mw"]), places=1)

    def test_demanda_maxima(self):
        r = self.dia["resumen"]
        maximo = max(float(f["demanda_nacional_mw"]) for f in self.dia["curva"])
        self.assertEqual(float(r["demanda_max_mw"]), maximo)
        self.assertRegex(r["hora_demanda_max"], r"^\d\d:\d\d$")


class TestExtraerMensual(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mes = cenace.extraer_mensual(FIXTURE.read_text(encoding="utf-8"))

    def test_periodo(self):
        self.assertEqual((self.mes["anio"], self.mes["mes"], self.mes["hasta_dia"]), (2026, 10, 25))
        self.assertEqual(self.mes["completo"], "no")

    def test_intercambio_y_produccion(self):
        self.assertAlmostEqual(float(self.mes["importacion_mwh"]), 3129.66, places=2)
        self.assertAlmostEqual(float(self.mes["exportacion_mwh"]), 2072.4, places=1)
        self.assertAlmostEqual(float(self.mes["produccion_total_mwh"]), 2414299, delta=1)

    def test_demanda_maxima_del_mes(self):
        self.assertEqual(self.mes["fecha_demanda_max"], "2026-10-06")
        self.assertAlmostEqual(float(self.mes["demanda_max_mw"]), 5268.38, places=2)

    def test_guardar_no_retrocede(self):
        with tempfile.TemporaryDirectory() as tmp:
            datos = Path(tmp)
            self.assertEqual(cenace.guardar_mes(self.mes, datos=datos), "nuevo")
            self.assertEqual(cenace.guardar_mes(self.mes, datos=datos), "sin cambios")
            avanzado = {**self.mes, "hasta_dia": 26, "importacion_mwh": "3200"}
            self.assertEqual(cenace.guardar_mes(avanzado, datos=datos), "actualizado")
            self.assertEqual(cenace.guardar_mes(self.mes, datos=datos), "sin cambios")  # día 25 < 26
            _, filas = cenace._leer_csv(datos / "mensual_operativo.csv")
            self.assertEqual([(f["hasta_dia"], f["importacion_mwh"]) for f in filas], [("26", "3200")])


class TestHuecos(unittest.TestCase):
    """Días que CENACE se salta en la pestaña diaria, con páginas reales de oct-nov 2026."""

    @staticmethod
    def pagina(fecha):
        with gzip.open(RAIZ / "tests" / "fixtures" / "paginas" / f"{fecha}.html.gz", "rt", encoding="utf-8") as f:
            return f.read()

    def preparar(self, datos, *fechas):
        for fecha in fechas:
            html = self.pagina(fecha)
            cenace.guardar_dia(cenace.extraer_diario(html), html=html, datos=datos)
            cenace.guardar_mes(cenace.extraer_mensual(html), datos=datos)

    def test_acumulado_anual(self):
        acum = cenace._acumulado_anual(FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(acum["fecha"], dt.date(2026, 10, 25))
        self.assertAlmostEqual(acum["produccion_total"], 30489000, delta=1000)

    def test_hueco_coincide_con_el_dia_conocido(self):
        # Se omite el 28-oct, que sí se conoce: la cuenta debe dar exactamente ese día.
        with tempfile.TemporaryDirectory() as tmp:
            datos = Path(tmp)
            self.preparar(datos, "2026-10-27", "2026-10-29")
            self.assertTrue(cenace.actualizar_huecos(datos=datos))
            _, huecos = cenace._leer_csv(datos / "diario_huecos.csv")
            self.assertEqual([(h["desde"], h["hasta"], h["dias"]) for h in huecos], [("2026-10-28", "2026-10-28", "1")])
            dia = cenace.extraer_diario(self.pagina("2026-10-28"))["resumen"]
            for k in ("produccion_total_mwh", "hidraulica_mwh", "termica_mwh", "importacion_mwh", "exportacion_mwh"):
                self.assertAlmostEqual(float(huecos[0][k]), float(dia[k]), delta=0.5)

    def test_salto_de_mes_cierra_el_mes_anterior(self):
        with tempfile.TemporaryDirectory() as tmp:
            datos = Path(tmp)
            self.preparar(datos, "2026-10-29", "2026-11-01")
            acumulado_29 = cenace.extraer_mensual(self.pagina("2026-10-29"))
            self.assertTrue(cenace.actualizar_huecos(datos=datos))
            self.assertFalse(cenace.actualizar_huecos(datos=datos))  # idempotente
            _, huecos = cenace._leer_csv(datos / "diario_huecos.csv")
            self.assertEqual((huecos[0]["desde"], huecos[0]["hasta"], huecos[0]["dias"]), ("2026-10-30", "2026-10-31", "2"))
            _, meses = cenace._leer_csv(datos / "mensual_operativo.csv")
            octubre, noviembre = meses
            self.assertEqual((octubre["hasta_dia"], octubre["completo"], octubre["origen"]), ("31", "si", cenace.METODO_ACUMULADO))
            self.assertAlmostEqual(float(octubre["produccion_total_mwh"]),
                                   float(acumulado_29["produccion_total_mwh"]) + float(huecos[0]["produccion_total_mwh"]), delta=0.5)
            self.assertAlmostEqual(float(octubre["importacion_mwh"]),
                                   float(acumulado_29["importacion_mwh"]) + float(huecos[0]["importacion_mwh"]), delta=0.5)
            self.assertEqual((noviembre["mes"], noviembre["hasta_dia"], noviembre["completo"]), ("11", "1", "no"))

    def test_sin_saltos_no_hay_huecos(self):
        with tempfile.TemporaryDirectory() as tmp:
            datos = Path(tmp)
            self.preparar(datos, "2026-10-27", "2026-10-28")
            cenace.actualizar_huecos(datos=datos)
            _, huecos = cenace._leer_csv(datos / "diario_huecos.csv")
            self.assertEqual(huecos, [])


class TestTiempoReal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Captura real del 30-oct a las 16:00, guardada junto con el 29-oct.
        with gzip.open(RAIZ / "tests" / "fixtures" / "paginas" / "2026-10-29.html.gz", "rt", encoding="utf-8") as f:
            cls.captura = cenace.extraer_tiempo_real(f.read())

    def test_fecha_y_hora(self):
        self.assertEqual(self.captura["fecha"], dt.date(2026, 10, 30))
        self.assertEqual(self.captura["hasta_hora"], "16:00")
        self.assertEqual(self.captura["curva"][-1]["hora"], "16:00")

    def test_curva_sin_horas_futuras_ni_nan(self):
        self.assertEqual(len(self.captura["curva"]), 33)  # 00:00 a 16:00 cada 30 minutos
        for fila in self.captura["curva"]:
            self.assertNotIn("nan", [str(v).lower() for v in fila.values()])

    def test_otras_hidro_es_el_resto_de_la_hidraulica(self):
        hidro = [d for d in self.captura["detalle"] if d["grupo"] == "hidraulica"]
        self.assertIn("Otras Hidro", [d["nombre"] for d in hidro])
        self.assertAlmostEqual(sum(float(d["mwh"]) for d in hidro), float(self.captura["resumen"]["hidraulica_mwh"]), delta=1)

    def test_guarda_solo_la_captura_mas_completa(self):
        with tempfile.TemporaryDirectory() as tmp:
            datos = Path(tmp)
            self.assertEqual(cenace.guardar_tiempo_real(self.captura, datos=datos), "temprano")  # antes de las 18:00
            self.assertFalse((datos / "tiempo_real_resumen.csv").exists())
            self.assertEqual(cenace.guardar_tiempo_real(self.captura, datos=datos, desde_hora="12:00"), "nuevo")
            self.assertEqual(cenace.guardar_tiempo_real(self.captura, datos=datos, desde_hora="12:00"), "sin cambios")
            mas_tarde = {**self.captura, "hasta_hora": "22:00", "resumen": {**self.captura["resumen"], "hasta_hora": "22:00"}}
            self.assertEqual(cenace.guardar_tiempo_real(mas_tarde, datos=datos, desde_hora="12:00"), "actualizado")
            antes = {**self.captura, "hasta_hora": "20:00", "resumen": {**self.captura["resumen"], "hasta_hora": "20:00"}}
            self.assertEqual(cenace.guardar_tiempo_real(antes, datos=datos, desde_hora="12:00"), "sin cambios")
            _, filas = cenace._leer_csv(datos / "tiempo_real_resumen.csv")
            self.assertEqual([f["hasta_hora"] for f in filas], ["22:00"])


class TestHidrologia(unittest.TestCase):
    HIDRO = (
        "date,year,doy365,mmdd,series,metric,value,is_placeholder\n"
        "2026-10-27,2026,300,27-oct,Mazar,Cota (msnm),2123.37,0\n"
        "2026-10-27,2026,300,27-oct,Mazar,Caudal (m³/s),27.5,0\n"
        "2026-10-27,2026,300,27-oct,Molino,Cota (msnm),1980.1,0\n"
        "2020-08-31,2020,244,31-ago,Mazar,Cota (msnm),0.0,0\n"
        "2026-10-30,2026,303,30-oct,Mazar,Cota (msnm),2122.0,1\n"
    ).encode("utf-8")
    COCA = "date,coca,css,frente,balance,status\n2026-10-20,151.33,131.62,19.72,0.01,ok\n2026-10-27,,,,,\n".encode("utf-8")

    def test_extrae_mazar_y_coca(self):
        with tempfile.TemporaryDirectory() as tmp:
            datos = Path(tmp)
            self.assertTrue(cenace.actualizar_hidrologia(self.HIDRO, self.COCA, datos=datos))
            self.assertFalse(cenace.actualizar_hidrologia(self.HIDRO, self.COCA, datos=datos))
            _, filas = cenace._leer_csv(datos / "hidrologia.csv")
            por_fecha = {f["fecha"]: f for f in filas}
            # Ceros y placeholders no se guardan; Molino no es parte de la serie.
            self.assertEqual(sorted(por_fecha), ["2026-10-20", "2026-10-27"])
            self.assertEqual(por_fecha["2026-10-27"]["mazar_cota_msnm"], "2123.37")
            self.assertEqual(por_fecha["2026-10-27"]["mazar_caudal_m3s"], "27.5")
            self.assertEqual(por_fecha["2026-10-27"]["coca_caudal_m3s"], "")
            self.assertEqual(por_fecha["2026-10-20"]["coca_caudal_m3s"], "151.33")


class TestGuardarDia(unittest.TestCase):
    def test_idempotente(self):
        html = FIXTURE.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            datos = Path(tmp)
            self.assertEqual(cenace.guardar_dia(cenace.extraer_diario(html), html=html, datos=datos), "nuevo")
            self.assertEqual(cenace.guardar_dia(cenace.extraer_diario(html), html=html, datos=datos), "sin cambios")
            self.assertTrue((datos / "raw" / "2026" / "2026-10-25.html.gz").exists())
            _, filas = cenace._leer_csv(datos / "diario_curva.csv")
            self.assertEqual(len(filas), 48)

    def test_sin_sobrescribir_respeta_lo_existente(self):
        html = FIXTURE.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            datos = Path(tmp)
            cenace.guardar_dia(cenace.extraer_diario(html, fuente="cenace"), datos=datos)
            estado = cenace.guardar_dia(cenace.extraer_diario(html, fuente="otra"), sobrescribir=False, datos=datos)
            self.assertEqual(estado, "sin cambios")
            _, filas = cenace._leer_csv(datos / "diario_resumen.csv")
            self.assertEqual(filas[0]["fuente"], "cenace")


if __name__ == "__main__":
    unittest.main()
