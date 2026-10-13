/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import forecastModelData from '@/data/forecast_model.json';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = 'https://dyaryhtlkzqtgmowwdqz.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR5YXJ5aHRsa3pxdGdtb3d3ZHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4NTA1MzUsImV4cCI6MjEwNzQyNjUzNX0.Yrm_nT1kRht59kFbVGHPqfCFUfQDEDos0kKUmJoYXNM';

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': ANON_KEY,
    'Authorization': `Bearer ${ANON_KEY}`,
  };
}

/**
 * Realiza el cálculo del modelo predictivo Ridge multivariado (10 targets a 5 días)
 */
function computeLocalForecast(reading: {
  ph: number;
  turbidez: number;
  temperatura: number;
  conductividad: number;
  humedad: number;
}) {
  const now = new Date();
  const hour = now.getHours();
  // Día del año aproximado
  const startOfYear = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - startOfYear.getTime();
  const oneDay = 1000 * 60 * 60 * 24;
  const dayOfYear = Math.floor(diff / oneDay);

  const ph = reading.ph;
  const turbidez = reading.turbidez;
  const conductividad = reading.conductividad;
  const temperatura = reading.temperatura;
  const humedad = reading.humedad;

  // 13 features exactamente iguales al entrenamiento
  const rawFeatures = [
    ph,
    turbidez,
    conductividad,
    temperatura,
    humedad,
    Math.abs(ph - 7.4),
    turbidez * humedad,
    temperatura * humedad,
    conductividad * temperatura,
    Math.sin((2 * Math.PI * hour) / 24),
    Math.cos((2 * Math.PI * hour) / 24),
    Math.sin((2 * Math.PI * dayOfYear) / 30),
    Math.cos((2 * Math.PI * dayOfYear) / 30),
  ];

  const means = forecastModelData.scaler.means;
  const stds = forecastModelData.scaler.stds;

  const scaledFeatures = rawFeatures.map((val, idx) => {
    const std = stds[idx] !== 0 ? stds[idx] : 1.0;
    return (val - means[idx]) / std;
  });

  const weights = forecastModelData.weights;
  const biases = forecastModelData.biases;

  // targets: 0..4 son pH T1..T5, 5..9 son turbidez T1..T5
  const phPreds: number[] = [];
  for (let i = 0; i < 5; i++) {
    let dot = biases[i];
    for (let j = 0; j < 13; j++) {
      dot += weights[i][j] * scaledFeatures[j];
    }
    const clipped = Math.max(5.5, Math.min(9.5, dot));
    phPreds.push(Math.round(clipped * 100) / 100);
  }

  const turbPreds: number[] = [];
  for (let i = 5; i < 10; i++) {
    let dot = biases[i];
    for (let j = 0; j < 13; j++) {
      dot += weights[i][j] * scaledFeatures[j];
    }
    const clipped = Math.max(0.1, dot);
    turbPreds.push(Math.round(clipped * 100) / 100);
  }

  const proyeccion = [];
  for (let i = 0; i < 5; i++) {
    const pVal = phPreds[i];
    const tVal = turbPreds[i];
    proyeccion.push({
      dia: i + 1,
      label: `+${i + 1} día${i > 0 ? 's' : ''}`,
      ph: pVal,
      turbidez_ntu: tVal,
      estado_ph: pVal >= 6.5 && pVal <= 8.5 ? 'Óptimo (NOM)' : 'Fuera de norma',
      estado_turb: tVal <= 4.0 ? 'Óptimo (NOM)' : tVal <= 8.0 ? 'Alerta' : 'Crítico',
    });
  }

  return proyeccion;
}

// GET /api/prediccion — Obtiene la predicción para la lectura más reciente de Supabase
export async function GET() {
  try {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/FLOTAYA?select=created_at,ph,turbidez_ntu,temperatura_c,conductividad_us,humedad_pct&order=created_at.desc&limit=1`,
      { headers: sbHeaders() }
    );

    if (!sbRes.ok) {
      return NextResponse.json({ success: false, error: 'Error consultando base de datos' }, { status: 500 });
    }

    const data = await sbRes.json();
    if (!data || data.length === 0) {
      return NextResponse.json({ success: false, error: 'No hay lecturas registradas' }, { status: 404 });
    }

    const latest = data[0];
    const reading = {
      ph: Number(latest.ph ?? 7.4),
      turbidez: Number(latest.turbidez_ntu ?? 1.5),
      temperatura: Number(latest.temperatura_c ?? 25.0),
      conductividad: Number(latest.conductividad_us ?? 550.0),
      humedad: Number(latest.humedad_pct ?? 75.0),
    };

    // Intentar consultar Render con timeout corto de 2s
    try {
      const renderRes = await fetch('https://modelo-cenote.onrender.com/prediccion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ph: reading.ph,
          turbidez_ntu: reading.turbidez,
          conductividad_us: reading.conductividad,
          temperatura_c: reading.temperatura,
          humedad_pct: reading.humedad,
        }),
        signal: AbortSignal.timeout(2500),
      });

      if (renderRes.ok) {
        const renderJson = await renderRes.json();
        return NextResponse.json({
          success: true,
          origen: 'render_fastapi',
          lectura_base: reading,
          proyeccion_5_dias: renderJson.proyeccion_5_dias,
          riesgo_general: renderJson.riesgo_general,
        });
      }
    } catch {
      // Si Render está suspendido o tarda, usar inferencia local instantánea
    }

    const proyeccion = computeLocalForecast(reading);
    return NextResponse.json({
      success: true,
      origen: 'local_ridge_engine',
      lectura_base: reading,
      proyeccion_5_dias: proyeccion,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Error calculando pronóstico' }, { status: 500 });
  }
}

// POST /api/prediccion — Recibe lecturas arbitrarias y pronostica a 5 días
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const reading = {
      ph: Number(body.ph ?? 7.4),
      turbidez: Number(body.turbidez ?? body.turbidez_ntu ?? 1.5),
      temperatura: Number(body.temperatura ?? body.temperatura_c ?? 25.0),
      conductividad: Number(body.conductividad ?? body.conductividad_us ?? 550.0),
      humedad: Number(body.humedad ?? body.humedad_pct ?? 75.0),
    };

    // Intentar consultar Render
    try {
      const renderRes = await fetch('https://modelo-cenote.onrender.com/prediccion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ph: reading.ph,
          turbidez_ntu: reading.turbidez,
          conductividad_us: reading.conductividad,
          temperatura_c: reading.temperatura,
          humedad_pct: reading.humedad,
        }),
        signal: AbortSignal.timeout(2500),
      });

      if (renderRes.ok) {
        const renderJson = await renderRes.json();
        return NextResponse.json({
          success: true,
          origen: 'render_fastapi',
          proyeccion_5_dias: renderJson.proyeccion_5_dias,
          riesgo_general: renderJson.riesgo_general,
        });
      }
    } catch {
      // Fallback local
    }

    const proyeccion = computeLocalForecast(reading);
    return NextResponse.json({
      success: true,
      origen: 'local_ridge_engine',
      proyeccion_5_dias: proyeccion,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Error procesando solicitud' }, { status: 400 });
  }
}
