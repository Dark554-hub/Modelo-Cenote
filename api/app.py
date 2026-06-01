"""
app.py — API FastAPI para Cenote Inteligente
============================================
Integración con Supabase (tabla FLOTAYA).
Features del modelo: ph, turbidez_ntu, conductividad_us, temperatura_c, humedad_pct
Los 'días' solo aparecen en el OUTPUT de predicción (T+1 … T+5).
"""
import os
import random
import threading
import subprocess
import sys
from datetime import datetime
from typing import Dict, Any, Optional

import numpy as np
import joblib
import urllib.request
import json

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ─── Configuración ────────────────────────────────────────────────────────────
BASE_DIR      = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH    = os.path.join(BASE_DIR, 'models', 'water_quality_model.pkl')
SCALER_PATH   = os.path.join(BASE_DIR, 'models', 'scaler.pkl')
DATA_PATH     = os.path.join(BASE_DIR, 'data', 'historical_data.csv')

SUPABASE_URL  = "https://lbhlinueuscwwivazeyn.supabase.co"
SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxiaGxpbnVldXNjd3dpdmF6ZXluIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxOTA4MzYsImV4cCI6MjA5NTc2NjgzNn0.L9Y2lo_2tI-Nby-ZRGLFVkofJkdbGXIFKUL_qmuMD2w"
TABLA         = "FLOTAYA"

# Reentrenar cada N lecturas nuevas guardadas
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

@app.get("/")
def read_root():
    return JSONResponse({"status": "ok", "api": "Cenote Monitor API", "docs": "/docs"})


# ─── Modelos Pydantic ─────────────────────────────────────────────────────────

class LecturaRequest(BaseModel):
    ph: float
    turbidez_ntu: float
    conductividad_us: float
    temperatura_c: float
    humedad_pct: float

class WhatIfRequest(BaseModel):
    ph: float
    turbidez_ntu: float
    conductividad_us: float
    temperatura_c: float
    humedad_pct: float
    escenario: str


# ─── Supabase helpers ─────────────────────────────────────────────────────────

def _sb_headers() -> dict:
    return {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "return=minimal"
    }

def supabase_get(endpoint: str, params: str = "") -> Any:
    """GET a Supabase REST endpoint."""
    url = f"{SUPABASE_URL}/rest/v1/{endpoint}{params}"
    req = urllib.request.Request(url, headers={**_sb_headers(), "Prefer": ""})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"[Supabase GET error] {e}")
        return None

def supabase_insert(row: dict) -> bool:
    """INSERT una fila en Supabase."""
    url  = f"{SUPABASE_URL}/rest/v1/{TABLA}"
    body = json.dumps(row).encode()
    req  = urllib.request.Request(url, data=body, method="POST", headers=_sb_headers())
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status in (200, 201)
    except Exception as e:
        print(f"[Supabase INSERT error] {e}")
        return False

def get_ultima_lectura() -> Optional[Dict[str, Any]]:
    """Obtiene la lectura más reciente de la boya desde Supabase."""
    data = supabase_get(TABLA, "?select=ph,turbidez_ntu,conductividad_us,temperatura_c,humedad_pct&order=created_at.desc&limit=1")
    if data and len(data) > 0:
        return data[0]
    return None

def get_total_lecturas() -> int:
    """Cuenta el total de filas en FLOTAYA."""
    data = supabase_get(TABLA, "?select=id&order=created_at.desc&limit=1")
    return len(data) if data else 0


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
        raise HTTPException(status_code=503, detail="Modelo no cargado. Ejecuta train_model.py primero.")

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

def simulate_reading() -> Dict[str, Any]:
    """Fallback: simula lectura si Supabase no responde."""
    temp  = round(28.0 + random.gauss(0, 1.0), 1)
    humid = round(78.0 + random.gauss(0, 4.0), 1)
    return {
        'ph':               round(7.4  + random.gauss(0, 0.08), 2),
        'turbidez_ntu':     round(max(0.1, 2.0 + random.gauss(0, 0.2)), 2),
        'conductividad_us': round(max(300, 550 + random.gauss(0, 15)), 1),
        'temperatura_c':    temp,
        'humedad_pct':      round(min(98, max(40, humid)), 1),
    }


# ─── Reentrenamiento automático ───────────────────────────────────────────────

def _retrain_background():
    """Lanza el reentrenamiento del modelo en un hilo separado."""
    global model, scaler
    print("[Retrain] Iniciando reentrenamiento con datos de Supabase...")
    train_script = os.path.join(BASE_DIR, 'models', 'train_model.py')
    result = subprocess.run(
        [sys.executable, train_script],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        load_assets()   # recarga el modelo nuevo en memoria
        print("[Retrain] Modelo actualizado exitosamente.")
    else:
        print(f"[Retrain ERROR] {result.stderr}")

def maybe_retrain():
    """Dispara reentrenamiento si acumulamos RETRAIN_EVERY lecturas nuevas."""
    global nuevas_lecturas_desde_retrain
    with retrain_lock:
        nuevas_lecturas_desde_retrain += 1
        if nuevas_lecturas_desde_retrain >= RETRAIN_EVERY:
            nuevas_lecturas_desde_retrain = 0
            t = threading.Thread(target=_retrain_background, daemon=True)
            t.start()


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "modelo_cargado": model is not None,
        "lecturas_hasta_retrain": RETRAIN_EVERY - nuevas_lecturas_desde_retrain,
        "timestamp": datetime.now().isoformat()
    }

@app.get("/current-reading")
def current_reading():
    """Obtiene la última lectura real de Supabase y genera pronóstico."""
    lectura = get_ultima_lectura()
    fuente  = "supabase"

    if not lectura:
        lectura = simulate_reading()
        fuente  = "simulado"

    pred = predict_future_5d(lectura)
    return {
        "fuente":       fuente,
        "actual":       lectura,
        "pronostico_5d": pred
    }

@app.post("/nueva-lectura")
def nueva_lectura(req: LecturaRequest, background_tasks: BackgroundTasks):
    """
    Recibe una lectura de la boya, corre el modelo, guarda TODO en Supabase
    (sensores + predicción) y dispara reentrenamiento si corresponde.
    """
    reading = req.dict()
    pred    = predict_future_5d(reading)
    m       = pred['metricas_peor_dia']

    fila = {
        # Sensores
        "ph":               reading['ph'],
        "turbidez_ntu":     reading['turbidez_ntu'],
        "conductividad_us": reading['conductividad_us'],
        "temperatura_c":    reading['temperatura_c'],
        "humedad_pct":      reading['humedad_pct'],
        # Predicciones
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
        # Diagnóstico
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

@app.post("/what-if")
def what_if(req: WhatIfRequest):
    data = req.dict()

    if data['escenario'] == "huracan":
        data['humedad_pct']       = min(98, data['humedad_pct'] + 20)
        data['turbidez_ntu']     += 10.0
        data['ph']               -= 0.8
        data['temperatura_c']   -= 2.0
        data['conductividad_us']  = max(300, data['conductividad_us'] - 40)
    elif data['escenario'] == "ola_calor":
        data['temperatura_c']    += 6.0
        data['humedad_pct']       = max(40, data['humedad_pct'] - 15)
        data['turbidez_ntu']      = max(0.1, data['turbidez_ntu'] - 1.0)
        data['conductividad_us']  = min(800, data['conductividad_us'] + 30)
    elif data['escenario'] == "turismo_masivo":
        data['turbidez_ntu']     += 8.0
        data['ph']               += 0.5
        data['conductividad_us']  = min(800, data['conductividad_us'] + 60)
    elif data['escenario'] == "construccion":
        data['turbidez_ntu']     += 20.0
        data['ph']               += 1.2
        data['conductividad_us']  = min(800, data['conductividad_us'] + 100)
    elif data['escenario'] == "agricultura":
        data['turbidez_ntu']     += 5.0
        data['ph']               -= 0.6
        data['conductividad_us']  = min(800, data['conductividad_us'] + 80)

    pred = predict_future_5d(data)
    return {
        'actual_modificado': {
            'ph':               round(data['ph'], 2),
            'turbidez_ntu':     round(data['turbidez_ntu'], 2),
            'conductividad_us': round(data['conductividad_us'], 1),
            'temperatura_c':    round(data['temperatura_c'], 1),
            'humedad_pct':      round(data['humedad_pct'], 1),
        },
        'pronostico_5d': pred
    }

@app.get("/historial")
def historial(limite: int = 50):
    """Devuelve las últimas N lecturas con sus predicciones desde Supabase."""
    data = supabase_get(TABLA, f"?select=*&order=created_at.desc&limit={limite}")
    return {"lecturas": data or []}
