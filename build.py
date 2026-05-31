#!/usr/bin/env python3
"""
build.py — Script de build para Render
=======================================
Se ejecuta UNA VEZ durante el deploy.
1. Genera datos sintéticos de entrenamiento inicial
2. Entrena el modelo RandomForest
3. Deja el modelo listo para que la API arranque

Cuando la boya empiece a enviar datos reales, el modelo
se reentrenará automáticamente cada 100 lecturas nuevas.
"""
import subprocess
import sys
import os

BASE = os.path.dirname(os.path.abspath(__file__))

def run(script_path, description):
    print(f"\n{'='*60}")
    print(f"  {description}")
    print(f"{'='*60}")
    result = subprocess.run(
        [sys.executable, script_path],
        capture_output=False   # muestra output en tiempo real en Render logs
    )
    if result.returncode != 0:
        print(f"[ERROR] Fallo: {description}")
        sys.exit(1)
    print(f"[OK] Completado: {description}")

if __name__ == "__main__":
    run(
        os.path.join(BASE, "data", "generate_synthetic_data.py"),
        "Paso 1/2 — Generando datos sinteticos de entrenamiento"
    )
    run(
        os.path.join(BASE, "models", "train_model.py"),
        "Paso 2/2 — Entrenando modelo RandomForest (5 features, 10 outputs)"
    )
    print("\n[BUILD COMPLETO] API lista para arrancar.\n")
