"""Pruebas del parser con una captura real de la página (27-oct-2026).

Ejecutar desde la raíz del repo:  python -m unittest discover -s tests
"""

import datetime as dt
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
