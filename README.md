# 💧 Cenote Monitor — Sistema ML de Calidad de Agua

Sistema de machine learning para monitoreo de calidad de agua en cenotes.
Verifica cumplimiento con **NOM-127-SSA1-2021** y **NOM-001-SEMARNAT**, genera predicciones y ofrece un dashboard interactivo.

---

## 📁 Estructura del Proyecto

```
modelo Cenote/
├── data/
│   ├── generate_synthetic_data.py   # Genera datos históricos (1,400 muestras)
│   └── historical_data.csv          # Dataset generado (se crea al ejecutar el script)
│
├── models/
│   ├── train_model.py               # Entrena RandomForest + genera matriz de confusión
│   ├── water_quality_model.pkl      # Modelo entrenado (generado)
│   ├── scaler.pkl                   # Normalizador StandardScaler (generado)
│   ├── confusion_matrix.png         # Visualización de la matriz (generada)
│   └── model_report.txt             # Reporte de métricas (generado)
│
├── api/
│   └── app.py                       # API FastAPI con todos los endpoints
│
├── dashboard/
│   └── index.html                   # Dashboard web interactivo
│
├── requirements.txt
└── README.md
```

---

## 🚀 Cómo Ejecutar el Sistema (en orden)

### Paso 1 — Instalar dependencias
```powershell
pip install -r requirements.txt
```

### Paso 2 — Generar datos históricos
```powershell
python data/generate_synthetic_data.py
```
Crea `data/historical_data.csv` con 1,400 muestras realistas de un cenote yucateco.

### Paso 3 — Entrenar el modelo
```powershell
python models/train_model.py
```
- Entrena `RandomForestClassifier` (200 árboles)
- Muestra métricas en consola (accuracy ≥ 87%)
- Genera `models/confusion_matrix.png`
- Guarda `models/model_report.txt`

### Paso 4 — Levantar la API
```powershell
uvicorn api.app:app --reload --port 8000
```
La API queda disponible en `http://localhost:8000`
Documentación automática: `http://localhost:8000/docs`

### Paso 5 — Abrir el Dashboard
Abre `dashboard/index.html` directamente en tu navegador.
> El dashboard funciona sin API (modo demo con datos simulados) y también conectado a la API para datos en tiempo real.

---

## 📊 Parámetros Monitoreados

| Parámetro | NOM-127 (Agua Potable) | NOM-001 (Descarga) | Unidad |
|-----------|----------------------|-------------------|--------|
| pH | 6.5 – 8.5 | 5.0 – 10.0 | — |
| Turbidez | ≤ 5 | ≤ 75 | NTU |
| Nitratos | ≤ 10 | ≤ 40 | mg/L |
| Color verdadero | ≤ 20 | ≤ 150 | UCE |

---

## 🌐 Endpoints de la API

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/health` | Estado del servicio |
| GET | `/current-reading` | Lectura simulada actual de la boya |
| POST | `/predict` | Predice calidad con lecturas dadas |
| GET | `/nom-check` | Verifica cumplimiento NOM |
| POST | `/what-if` | Simula escenario hipotético |
| GET | `/historical-stats` | Estadísticas del dataset histórico |
| POST | `/nom-analysis` | Análisis NOM detallado |

### Ejemplo — Predicción
```bash
curl -X POST http://localhost:8000/predict \
  -H "Content-Type: application/json" \
  -d '{"ph": 7.2, "turbidez_ntu": 4.5, "nitratos_mgl": 8.0, "color_uce": 18.0}'
```

### Ejemplo — ¿Qué pasaría si llueve 7 días?
```bash
curl -X POST http://localhost:8000/what-if \
  -H "Content-Type: application/json" \
  -d '{"ph": 7.4, "turbidez_ntu": 3.0, "nitratos_mgl": 5.0, "color_uce": 15.0, "dias_lluvia": 7, "incremento_temp": 0}'
```

---

## 🤖 Modelo ML

- **Algoritmo**: RandomForestClassifier (scikit-learn)
- **Features (9)**: pH, turbidez, nitratos, color, temperatura, clima, mes, hora, temporada de lluvias
- **Clases (5)**: Excelente · Buena · Regular · Mala · Peligrosa
- **Split**: 80% train / 20% test (estratificado)
- **Target**: Accuracy ≥ 87%, F1-macro ≥ 83%

---

## 🔌 Integración con Boya Real

Cuando la boya esté en producción, reemplaza la función `simulate_bouy_reading()` en `api/app.py` con una llamada a tu endpoint real:

```python
# api/app.py — reemplazar simulate_bouy_reading() con:
import requests

def get_bouy_reading():
    response = requests.get("http://TU_BOYA_IP/lectura")
    data = response.json()
    return {
        "ph":           data["ph"],
        "turbidez_ntu": data["turbidez"],
        "nitratos_mgl": data["nitratos"],
        "color_uce":    data["color"],
        "temperatura_c":data["temperatura"],
        ...
    }
```

---

## 📋 Descripción de Cada Archivo

| Archivo | Función |
|---------|---------|
| `data/generate_synthetic_data.py` | Genera datos históricos con variación estacional real (temporada de lluvias yucateca, 7 tipos de clima). Crea el CSV de entrenamiento. |
| `models/train_model.py` | Carga el CSV, hace feature engineering, divide 80/20, entrena RandomForest, evalúa con validación cruzada 5-fold, genera la matriz de confusión visual y guarda el modelo. |
| `api/app.py` | API REST con FastAPI. Carga el modelo entrenado y expone endpoints para predicción, verificación NOM-127/NOM-001, simulación "¿Qué pasaría si?" y estadísticas históricas. |
| `dashboard/index.html` | Dashboard de una sola página. Muestra gauges animados de los 4 parámetros, semáforo NOM, predicción ML en tiempo real, gráfico histórico de turbidez y panel "¿Qué pasaría si?" con sliders. Funciona en modo demo sin API. |
