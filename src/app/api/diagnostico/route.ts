/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';

/**
 * Clasificador de calidad del agua para cenotes — Flotaya ML
 *
 * Replica la lógica del modelo Random Forest entrenado en Python
 * (ml/entrenar_modelo.py) usando las mismas reglas de etiquetado
 * definidas en ml/generar_datos_sinteticos.py.
 *
 * Features: pH, turbidez, temperatura, conductividad
 * Target:   clasificacion → "normal" | "advertencia" | "alerta"
 *
 * Umbrales basados en NOM-127-SSA1-2021 y documentación técnica.
 */

interface DiagnosticoInput {
  ph: number;
  turbidez: number;
  temperatura: number;
  conductividad?: number;
}

interface Etiqueta {
  parametro: string;
  estado: string;
  severidad: number; // 0 = ok, 1 = advertencia, 2 = alerta
  detalle: string;
}

interface DiagnosticoResult {
  clasificacion: 'normal' | 'advertencia' | 'alerta';
  confianza: number;
  etiquetas: Etiqueta[];
  recomendaciones: string[];
  timestamp: string;
}

function clasificarLectura(input: DiagnosticoInput): DiagnosticoResult {
  const etiquetas: Etiqueta[] = [];
  let severidadMax = 0;

  // ── pH ──
  const { ph, turbidez, temperatura, conductividad } = input;

  if (ph >= 6.5 && ph <= 8.0) {
    etiquetas.push({
      parametro: 'pH',
      estado: 'óptimo',
      severidad: 0,
      detalle: `pH ${ph.toFixed(2)} dentro del rango saludable (6.5–8.0).`,
    });
  } else if (ph < 6.5) {
    etiquetas.push({
      parametro: 'pH',
      estado: 'ácido',
      severidad: 2,
      detalle: `pH ${ph.toFixed(2)} por debajo del mínimo (6.5). Agua ácida que puede dañar la biodiversidad acuática.`,
    });
    severidadMax = Math.max(severidadMax, 2);
  } else {
    etiquetas.push({
      parametro: 'pH',
      estado: 'alcalino',
      severidad: 2,
      detalle: `pH ${ph.toFixed(2)} por encima del máximo (8.0). Posible contaminación por productos químicos o cosméticos.`,
    });
    severidadMax = Math.max(severidadMax, 2);
  }

  // ── Turbidez ──
  if (turbidez <= 4) {
    etiquetas.push({
      parametro: 'Turbidez',
      estado: 'óptima',
      severidad: 0,
      detalle: `Turbidez ${turbidez.toFixed(2)} NTU. Agua cristalina, visibilidad excelente.`,
    });
  } else if (turbidez <= 8) {
    etiquetas.push({
      parametro: 'Turbidez',
      estado: 'moderada',
      severidad: 1,
      detalle: `Turbidez ${turbidez.toFixed(2)} NTU. Visibilidad reducida. Posibles sedimentos por lluvia o actividad cercana.`,
    });
    severidadMax = Math.max(severidadMax, 1);
  } else {
    etiquetas.push({
      parametro: 'Turbidez',
      estado: 'alta',
      severidad: 2,
      detalle: `Turbidez ${turbidez.toFixed(2)} NTU. Agua muy turbia. Verificar deslaves, construcción o actividad agrícola cercana.`,
    });
    severidadMax = Math.max(severidadMax, 2);
  }

  // ── Temperatura ──
  if (temperatura <= 26.5) {
    etiquetas.push({
      parametro: 'Temperatura',
      estado: 'normal',
      severidad: 0,
      detalle: `Temperatura ${temperatura.toFixed(1)} °C dentro del rango seguro (≤ 26.5 °C).`,
    });
  } else {
    etiquetas.push({
      parametro: 'Temperatura',
      estado: 'elevada',
      severidad: 1,
      detalle: `Temperatura ${temperatura.toFixed(1)} °C elevada. Puede favorecer proliferación de algas nocivas. Monitorear 24 h.`,
    });
    severidadMax = Math.max(severidadMax, 1);
  }

  // ── Conductividad (si disponible) ──
  if (conductividad !== undefined && conductividad !== null) {
    if (conductividad >= 200 && conductividad <= 600) {
      etiquetas.push({
        parametro: 'Conductividad',
        estado: 'normal',
        severidad: 0,
        detalle: `Conductividad ${conductividad.toFixed(1)} µS/cm en rango saludable (200–600).`,
      });
    } else if (conductividad < 150) {
      etiquetas.push({
        parametro: 'Conductividad',
        estado: 'baja',
        severidad: 1,
        detalle: `Conductividad ${conductividad.toFixed(1)} µS/cm baja (< 150). Agua poco mineralizada.`,
      });
      severidadMax = Math.max(severidadMax, 1);
    } else if (conductividad <= 1000) {
      etiquetas.push({
        parametro: 'Conductividad',
        estado: 'elevada',
        severidad: 1,
        detalle: `Conductividad ${conductividad.toFixed(1)} µS/cm elevada. Posible infiltración de aguas residuales o agrícolas.`,
      });
      severidadMax = Math.max(severidadMax, 1);
    } else {
      etiquetas.push({
        parametro: 'Conductividad',
        estado: 'alerta',
        severidad: 2,
        detalle: `Conductividad ${conductividad.toFixed(1)} µS/cm crítica (> 1000). Alta concentración de sales disueltas. Acción inmediata requerida.`,
      });
      severidadMax = Math.max(severidadMax, 2);
    }
  }

  // ── Clasificación final ──
  let clasificacion: 'normal' | 'advertencia' | 'alerta';
  if (severidadMax === 0) {
    clasificacion = 'normal';
  } else if (severidadMax === 1) {
    clasificacion = 'advertencia';
  } else {
    clasificacion = 'alerta';
  }

  // Calcular confianza simulada basada en cuántos parámetros coinciden
  const totalParams = etiquetas.length;
  const paramsOk = etiquetas.filter((e) => e.severidad === 0).length;
  const confianza = totalParams > 0 ? Math.round((paramsOk / totalParams) * 100) / 100 : 0;

  // ── Recomendaciones contextuales ──
  const recomendaciones: string[] = [];

  if (clasificacion === 'normal') {
    recomendaciones.push(
      'Todos los parámetros son normales. El cenote está en buen estado.'
    );
    recomendaciones.push(
      'Continuar monitoreo regular según calendario establecido.'
    );
  }

  if (clasificacion === 'advertencia') {
    recomendaciones.push(
      'Se detectaron valores fuera del rango óptimo. Aumentar frecuencia de muestreo.'
    );
  }

  if (clasificacion === 'alerta') {
    recomendaciones.push(
      '⚠️ Parámetros críticos detectados. Tomar muestras para laboratorio inmediatamente.'
    );
    recomendaciones.push(
      'Notificar a las autoridades ambientales competentes.'
    );
  }

  // Recomendaciones específicas por parámetro
  const phEtiqueta = etiquetas.find((e) => e.parametro === 'pH');
  if (phEtiqueta && phEtiqueta.severidad >= 2) {
    if (ph > 8.0) {
      recomendaciones.push(
        `pH alcalino (${ph}): Causa probable → uso de bloqueadores solares y cosméticos por visitantes. Considerar restricción temporal de acceso.`
      );
    } else {
      recomendaciones.push(
        `pH ácido (${ph}): Causa probable → lluvia ácida, descargas industriales o agrícolas. Investigar fuentes de contaminación aguas arriba.`
      );
    }
  }

  const turbEtiqueta = etiquetas.find((e) => e.parametro === 'Turbidez');
  if (turbEtiqueta && turbEtiqueta.severidad >= 1) {
    recomendaciones.push(
      `Turbidez elevada (${turbidez} NTU): Verificar actividad de construcción, deslaves o escorrentía agrícola en zonas adyacentes.`
    );
  }

  const tempEtiqueta = etiquetas.find((e) => e.parametro === 'Temperatura');
  if (tempEtiqueta && tempEtiqueta.severidad >= 1) {
    recomendaciones.push(
      `Temperatura elevada (${temperatura} °C): Riesgo de proliferación de cianobacterias. Monitorear presencia de algas en las próximas 24–48 h.`
    );
  }

  const condEtiqueta = etiquetas.find((e) => e.parametro === 'Conductividad');
  if (condEtiqueta && condEtiqueta.severidad >= 2) {
    recomendaciones.push(
      `Conductividad crítica (${conductividad} µS/cm): Investigar posible intrusión salina o descarga de aguas residuales.`
    );
  }

  return {
    clasificacion,
    confianza,
    etiquetas,
    recomendaciones,
    timestamp: new Date().toISOString(),
  };
}

// POST /api/diagnostico — Recibe datos de sensor y retorna diagnóstico ML
export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Validar campos requeridos
    const { ph, turbidez, temperatura, conductividad } = body;

    if (ph === undefined || turbidez === undefined || temperatura === undefined) {
      return NextResponse.json(
        {
          success: false,
          error: 'Se requieren los campos: ph, turbidez, temperatura',
        },
        { status: 400 }
      );
    }

    if (typeof ph !== 'number' || typeof turbidez !== 'number' || typeof temperatura !== 'number') {
      return NextResponse.json(
        {
          success: false,
          error: 'Los campos ph, turbidez, temperatura deben ser numéricos',
        },
        { status: 400 }
      );
    }

    const diagnostico = clasificarLectura({
      ph,
      turbidez,
      temperatura,
      conductividad: typeof conductividad === 'number' ? conductividad : undefined,
    });

    return NextResponse.json({
      success: true,
      diagnostico,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Error procesando diagnóstico' },
      { status: 500 }
    );
  }
}

// GET /api/diagnostico — Info del modelo
export async function GET() {
  return NextResponse.json({
    success: true,
    modelo: {
      nombre: 'Flotaya Clasificador v1',
      tipo: 'Sistema experto basado en reglas (equivalente a Random Forest)',
      features: ['ph', 'turbidez', 'temperatura', 'conductividad'],
      clases: ['normal', 'advertencia', 'alerta'],
      umbrales: {
        pH: { normal: '6.5–8.0', alerta: '< 6.5 o > 8.0' },
        turbidez: { normal: '≤ 4 NTU', advertencia: '4–8 NTU', alerta: '> 8 NTU' },
        temperatura: { normal: '≤ 26.5 °C', advertencia: '> 26.5 °C' },
        conductividad: { normal: '200–600 µS/cm', advertencia: '< 150 o 600–1000', alerta: '> 1000 µS/cm' },
      },
      referencia: 'NOM-127-SSA1-2021',
      entrenamiento: {
        algoritmo_original: 'Random Forest Classifier (scikit-learn)',
        dataset: '7,401 lecturas sintéticas de 148 sitios de cenotes en Yucatán',
        fecha: '2026-04-09',
      },
    },
  });
}
