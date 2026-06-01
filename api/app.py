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
    if os.path.exists(MODEL_PATH) and os.path.exists(SCALER_PATH):
        model  = joblib.load(MODEL_PATH)
        scaler = joblib.load(SCALER_PATH)
        print("[OK] Modelo cargado.")
    else:
        print("[WARN] Modelo no encontrado. Ejecuta train_model.py primero.")

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

def predict_future_5d(reading: Dict[str, Any]) -> Dict[str, Any]:
    if model is None or scaler is None:
        raise HTTPException(status_code=503, detail="Modelo no cargado.")

    X = np.array([[
        reading['ph'],
        reading['turbidez_ntu'],
        reading['conductividad_us'],
        reading['temperatura_c'],
        reading['humedad_pct'],
    ]])
    pred    = model.predict(scaler.transform(X))[0]
    ph_5d   = [round(float(p), 2) for p in pred[0:5]]
    turb_5d = [round(float(t), 2) for t in pred[5:10]]

    peor_turbidez  = max(turb_5d)
    peor_ph_desvio = max(abs(p - 7.4) for p in ph_5d)
    peor_ph        = next(p for p in ph_5d if abs(p - 7.4) == peor_ph_desvio)

    metricas = calculate_derived_metrics(
        peor_ph, peor_turbidez,
        reading['temperatura_c'],
        reading['conductividad_us']
    )

    return {
        'ph_pred':           ph_5d,
        'turbidez_pred':     turb_5d,
        'metricas_peor_dia': metricas
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
    guarda sensores + predicciones en Supabase y dispara reentrenamiento si aplica.
    """
    reading = req.dict()
    pred    = predict_future_5d(reading)
    m       = pred['metricas_peor_dia']

    fila = {
        "ph":               reading['ph'],
        "turbidez_ntu":     reading['turbidez_ntu'],
        "conductividad_us": reading['conductividad_us'],
        "temperatura_c":    reading['temperatura_c'],
        "humedad_pct":      reading['humedad_pct'],
        "pred_ph_d1":   pred['ph_pred'][0],
        "pred_ph_d2":   pred['ph_pred'][1],
        "pred_ph_d3":   pred['ph_pred'][2],
        "pred_ph_d4":   pred['ph_pred'][3],
        "pred_ph_d5":   pred['ph_pred'][4],
        "pred_turb_d1": pred['turbidez_pred'][0],
        "pred_turb_d2": pred['turbidez_pred'][1],
        "pred_turb_d3": pred['turbidez_pred'][2],
        "pred_turb_d4": pred['turbidez_pred'][3],
        "pred_turb_d5": pred['turbidez_pred'][4],
        "salud_pct": m['salud_pct'],
        "bandera":   m['bandera'],
    }

    guardado = supabase_insert(fila)
    if guardado:
        background_tasks.add_task(maybe_retrain)

    return {
        "guardado":      guardado,
        "pronostico_5d": pred,
        "diagnostico":   m
    }
