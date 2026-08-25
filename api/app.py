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

SUPABASE_URL = "https://lbhlinueuscwwivazeyn.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxiaGxpbnVldXNjd3dpdmF6ZXluIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxOTA4MzYsImV4cCI6MjA5NTc2NjgzNn0.L9Y2lo_2tI-Nby-ZRGLFVkofJkdbGXIFKUL_qmuMD2w"
TABLA        = "FLOTAYA"

RETRAIN_EVERY = 100

# ─── Estado global ────────────────────────────────────────────────────────────
model  = None
scaler = None
nuevas_lecturas_desde_retrain = 0
retrain_lock = threading.Lock()

def load_assets():
    global model, scaler
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
        print("[WARN] Modelo no encontrado. Ejecuta train_model.py o train_model.mjs primero.")

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
    ph_penalty   = min(abs(ph - 7.4) * 15, 60)
    turb_penalty = min(turbidez * 4, 40)
    salud = round(max(0, 100 - (ph_penalty + turb_penalty)), 1)

    riesgo_algas = (temp - 25) * 8
    if turbidez < 2.0:      riesgo_algas += 15
    if ph > 8.0:            riesgo_algas += 10
    if conductividad > 650: riesgo_algas += 10
    riesgo_algas = round(max(0, min(100, riesgo_algas)), 1)

    if salud >= 75 and turbidez < 4.0:   bandera = "Verde (Excelente)"
    elif salud >= 45 and turbidez < 8.0: bandera = "Amarilla (Precaucion)"
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
        bad_ph = any(p < 6.5 or p > 8.0 for p in ph_5d)
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

# ─── Reentrenamiento automático ───────────────────────────────────────────────
def _retrain_background():
    global model, scaler
    print("[Retrain] Iniciando reentrenamiento con datos de Supabase...")
    train_script = os.path.join(BASE_DIR, 'models', 'train_model.py')
    result = subprocess.run([sys.executable, train_script], capture_output=True, text=True)
    if result.returncode == 0:
        load_assets()
        print("[Retrain] Modelo actualizado exitosamente.")
    else:
        print(f"[Retrain ERROR] {result.stderr}")

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
        "modelo_cargado": model is not None,
        "lecturas_hasta_retrain": RETRAIN_EVERY - nuevas_lecturas_desde_retrain,
        "timestamp": datetime.now().isoformat()
    }

@app.post("/nueva-lectura")
def nueva_lectura(req: LecturaRequest, background_tasks: BackgroundTasks):
    """
    Recibe lectura del sensor desde Vercel, corre el modelo ML,
    guarda sensores + riesgo general en Supabase y dispara reentrenamiento si aplica.
    """
    reading = req.dict()
    risk = predict_contamination_risk(reading)
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
        "guardado":      guardado,
        "riesgo_contaminacion": risk,
        "diagnostico_actual":   m
    }
