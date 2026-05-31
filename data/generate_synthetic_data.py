import numpy as np
import pandas as pd
import os

np.random.seed(42)

# 180 días × 24 horas = 4 320 muestras horarias
N_DAYS = 180
HOURS_PER_DAY = 24
N = N_DAYS * HOURS_PER_DAY

time_idx = np.arange(N)
hours = time_idx % 24
days  = time_idx // 24

# ─── Temperatura del agua (°C) ────────────────────────────────────────────────
# Ciclo diurno + variación estacional lenta + ruido
base_temp = 28.0
temperatura_c = (
    base_temp
    + 4.0 * np.sin(2 * np.pi * (hours - 8) / 24)   # ciclo diurno
    + 2.0 * np.sin(2 * np.pi * days / 30)           # variación mensual
    + np.random.normal(0, 0.5, N)
)

# ─── Humedad relativa del ambiente (%) ───────────────────────────────────────
# Correlacionada inversamente con temperatura (más frío → más humedad)
# + ráfagas de alta humedad (simulan lluvias)
humedad_base = 78.0
humedad_pct = (
    humedad_base
    - 0.8 * (temperatura_c - base_temp)             # relación inversa con temp
    + 6.0 * np.sin(2 * np.pi * (hours - 4) / 24)   # pico de humedad al amanecer
    + np.random.normal(0, 2.5, N)
)
humedad_pct = np.clip(humedad_pct, 40, 98)

# ─── pH (autorregresivo) ─────────────────────────────────────────────────────
ph = np.zeros(N)
ph[0] = 7.4

for t in range(1, N):
    temp_eff   = (temperatura_c[t] - 28) * -0.005
    humid_eff  = (humedad_pct[t] - 78)   * -0.002   # lluvia/humedad baja el pH
    reversion  = (7.4 - ph[t-1]) * 0.05
    ph[t] = ph[t-1] + reversion + temp_eff + humid_eff + np.random.normal(0, 0.01)

ph = np.clip(ph, 5.5, 9.5)

# ─── Turbidez (NTU, autorregresiva) ──────────────────────────────────────────
turbidez = np.zeros(N)
turbidez[0] = 2.0

for t in range(1, N):
    humid_eff  = max(0, (humedad_pct[t] - 85)) * 0.12   # humedad alta → más turbidez
    reversion  = (2.0 - turbidez[t-1]) * 0.05
    turbidez[t] = turbidez[t-1] + reversion + humid_eff + np.random.normal(0, 0.15)
    turbidez[t] = max(0.1, turbidez[t])

# ─── Conductividad eléctrica (μS/cm) ─────────────────────────────────────────
# Cenotes típicos: 450–650 μS/cm
# Sube con temperatura, baja cuando hay dilución por agua dulce (humedad alta)
conductividad_us = (
    550.0
    + 4.0  * (temperatura_c - base_temp)            # más caliente → más conductividad
    - 1.5  * (humedad_pct - 78)                     # humedad alta (dilución) la baja
    + np.random.normal(0, 8, N)
)
conductividad_us = np.clip(conductividad_us, 300, 800)

# ─── Targets predictivos (T+1 a T+5 días) ────────────────────────────────────
df_dict = {
    'ph':               np.round(ph, 3),
    'turbidez_ntu':     np.round(turbidez, 2),
    'conductividad_us': np.round(conductividad_us, 1),
    'temperatura_c':    np.round(temperatura_c, 2),
    'humedad_pct':      np.round(humedad_pct, 1),
}

for d in range(1, 6):
    offset = 24 * d
    df_dict[f'target_ph_T{d}']   = np.round(np.roll(ph,       -offset), 3)
    df_dict[f'target_turb_T{d}'] = np.round(np.roll(turbidez, -offset), 2)

df = pd.DataFrame(df_dict)

# Eliminar últimas 120 filas (5 días) → rolls circulares inválidos
df = df.iloc[:-120]

# ─── Guardar ─────────────────────────────────────────────────────────────────
output_path = os.path.join(os.path.dirname(__file__), 'historical_data.csv')
df.to_csv(output_path, index=False)

print("=" * 60)
print("  GENERACION DE DATASET - NUEVOS SENSORES")
print("=" * 60)
print(f"[OK] Guardado en: {output_path}")
print(f"[INFO] Muestras validas: {len(df)}")
print(f"[INFO] Features: ph, turbidez_ntu, conductividad_us, temperatura_c, humedad_pct")
print(f"[INFO] Targets: pH y turbidez T+1 a T+5 dias")
