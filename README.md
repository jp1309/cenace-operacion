# Operación eléctrica del Ecuador — base diaria CENACE

Histórico diario de producción y demanda eléctrica del Ecuador, construido a partir
de la [Información Operativa](https://www.cenace.gob.ec/info-operativa/InformacionOperativa.htm)
que publica CENACE (Operador Nacional de Electricidad). CENACE muestra solo el último
día disponible; este repositorio lo guarda día a día.

**Dashboard:** https://jp1309.github.io/cenace-operacion/

## Datos

| Archivo | Contenido |
|---|---|
| `data/diario_resumen.csv` | Producción por fuente, importación y exportación (MWh); demanda máxima y mínima (MW). Un registro por día, desde el 25-oct-2026. |
| `data/diario_curva.csv` | Generación por fuente y demanda nacional cada 30 minutos (MW). |
| `data/diario_detalle.csv` | Producción por central hidroeléctrica y por tipo térmico (MWh). |
| `data/mensual_operativo.csv` | Acumulado de cada mes, incluida importación y exportación (MWh), desde oct-2026. `hasta_dia` indica hasta qué día va el acumulado. |
| `data/mensual_tecnologia.csv` | Serie oficial de energía neta por tecnología desde enero de 2010 (GWh). |
| `data/anual_produccion.csv` | Producción anual oficial (GWh). |
| `data/hidrologia.csv` | Cota (msnm) y caudal de entrada (m³/s) del embalse de Mazar desde 2020, y caudal del río Coca desde 2024. Fuente: API de CELEC, vía [jp1309/celec](https://github.com/jp1309/celec). |

El dashboard incluye una pestaña de **alerta temprana** que compara la hidrología de
Mazar, el río Coca y la participación térmica con la misma fecha de años normales y de
la crisis de 2023–2024. Es un semáforo indicativo, no oficial.

Los datos diarios son preliminares del SCADA y CENACE puede revisarlos.

## Actualización

Un workflow de GitHub Actions corre `robot/cenace.py` tres veces al día, guarda los
datos nuevos en `data/` y vuelve a publicar el dashboard (`site/`).

Para correrlo localmente (Python 3.10+, sin dependencias):

```bash
python robot/cenace.py
python -m unittest discover -s tests
```

`certs/` contiene el certificado intermedio de Sectigo que el servidor de CENACE no
envía, necesario para verificar la conexión HTTPS.

Fuente de los datos: CENACE, Ecuador.
