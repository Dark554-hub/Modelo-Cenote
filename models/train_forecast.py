"""
train_forecast.py — Modelo de regresion para pronosticar pH y turbidez a 5 dias.

Entrena un regresor por cada target (10 en total: pH T+1..T+5, turb T+1..T+5)
y exporta los pesos a JSON ligero para que Render pueda cargarlo sin PKL.
"""

import os
import json
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.ensemble import RandomForestRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error, r2_score

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(BASE_DIR, "data", "historical_data.csv")
MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
JSON_PATH = os.path.join(MODEL_DIR, "forecast_model.json")
REPORT_PATH = os.path.join(MODEL_DIR, "forecast_report.txt")

FEATURES = [
    "ph",
    "turbidez_ntu",
    "conductividad_us",
    "temperatura_c",
    "humedad_pct",
    "ph_desvio_74",
    "turbidez_humedad",
    "temperatura_humedad",
    "conductividad_temperatura",
    "hora_sin",
    "hora_cos",
    "ciclo_30d_sin",
    "ciclo_30d_cos",
]

TARGETS = [
    "target_ph_T1", "target_ph_T2", "target_ph_T3", "target_ph_T4", "target_ph_T5",
    "target_turb_T1", "target_turb_T2", "target_turb_T3", "target_turb_T4", "target_turb_T5",
]


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Genera las 13 features a partir de los 5 sensores crudos."""
    rows = []
    for idx, row in df.iterrows():
        hour = idx % 24
        day = idx // 24
        rows.append({
            "ph": row["ph"],
            "turbidez_ntu": row["turbidez_ntu"],
            "conductividad_us": row["conductividad_us"],
            "temperatura_c": row["temperatura_c"],
            "humedad_pct": row["humedad_pct"],
            "ph_desvio_74": abs(row["ph"] - 7.4),
            "turbidez_humedad": row["turbidez_ntu"] * row["humedad_pct"],
            "temperatura_humedad": row["temperatura_c"] * row["humedad_pct"],
            "conductividad_temperatura": row["conductividad_us"] * row["temperatura_c"],
            "hora_sin": np.sin((2 * np.pi * hour) / 24),
            "hora_cos": np.cos((2 * np.pi * hour) / 24),
            "ciclo_30d_sin": np.sin((2 * np.pi * day) / 30),
            "ciclo_30d_cos": np.cos((2 * np.pi * day) / 30),
        })
    return pd.DataFrame(rows)


# ── Cargar datos ──
df = pd.read_csv(DATA_PATH)
X_df = build_features(df)
X = X_df[FEATURES].values
Y = df[TARGETS].values  # (N, 10)

# ── Split temporal 70/10/20 ──
n = len(X)
train_end = int(n * 0.7)
valid_end = int(n * 0.8)

X_train, Y_train = X[:train_end], Y[:train_end]
X_valid, Y_valid = X[train_end:valid_end], Y[train_end:valid_end]
X_test, Y_test = X[valid_end:], Y[valid_end:]

# ── Escalar ──
scaler = StandardScaler()
X_train_sc = scaler.fit_transform(X_train)
X_valid_sc = scaler.transform(X_valid)
X_test_sc = scaler.transform(X_test)

# ── Entrenar un modelo Ridge por cada target ──
# Ridge es ideal para JSON: solo pesos + bias por target.
models = {}
report_lines = [
    "CENOTE MONITOR - MODELO PREDICTIVO DE VALORES FUTUROS",
    "=" * 60,
    "",
    "Objetivo: Predecir valores numericos de pH y turbidez para T+1 a T+5 dias.",
    f"Features: {', '.join(FEATURES)}",
    f"Muestras train: {len(X_train)} | valid: {len(X_valid)} | test: {len(X_test)}",
    "",
    "METRICAS POR TARGET (en test set):",
    "-" * 60,
    f"{'Target':<20} {'MAE':>8} {'R²':>8}",
    "-" * 60,
]

all_weights = []
all_biases = []
target_metrics = []

for i, target_name in enumerate(TARGETS):
    y_tr = Y_train[:, i]
    y_te = Y_test[:, i]

    model = Ridge(alpha=1.0)
    model.fit(X_train_sc, y_tr)

    y_pred = model.predict(X_test_sc)
    mae = mean_absolute_error(y_te, y_pred)
    r2 = r2_score(y_te, y_pred)

    report_lines.append(f"  {target_name:<20} {mae:>8.4f} {r2:>8.4f}")
    target_metrics.append({"target": target_name, "mae": round(mae, 4), "r2": round(r2, 4)})

    all_weights.append([round(float(w), 8) for w in model.coef_])
    all_biases.append(round(float(model.intercept_), 8))

# ── Tambien entrenar RF para comparar (solo metricas, no se exporta) ──
report_lines.append("")
report_lines.append("COMPARACION CON RANDOM FOREST (referencia, no exportado):")
report_lines.append("-" * 60)

for i, target_name in enumerate(TARGETS):
    rf = RandomForestRegressor(n_estimators=100, max_depth=10, random_state=42, n_jobs=1)
    rf.fit(X_train_sc, Y_train[:, i])
    y_pred_rf = rf.predict(X_test_sc)
    mae_rf = mean_absolute_error(Y_test[:, i], y_pred_rf)
    r2_rf = r2_score(Y_test[:, i], y_pred_rf)
    report_lines.append(f"  {target_name:<20} {mae_rf:>8.4f} {r2_rf:>8.4f}")

# ── Exportar modelo JSON ──
forecast_model = {
    "model_type": "forecast_ridge",
    "description": "Predice valores numericos de pH y turbidez para los proximos 5 dias",
    "features": FEATURES,
    "targets": TARGETS,
    "target_labels": {
        "target_ph_T1": "pH en 1 dia",
        "target_ph_T2": "pH en 2 dias",
        "target_ph_T3": "pH en 3 dias",
        "target_ph_T4": "pH en 4 dias",
        "target_ph_T5": "pH en 5 dias",
        "target_turb_T1": "Turbidez en 1 dia",
        "target_turb_T2": "Turbidez en 2 dias",
        "target_turb_T3": "Turbidez en 3 dias",
        "target_turb_T4": "Turbidez en 4 dias",
        "target_turb_T5": "Turbidez en 5 dias",
    },
    "scaler": {
        "means": [round(float(m), 8) for m in scaler.mean_],
        "stds": [round(float(s), 8) for s in scaler.scale_],
    },
    "weights": all_weights,  # (10, 13) — una fila por target
    "biases": all_biases,    # (10,)
    "metrics": target_metrics,
}

with open(JSON_PATH, "w", encoding="utf-8") as f:
    json.dump(forecast_model, f, indent=2, ensure_ascii=False)

report_lines.append("")
report_lines.append(f"[OK] Modelo exportado a: {JSON_PATH}")
report_lines.append(f"[OK] Tamaño: {os.path.getsize(JSON_PATH) / 1024:.1f} KB")

with open(REPORT_PATH, "w", encoding="utf-8") as f:
    f.write("\n".join(report_lines))

print("\n".join(report_lines))
