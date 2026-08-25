"""
Entrena un clasificador honesto de riesgo general de contaminacion a 5 dias.

Evita fuga de informacion:
- La etiqueta usa los targets futuros reales T+1 a T+5.
- Las features usan solo la lectura actual, derivados actuales y tiempo.
- La evaluacion usa split temporal: 70% train, 10% validacion, 20% test.
"""

import os
import warnings

warnings.filterwarnings("ignore")

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.preprocessing import StandardScaler


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(BASE_DIR, "data", "historical_data.csv")
MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(MODEL_DIR, "water_quality_model.pkl")
SCALER_PATH = os.path.join(MODEL_DIR, "scaler.pkl")
REPORT_PATH = os.path.join(MODEL_DIR, "model_report.txt")
METADATA_PATH = os.path.join(MODEL_DIR, "model_metadata.pkl")

PH_MIN = 7.2
PH_MAX = 7.6
TURBIDEZ_MAX = 3.2

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


def build_dataset(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    rows = []
    labels = []

    for idx, row in df.iterrows():
        hour = idx % 24
        day = idx // 24
        ph = row["ph"]
        turbidez = row["turbidez_ntu"]
        conductividad = row["conductividad_us"]
        temperatura = row["temperatura_c"]
        humedad = row["humedad_pct"]

        rows.append(
            {
                "ph": ph,
                "turbidez_ntu": turbidez,
                "conductividad_us": conductividad,
                "temperatura_c": temperatura,
                "humedad_pct": humedad,
                "ph_desvio_74": abs(ph - 7.4),
                "turbidez_humedad": turbidez * humedad,
                "temperatura_humedad": temperatura * humedad,
                "conductividad_temperatura": conductividad * temperatura,
                "hora_sin": np.sin((2 * np.pi * hour) / 24),
                "hora_cos": np.cos((2 * np.pi * hour) / 24),
                "ciclo_30d_sin": np.sin((2 * np.pi * day) / 30),
                "ciclo_30d_cos": np.cos((2 * np.pi * day) / 30),
            }
        )

        bad_ph = any(row[f"target_ph_T{i}"] < PH_MIN or row[f"target_ph_T{i}"] > PH_MAX for i in range(1, 6))
        bad_turb = any(row[f"target_turb_T{i}"] > TURBIDEZ_MAX for i in range(1, 6))
        labels.append(int(bad_ph or bad_turb))

    return pd.DataFrame(rows), pd.Series(labels)


def temporal_split(X: np.ndarray, y: np.ndarray):
    train_end = int(len(X) * 0.7)
    valid_end = int(len(X) * 0.8)
    return (
        X[:train_end],
        y[:train_end],
        X[train_end:valid_end],
        y[train_end:valid_end],
        X[valid_end:],
        y[valid_end:],
    )


def best_threshold(y_true: np.ndarray, y_prob: np.ndarray) -> float:
    best = (0.5, -1.0)
    for threshold in np.arange(0.05, 0.96, 0.01):
        y_pred = (y_prob >= threshold).astype(int)
        score = f1_score(y_true, y_pred, zero_division=0)
        if score > best[1]:
            best = (float(threshold), float(score))
    return best[0]


df = pd.read_csv(DATA_PATH)
X_df, y = build_dataset(df)
X_train, y_train, X_valid, y_valid, X_test, y_test = temporal_split(X_df[FEATURES].values, y.values)

scaler = StandardScaler()
X_train_sc = scaler.fit_transform(X_train)
X_valid_sc = scaler.transform(X_valid)
X_test_sc = scaler.transform(X_test)

model = RandomForestClassifier(
    n_estimators=300,
    max_depth=12,
    min_samples_leaf=4,
    random_state=42,
    class_weight="balanced",
    n_jobs=1,
)
model.fit(X_train_sc, y_train)

valid_prob = model.predict_proba(X_valid_sc)[:, 1]
threshold = best_threshold(y_valid, valid_prob)
test_prob = model.predict_proba(X_test_sc)[:, 1]
test_pred = (test_prob >= threshold).astype(int)

accuracy = accuracy_score(y_test, test_pred)
precision = precision_score(y_test, test_pred, zero_division=0)
recall = recall_score(y_test, test_pred, zero_division=0)
f1 = f1_score(y_test, test_pred, zero_division=0)
auc = roc_auc_score(y_test, test_prob)
cm = confusion_matrix(y_test, test_pred)

lines = [
    "CENOTE MONITOR - REPORTE DE RIESGO GENERAL DE CONTAMINACION",
    "=" * 68,
    "",
    "Objetivo del modelo:",
    "  Predecir la probabilidad de contaminacion en los proximos 5 dias si no se actua.",
    "",
    "Definicion de riesgo preventivo:",
    f"  pH real futuro fuera de {PH_MIN:.1f}-{PH_MAX:.1f} en T+1 a T+5",
    f"  o turbidez real futura mayor a {TURBIDEZ_MAX:.1f} NTU en T+1 a T+5",
    "",
    "Validacion:",
    "  Split temporal: 70% entrenamiento, 10% validacion de umbral, 20% prueba final.",
    "  No se usan targets futuros ni proyecciones del target como features.",
    "",
    f"Features usados: {', '.join(FEATURES)}",
    f"Muestras train : {len(X_train)}",
    f"Muestras valid : {len(X_valid)}",
    f"Muestras test  : {len(X_test)}",
    f"Tasa positiva  : {np.mean(y):.2%}",
    "",
    "METRICAS GENERALES:",
    f"  Accuracy : {accuracy:.4f}",
    f"  Precision: {precision:.4f}",
    f"  Recall   : {recall:.4f}",
    f"  F1-score : {f1:.4f}",
    f"  ROC AUC  : {auc:.4f}",
    f"  Umbral decision: {threshold:.2f}",
    "",
    "MATRIZ DE CONFUSION:",
    "  Filas = real, columnas = predicho",
    f"  {cm.tolist()}",
    "",
    "IMPORTANCIA DE VARIABLES:",
]

for feat, imp in sorted(zip(FEATURES, model.feature_importances_), key=lambda item: -item[1]):
    lines.append(f"  {feat:<28}: {imp:.4f}")

metadata = {
    "model_type": "contamination_risk_classifier",
    "features": FEATURES,
    "decision_threshold": threshold,
    "thresholds": {
        "ph_min": PH_MIN,
        "ph_max": PH_MAX,
        "turbidez_max": TURBIDEZ_MAX,
        "risk_medium": 0.40,
        "risk_high": 0.70,
    },
    "metrics": {
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "roc_auc": auc,
    },
}

joblib.dump(model, MODEL_PATH)
joblib.dump(scaler, SCALER_PATH)
joblib.dump(metadata, METADATA_PATH)

with open(REPORT_PATH, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))

print("\n".join(lines))
