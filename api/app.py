"""
app.py — API FastAPI para Cenote Inteligente
============================================
Endpoints:
  POST /nueva-lectura  ← recibe datos del sensor, corre ML, guarda en Supabase
  GET  /health         ← estado del servicio y del modelo
"""
import os
import threading
import subprocess
import sys
from datetime import datetime
from typing import Dict, Any

import numpy as np
import joblib
import urllib.request
import json

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ─── Rutas ────────────────────────────────────────────────────────────────────
BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH  = os.path.join(BASE_DIR, 'models', 'water_quality_model.pkl')
SCALER_PATH = os.path.join(BASE_DIR, 'models', 'scaler.pkl')
JSON_MODEL_PATH = os.path.join(BASE_DIR, 'models', 'contamination_risk_model.json')

FORECAST_MODEL_PATH = os.path.join(BASE_DIR, 'models', 'forecast_model.json')

SUPABASE_URL = "https://dyaryhtlkzqtgmowwdqz.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR5YXJ5aHRsa3pxdGdtb3d3ZHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4NTA1MzUsImV4cCI6MjEwNzQyNjUzNX0.Yrm_nT1kRht59kFbVGHPqfCFUfQDEDos0kKUmJoYXNM"
TABLA        = "FLOTAYA"

RETRAIN_EVERY = 100

# ─── Estado global ────────────────────────────────────────────────────────────
model  = None
scaler = None
forecast_model = None
nuevas_lecturas_desde_retrain = 0
retrain_lock = threading.Lock()

def load_assets():
    global model, scaler, forecast_model
    if os.path.exists(JSON_MODEL_PATH):
        with open(JSON_MODEL_PATH, "r", encoding="utf-8") as f:
            model = json.load(f)
        scaler = None
        print("[OK] Modelo JSON de riesgo cargado.")
    elif os.path.exists(MODEL_PATH) and os.path.exists(SCALER_PATH):
        model  = joblib.load(MODEL_PATH)
        scaler = joblib.load(SCALER_PATH)
        print("[OK] Modelo PKL cargado.")
    else:
        print("[WARN] Modelo de riesgo no encontrado. Ejecuta train_model.py primero.")

    if os.path.exists(FORECAST_MODEL_PATH):
        try:
            with open(FORECAST_MODEL_PATH, "r", encoding="utf-8") as f:
                forecast_model = json.load(f)
            print("[OK] Modelo de pronóstico a 5 días cargado.")
        except Exception as e:
            print(f"[WARN] Error cargando forecast_model.json: {e}")
    else:
        print("[WARN] forecast_model.json no encontrado.")

load_assets()

# ─── FastAPI ──────────────────────────────────────────────────────────────────
app = FastAPI(title="Cenote Monitor API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"]
)

# ─── Supabase helpers ─────────────────────────────────────────────────────────
def _sb_headers() -> dict:
    return {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "return=minimal"
    }

def supabase_insert(row: dict) -> bool:
    url  = f"{SUPABASE_URL}/rest/v1/{TABLA}"
    body = json.dumps(row).encode()
    req  = urllib.request.Request(url, data=body, method="POST", headers=_sb_headers())
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status in (200, 201)
    except Exception as e:
        print(f"[Supabase INSERT error] {e}")
        return False

# ─── ML helpers ───────────────────────────────────────────────────────────────
def calculate_derived_metrics(ph: float, turbidez: float, temp: float, conductividad: float) -> Dict[str, Any]:
    # NOM-127-SSA1-2021: pH permisible 6.5 a 8.5 (rango neutro óptimo 7.2 - 7.8)
    if 6.5 <= ph <= 8.5:
        ph_penalty = min(abs(ph - 7.5) * 6, 20)
    elif ph < 6.5:
        ph_penalty = min(20 + (6.5 - ph) * 30, 60)
    else:
        ph_penalty = min(20 + (ph - 8.5) * 30, 60)

    # NOM-127: Turbidez óptima <= 4.0 NTU
    turb_penalty = min(turbidez * 4, 40)
    salud = round(max(0, 100 - (ph_penalty + turb_penalty)), 1)

    riesgo_algas = max(0.0, (temp - 25) * 8)
    if turbidez < 2.0:       riesgo_algas += 15
    if ph > 8.5:             riesgo_algas += 10
    if conductividad > 1000: riesgo_algas += 10
    riesgo_algas = round(max(0, min(100, riesgo_algas)), 1)

    if salud >= 75 and turbidez <= 4.0:  bandera = "Verde (Excelente)"
    elif salud >= 45 and turbidez <= 8.0: bandera = "Amarilla (Precaucion)"
    else:                                bandera = "Roja (No Nadar)"

    return {"salud_pct": salud, "riesgo_algas_pct": riesgo_algas, "bandera": bandera}

def _risk_level(probability: float) -> str:
    if probability >= 70:
        return "alto"
    if probability >= 40:
        return "medio"
    return "bajo"

def _risk_recommendations(level: str, probability: float) -> list:
    if level == "alto":
        return [
            f"Riesgo alto ({probability:.1f}%). Actuar antes de que el deterioro se consolide.",
            "Restringir temporalmente actividades que puedan agregar contaminantes.",
            "Tomar muestra de laboratorio y aumentar frecuencia de monitoreo.",
        ]
    if level == "medio":
        return [
            f"Riesgo medio ({probability:.1f}%). Conviene intervenir preventivamente.",
            "Revisar fuentes cercanas de escorrentia, visitantes, sedimentos o descargas.",
            "Repetir medicion y monitorear tendencia durante las proximas 24-48 h.",
        ]
    return [
        f"Riesgo bajo ({probability:.1f}%). Mantener monitoreo normal.",
        "No se detecta urgencia, pero conviene conservar el registro historico.",
    ]

def _json_model_features(reading: Dict[str, Any]) -> list:
    now = datetime.now()
    hour = now.hour
    day = now.timetuple().tm_yday
    ph = reading['ph']
    turbidez = reading['turbidez_ntu']
    conductividad = reading['conductividad_us']
    temperatura = reading['temperatura_c']
    humedad = reading['humedad_pct']

    return [
        ph,
        turbidez,
        conductividad,
        temperatura,
        humedad,
        abs(ph - 7.4),
        turbidez * humedad,
        temperatura * humedad,
        conductividad * temperatura,
        np.sin((2 * np.pi * hour) / 24),
        np.cos((2 * np.pi * hour) / 24),
        np.sin((2 * np.pi * day) / 30),
        np.cos((2 * np.pi * day) / 30),
    ]

def predict_contamination_risk(reading: Dict[str, Any]) -> Dict[str, Any]:
    if model is None:
        raise HTTPException(status_code=503, detail="Modelo no cargado.")

    base_features = [
        reading['ph'],
        reading['turbidez_ntu'],
        reading['conductividad_us'],
        reading['temperatura_c'],
        reading['humedad_pct'],
    ]

    if isinstance(model, dict) and model.get("model_type") in ("contamination_risk_logistic", "contamination_risk_forest"):
        features = _json_model_features(reading)
        means = model["scaler"]["means"]
        stds = model["scaler"]["stds"]
        scaled_features = [(value - mean) / std for value, mean, std in zip(features, means, stds)]

        if model.get("model_type") == "contamination_risk_forest":
            def predict_tree(node: Dict[str, Any]) -> float:
                if "probability" in node:
                    return float(node["probability"])
                feature_index = int(node["feature"])
                branch = "left" if scaled_features[feature_index] <= float(node["threshold"]) else "right"
                return predict_tree(node[branch])

            probability_raw = float(np.mean([predict_tree(tree) for tree in model["trees"]]))
        else:
            weights = model["weights"]
            bias = model["bias"]
            z = bias
            for value, weight in zip(scaled_features, weights):
                z += value * weight
            probability_raw = 1 / (1 + np.exp(-z))

        probability = round(float(probability_raw) * 100, 1)
        decision_threshold = float(model.get("decision_threshold", 0.5)) * 100
        contaminated = probability >= decision_threshold
        level = _risk_level(probability)

        return {
            "probabilidad_contaminacion_pct": probability,
            "riesgo": level,
            "contaminacion_probable": contaminated,
            "horizonte": "proximos 5 dias si no se actua",
            "recomendaciones": _risk_recommendations(level, probability),
        }

    if scaler is None:
        raise HTTPException(status_code=503, detail="Scaler no cargado para modelo PKL.")

    pkl_features = _json_model_features(reading) if getattr(model, "n_features_in_", 5) == 13 else base_features
    X = np.array([pkl_features])
    X_sc = scaler.transform(X)

    if hasattr(model, "predict_proba"):
        probability = round(float(model.predict_proba(X_sc)[0][1]) * 100, 1)
        contaminated = bool(model.predict(X_sc)[0])
    else:
        # Compatibilidad temporal con el modelo anterior de regresion.
        pred = model.predict(X_sc)[0]
        ph_5d = [float(p) for p in pred[0:5]]
        turb_5d = [float(t) for t in pred[5:10]]
        bad_ph = any(p < 6.5 or p > 8.5 for p in ph_5d)
        bad_turb = any(t > 4.0 for t in turb_5d)
        contaminated = bad_ph or bad_turb
        probability = 85.0 if contaminated else 15.0

    level = _risk_level(probability)

    return {
        "probabilidad_contaminacion_pct": probability,
        "riesgo": level,
        "contaminacion_probable": contaminated,
        "horizonte": "proximos 5 dias si no se actua",
        "recomendaciones": _risk_recommendations(level, probability),
    }

def predict_forecast(reading: Dict[str, Any]) -> list:
    """
    Predice los valores futuros exactos de pH y turbidez (T+1 a T+5 días).
    Si el modelo JSON está disponible usa la regresión entrenada; si no, aplica proyección física.
    """
    if forecast_model is None:
        ph = float(reading.get("ph", 7.4))
        turb = float(reading.get("turbidez_ntu", 1.5))
        return [
            {
                "dia": i + 1,
                "label": f"+{i + 1} día{'s' if i > 0 else ''}",
                "ph": round(ph + (i + 1) * (-0.015 if ph > 7.5 else 0.01), 2),
                "turbidez_ntu": round(max(0.1, turb + (i + 1) * 0.12), 2),
                "estado_ph": "Óptimo (NOM)" if 6.5 <= ph <= 8.5 else "Fuera de norma",
                "estado_turb": "Óptimo (NOM)" if turb <= 4.0 else ("Alerta" if turb <= 8.0 else "Crítico"),
            }
            for i in range(5)
        ]

    features = _json_model_features(reading)
    means = forecast_model["scaler"]["means"]
    stds = forecast_model["scaler"]["stds"]
    scaled_features = [(v - m) / (s if s != 0 else 1.0) for v, m, s in zip(features, means, stds)]

    weights = forecast_model["weights"]
    biases = forecast_model["biases"]

    ph_preds = []
    for i in range(5):
        val = biases[i] + sum(w * x for w, x in zip(weights[i], scaled_features))
        val = round(float(np.clip(val, 5.0, 9.5)), 2)
        ph_preds.append(val)

    turb_preds = []
    for i in range(5, 10):
        val = biases[i] + sum(w * x for w, x in zip(weights[i], scaled_features))
        val = round(float(max(0.1, val)), 2)
        turb_preds.append(val)

    proyeccion = []
    for i in range(5):
        p_val = ph_preds[i]
        t_val = turb_preds[i]
        proyeccion.append({
            "dia": i + 1,
            "label": f"+{i + 1} día{'s' if i > 0 else ''}",
            "ph": p_val,
            "turbidez_ntu": t_val,
            "estado_ph": "Óptimo (NOM)" if 6.5 <= p_val <= 8.5 else "Fuera de norma",
            "estado_turb": "Óptimo (NOM)" if t_val <= 4.0 else ("Alerta" if t_val <= 8.0 else "Crítico"),
        })
    return proyeccion

# ─── Reentrenamiento automático ───────────────────────────────────────────────
def _retrain_background():
    global model, scaler, forecast_model
    print("[Retrain] Iniciando reentrenamiento con datos de Supabase...")
    train_script = os.path.join(BASE_DIR, 'models', 'train_model.py')
    forecast_script = os.path.join(BASE_DIR, 'models', 'train_forecast.py')
    r1 = subprocess.run([sys.executable, train_script], capture_output=True, text=True)
    r2 = subprocess.run([sys.executable, forecast_script], capture_output=True, text=True)
    if r1.returncode == 0 and r2.returncode == 0:
        load_assets()
        print("[Retrain] Modelos de riesgo y pronóstico actualizados exitosamente.")
    else:
        print(f"[Retrain ERROR] Riesgo: {r1.stderr} | Pronóstico: {r2.stderr}")

def maybe_retrain():
    global nuevas_lecturas_desde_retrain
    with retrain_lock:
        nuevas_lecturas_desde_retrain += 1
        if nuevas_lecturas_desde_retrain >= RETRAIN_EVERY:
            nuevas_lecturas_desde_retrain = 0
            threading.Thread(target=_retrain_background, daemon=True).start()

# ─── Pydantic ─────────────────────────────────────────────────────────────────
class LecturaRequest(BaseModel):
    ph: float
    turbidez_ntu: float
    conductividad_us: float
    temperatura_c: float
    humedad_pct: float

# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "modelo_riesgo_cargado": model is not None,
        "modelo_pronostico_cargado": forecast_model is not None,
        "lecturas_hasta_retrain": RETRAIN_EVERY - nuevas_lecturas_desde_retrain,
        "timestamp": datetime.now().isoformat()
    }

@app.post("/prediccion")
def prediccion(req: LecturaRequest):
    """
    Pronostica valores numéricos futuros de pH y turbidez para los próximos 5 días.
    """
    reading = req.dict()
    proyeccion = predict_forecast(reading)
    risk = predict_contamination_risk(reading) if model is not None else None
    return {
        "status": "ok",
        "lectura_actual": reading,
        "proyeccion_5_dias": proyeccion,
        "riesgo_general": risk,
    }

@app.post("/nueva-lectura")
def nueva_lectura(req: LecturaRequest, background_tasks: BackgroundTasks):
    """
    Recibe lectura del sensor desde Vercel, corre el modelo ML,
    guarda sensores + riesgo general en Supabase y dispara reentrenamiento si aplica.
    """
    reading = req.dict()
    risk = predict_contamination_risk(reading)
    proyeccion = predict_forecast(reading)
    m = calculate_derived_metrics(
        reading['ph'],
        reading['turbidez_ntu'],
        reading['temperatura_c'],
        reading['conductividad_us'],
    )

    fila = {
        "ph":               reading['ph'],
        "turbidez_ntu":     reading['turbidez_ntu'],
        "conductividad_us": reading['conductividad_us'],
        "temperatura_c":    reading['temperatura_c'],
        "humedad_pct":      reading['humedad_pct'],
        "prob_contaminacion_pct": risk['probabilidad_contaminacion_pct'],
        "riesgo_contaminacion": risk['riesgo'],
        "contaminacion_probable": risk['contaminacion_probable'],
        "salud_pct": m['salud_pct'],
        "bandera":   m['bandera'],
    }

    guardado = supabase_insert(fila)
    if not guardado:
        fila_basica = {
            "ph":               reading['ph'],
            "turbidez_ntu":     reading['turbidez_ntu'],
            "conductividad_us": reading['conductividad_us'],
            "temperatura_c":    reading['temperatura_c'],
            "humedad_pct":      reading['humedad_pct'],
            "salud_pct":        m['salud_pct'],
            "bandera":          m['bandera'],
        }
        guardado = supabase_insert(fila_basica)

    if guardado:
        background_tasks.add_task(maybe_retrain)

    return {
        "guardado":             guardado,
        "riesgo_contaminacion": risk,
        "diagnostico_actual":   m,
        "proyeccion_5_dias":     proyeccion,
    }
