"""
train_model.py
==============
Entrena el modelo de Forecasting (Regresión Múltiple) para predecir
5 días en el futuro (T+1 a T+5) de Turbidez y pH.

Features de entrada: ph, turbidez_ntu, conductividad_us, temperatura_c, humedad_pct
(NO se usan dia, hora, lluvia ni ninguna variable temporal como feature)
"""

import os
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
import joblib
from sklearn.ensemble import RandomForestRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score

BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH   = os.path.join(BASE_DIR, 'data', 'historical_data.csv')
MODEL_DIR   = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH  = os.path.join(MODEL_DIR, 'water_quality_model.pkl')
SCALER_PATH = os.path.join(MODEL_DIR, 'scaler.pkl')
REPORT_PATH = os.path.join(MODEL_DIR, 'model_report.txt')

print("=" * 65)
print("  ENTRENAMIENTO — CENOTE FORECAST 5 DÍAS (NUEVOS SENSORES)")
print("=" * 65)

df = pd.read_csv(DATA_PATH)
print(f"[OK] Datos cargados: {len(df)} muestras horarias.")

# ─── Features (solo parámetros físico-químicos y ambientales) ────────────────
FEATURES = ['ph', 'turbidez_ntu', 'conductividad_us', 'temperatura_c', 'humedad_pct']

# ─── Targets: pH y turbidez para cada uno de los 5 días futuros ──────────────
TARGETS = [
    'target_ph_T1',   'target_ph_T2',   'target_ph_T3',   'target_ph_T4',   'target_ph_T5',
    'target_turb_T1', 'target_turb_T2', 'target_turb_T3', 'target_turb_T4', 'target_turb_T5',
]

X = df[FEATURES].values
y = df[TARGETS].values

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

scaler = StandardScaler()
X_train_sc = scaler.fit_transform(X_train)
X_test_sc  = scaler.transform(X_test)

print(f"\n[INFO] Entrenando RandomForestRegressor ({len(FEATURES)} features, 10 outputs)...")
model = RandomForestRegressor(
    n_estimators=150, max_depth=15, random_state=42, n_jobs=1
)
model.fit(X_train_sc, y_train)

y_pred = model.predict(X_test_sc)

print("\n[INFO] Metricas de error (MAE y R2):")
lines = []
lines.append("CENOTE MONITOR — REPORTE DE FORECASTING (T+1 a T+5 días)")
lines.append("=" * 60)
lines.append(f"\nFeatures usados: {', '.join(FEATURES)}")
lines.append(f"Muestras train : {len(X_train)}")
lines.append(f"Muestras test  : {len(X_test)}\n")

for i, t in enumerate(TARGETS):
    mae = mean_absolute_error(y_test[:, i], y_pred[:, i])
    r2  = r2_score(y_test[:, i], y_pred[:, i])
    line = f"  {t:<18}: MAE={mae:.4f}  R²={r2:.4f}"
    print(line)
    lines.append(line)

print("\n[INFO] Importancia de variables:")
lines.append("\nIMPORTANCIA DE VARIABLES:")
importances = model.feature_importances_
for feat, imp in sorted(zip(FEATURES, importances), key=lambda x: -x[1]):
    line = f"  {feat:<20}: {imp:.4f}"
    print(line)
    lines.append(line)

joblib.dump(model,  MODEL_PATH)
joblib.dump(scaler, SCALER_PATH)

with open(REPORT_PATH, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

print(f"\n[OK] Modelo guardado en: {MODEL_PATH}")
print(f"[OK] Reporte guardado en: {REPORT_PATH}")
print("=" * 65)
