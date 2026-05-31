/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';

const SUPABASE_URL = 'https://lbhlinueuscwwivazeyn.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxiaGxpbnVldXNjd3dpdmF6ZXluIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxOTA4MzYsImV4cCI6MjA5NTc2NjgzNn0.L9Y2lo_2tI-Nby-ZRGLFVkofJkdbGXIFKUL_qmuMD2w';

function headers() {
  return {
    'Content-Type': 'application/json',
    'apikey': ANON_KEY,
    'Authorization': `Bearer ${ANON_KEY}`,
  };
}

// GET /api/lecturas
export async function GET() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/FLOTAYA?select=created_at,ph,turbidez_ntu,temperatura_c,conductividad_us,humedad_pct&order=created_at.desc&limit=100`,
    { headers: headers() }
  );

  if (!res.ok) {
    const err = await res.json();
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }

  const data = await res.json();
  const formattedData = data.reverse().map((record: any) => ({
    timestamp: record.created_at,
    ph: record.ph,
    turbidez: record.turbidez_ntu,
    temperatura: record.temperatura_c,
    conductividad: record.conductividad_us,
    humedad: record.humedad_pct,
  }));

  return NextResponse.json({ success: true, data: formattedData });
}

// POST /api/lecturas
export async function POST(request: Request) {
  try {
    const payload = await request.json(); // Viene con: { ph, turbidez, temperatura, conductividad }

    // Para correr el modelo RandomForest y guardar predicciones en Supabase,
    // enviamos el payload a nuestra API FastAPI en Render:
    const body = {
      ph: payload.ph,
      turbidez_ntu: payload.turbidez,
      conductividad_us: payload.conductividad,
      temperatura_c: payload.temperatura,
      humedad_pct: payload.humedad || 70.0, // fallback si no viene humedad
    };

    const res = await fetch('https://modelo-cenote.onrender.com/nueva-lectura', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json();
      return NextResponse.json(
        { success: false, error: err.detail || 'Error en el servidor de predicción (Render)' },
        { status: 500 }
      );
    }

    const data = await res.json(); // Retorna { guardado, pronostico_5d, diagnostico }
    
    // Devolvemos formato compatible con el recolector
    return NextResponse.json(
      { success: true, message: 'Lectura guardada y diagnosticada por ML', record: data },
      { status: 201 }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Payload inválido' },
      { status: 400 }
    );
  }
}
