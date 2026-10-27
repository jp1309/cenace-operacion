# Operación eléctrica del Ecuador — base diaria CENACE

CENACE (Operador Nacional de Electricidad) publica en su página de
[Información Operativa](https://www.cenace.gob.ec/info-operativa/InformacionOperativa.htm)
el último día completo de operación del sistema eléctrico, pero cada día
sobrescribe el anterior y no ofrece un histórico. Este repositorio construye ese
histórico: un robot descarga la página varias veces al día, extrae la pestaña
**"Información operativa diaria"** y la acumula en archivos CSV, y un dashboard
publicado en GitHub Pages permite consultarla.

**Dashboard:** https://jp1309.github.io/cenace-operacion/

## Qué se guarda

| Archivo | Contenido | Granularidad |
|---|---|---|
| `data/diario_resumen.csv` | Producción total, hidráulica, térmica, no convencional, importación y exportación (MWh); demanda máxima y mínima (MW) con su hora | 1 fila por día |
| `data/diario_curva.csv` | Curva de generación por fuente y demanda nacional (MW) | cada 30 min |
| `data/diario_detalle.csv` | Producción por central hidroeléctrica (Coca Codo, Paute, Sopladora…) y por tipo térmico (MWh) | por central y día |
| `data/mensual_tecnologia.csv` | Serie oficial de energía neta por tecnología desde enero de 2010 (GWh) | mensual |
| `data/anual_produccion.csv` | Producción anual oficial (GWh) | anual |
| `data/raw/AAAA/AAAA-MM-DD.html.gz` | Copia comprimida de la página de cada día, para poder reprocesar | 1 por día |

Columna `fuente`: `cenace` si lo descargó el robot, `wayback:AAAAMMDDhhmmss` si se
recuperó de una copia de Internet Archive (días sueltos de nov-2025 a oct-2026,
anteriores al inicio del robot).

Los datos diarios son **preliminares del SCADA, sujetos a revisión** por CENACE.
Si CENACE corrige un día que todavía muestra la página, el robot guarda la versión nueva.

## Cómo funciona

- `robot/cenace.py` — descarga, extrae y guarda (solo biblioteca estándar de Python 3.10+).
- `robot/historico_wayback.py` — recupera días anteriores desde Internet Archive (se corrió una vez).
- `.github/workflows/robot.yml` — corre el robot a las 06:17, 12:17 y 18:17 (hora de Ecuador),
  hace commit de los datos nuevos y vuelve a publicar el dashboard (`site/`).
- `tests/` — pruebas del parser con una captura real de la página.

### Certificado de CENACE

El servidor de cenace.gob.ec no envía el certificado intermedio de Sectigo, así
que los clientes que no lo buscan por su cuenta (Python, curl, algunos
firewalls) rechazan la conexión. El robot agrega ese intermedio
(`certs/sectigo-dv-r36.pem`) y mantiene la verificación TLS. El certificado
actual de CENACE vence el **12-nov-2026**; si el robot empieza a fallar por TLS
después de esa fecha, probablemente CENACE cambió de emisor y hay que actualizar
el intermedio.

### Correr localmente

```bash
python robot/cenace.py                      # descarga y actualiza data/
python robot/cenace.py --inseguro           # detrás de un proxy que inspecciona HTTPS (p. ej. la red del BID)
python -m unittest discover -s tests        # pruebas
```

### Mantenimiento

- Si CENACE cambia el formato de la página, el robot falla con `ErrorFormato` y
  GitHub envía un correo de "workflow failed"; hay que ajustar el parser en
  `robot/cenace.py` y agregar la nueva página como caso de prueba en `tests/`.
- GitHub desactiva los workflows programados de repos sin actividad por 60 días;
  los commits diarios del robot mantienen el repo activo.
