/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useEffect, useState, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { WifiOff, Bluetooth, Droplets, Brain, ShieldCheck, AlertTriangle, ShieldAlert, Waves, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import Link from "next/link";
import Image from "next/image";

interface DiagnosticoEtiqueta {
  parametro: string;
  estado: string;
  severidad: number;
  detalle: string;
}

interface DiagnosticoResult {
  clasificacion: "normal" | "advertencia" | "alerta";
  confianza: number;
  etiquetas: DiagnosticoEtiqueta[];
  recomendaciones: string[];
  timestamp: string;
}

const BOYAS = [1, 2, 3, 4, 5, 6];

export default function Dashboard() {
  const [selectedBuoy, setSelectedBuoy] = useState<number | null>(null);
  const [buoyReady, setBuoyReady] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("flotaya_boya");
    if (saved) setSelectedBuoy(parseInt(saved));
    setBuoyReady(true);
  }, []);

  const selectBuoy = (n: number | null) => {
    setSelectedBuoy(n);
    if (n === null) localStorage.removeItem("flotaya_boya");
    else localStorage.setItem("flotaya_boya", String(n));
  };
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<string[]>(["ph", "turbidez", "temperatura", "conductividad"]);
  const [diagnostico, setDiagnostico] = useState<DiagnosticoResult | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const lastDiagKey = React.useRef<string>("");

  const fetchDiagnostico = useCallback(async (lectura: any, isInitial: boolean) => {
    const key = `${lectura.ph}-${lectura.turbidez}-${lectura.temperatura}-${lectura.conductividad}`;
    if (key === lastDiagKey.current) return;
    lastDiagKey.current = key;

    try {
      if (isInitial) setDiagLoading(true);
      const res = await fetch("/api/diagnostico", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ph: lectura.ph,
          turbidez: lectura.turbidez,
          temperatura: lectura.temperatura,
          conductividad: lectura.conductividad,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.success) setDiagnostico(json.diagnostico);
      }
    } catch { /* silently fail */ }
    finally { if (isInitial) setDiagLoading(false); }
  }, []);

  const isFirstLoad = React.useRef(true);

  const fetchData = async () => {
    try {
      const res = await fetch("/api/lecturas");
      if (!res.ok) throw new Error("Error en la respuesta");
      const json = await res.json();
      const records = json.data || [];
      setData(records);
      setError(null);
      if (records.length > 0) {
        const last = records[records.length - 1];
        const keys = Object.keys(last).filter(k => typeof last[k] === "number" && k !== "id");
        setMetrics(keys);
        fetchDiagnostico(last, isFirstLoad.current);
        isFirstLoad.current = false;
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      if (loading) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 5000);
    return () => clearInterval(t);
  }, []);

  const formatTime = (tick: any) => {
    try { return format(new Date(tick), "HH:mm"); } catch { return tick; }
  };

  const chartColors = ["var(--lympha-accent)", "#166534", "#0ea5e9", "#991b1b", "#8b5cf6"];

  const metricLabel: Record<string, { label: string; unit: string }> = {
    ph:          { label: "pH",           unit: "" },
    turbidez:    { label: "Turbidez",     unit: " NTU" },
    temperatura: { label: "Temperatura",  unit: " °C" },
    nitratos:    { label: "Nitratos",     unit: " mg/L" },
    conductividad: { label: "Conductividad", unit: " µS/cm" },
  };

  const getStatus = (key: string, val: number) => {
    if (key === "ph") {
      if (val >= 6.5 && val <= 8.0) return { label: "Óptimo",        color: "var(--lympha-green)" };
      return                                { label: "Fuera de rango", color: "var(--lympha-red)" };
    }
    if (key === "turbidez") {
      if (val <= 4) return { label: "Agua clara", color: "var(--lympha-green)" };
      if (val <= 8) return { label: "Moderada",   color: "var(--lympha-yellow)" };
      return               { label: "Turbia",     color: "var(--lympha-red)" };
    }
    if (key === "temperatura") {
      if (val <= 26.5) return { label: "Normal",  color: "var(--lympha-green)" };
      return                  { label: "Elevada", color: "var(--lympha-yellow)" };
    }
    return { label: "—", color: "var(--lympha-muted)" };
  };

  // ── BUOY SELECTOR SCREEN ──
  if (!buoyReady) return null;

  if (!selectedBuoy) {
    return (
      <div className="min-h-screen flex flex-col bg-[var(--lympha-bg)]">
        <header className="px-4 md:px-10 py-4 flex items-center justify-between border-b border-slate-200 bg-white">
          <div className="h-8 w-auto flex items-center">
            <Image src="/logo.png" alt="Flotaya" width={100} height={32}
              style={{ objectFit: "contain", filter: "brightness(0)" }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          </div>
          <Link href="/recolector"
            className="flex items-center gap-2 px-4 py-2 md:px-5 md:py-2.5 rounded-md text-sm font-semibold transition-all active:scale-97 bg-slate-900 text-white hover:bg-slate-800">
            <Bluetooth className="w-4 h-4" />
            <span className="hidden sm:inline">Recolector</span>
          </Link>
        </header>

        <main className="flex-1 flex flex-col items-center justify-center px-4 py-10 md:py-16">
          <p className="text-xs font-bold uppercase tracking-widest mb-2 text-[var(--lympha-accent)]">
            Red de Monitoreo
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold mb-2 text-center text-slate-800 tracking-tight">
            Selecciona una boya
          </h1>
          <p className="text-sm text-slate-500 mb-8 md:mb-12 text-center max-w-sm">
            Consulta los datos en tiempo real de los sensores hídricos.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 w-full max-w-xl">
            {BOYAS.map((num) => (
              <button
                key={num}
                onClick={() => selectBuoy(num)}
                className="rounded-md p-5 border border-slate-200 text-left transition-all active:scale-97 hover:border-slate-400 bg-white hover:shadow-sm"
              >
                <div className="flex items-center gap-2 mb-2">
                  <Waves className="w-4 h-4 text-[var(--lympha-accent)]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Boya
                  </span>
                </div>
                <p className="text-3xl font-extrabold text-slate-800 font-mono">
                  {String(num).padStart(2, "0")}
                </p>
                <div className="mt-4 flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span className="text-xs font-semibold text-emerald-700">Activa</span>
                </div>
              </button>
            ))}
          </div>
        </main>

        <footer className="px-4 md:px-10 py-4 text-center border-t border-slate-200 bg-white">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Flotaya · Soberanía Hídrica
          </p>
        </footer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--lympha-bg)]">

      {/* ── HEADER ── */}
      <header className="px-4 md:px-10 py-3.5 flex items-center justify-between sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="flex items-center gap-4">
          <div className="h-8 w-auto flex items-center">
            <Image
              src="/logo.png" alt="Flotaya" width={90} height={30}
              style={{ objectFit: "contain", filter: "brightness(0)" }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          </div>
          <div className="flex items-center pl-3 border-l border-slate-200">
            <p className="text-xs font-bold uppercase tracking-wider text-[var(--lympha-accent)]">
              Boya {String(selectedBuoy).padStart(2, "0")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1.5 text-xs font-bold ${error ? "text-red-700" : "text-emerald-700"}`}>
            {error ? (
              <WifiOff className="w-3.5 h-3.5" />
            ) : (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
            )}
            <span className="hidden sm:inline">{error ? "Sin señal" : "En vivo"}</span>
          </div>

          <button
            onClick={() => selectBuoy(null)}
            className="flex items-center gap-2 px-3.5 py-1.5 rounded-md text-xs font-bold transition-all active:scale-97 border border-slate-300 text-slate-700 bg-white hover:bg-slate-50"
          >
            <Waves className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Cambiar boya</span>
          </button>

          <Link
            href="/recolector"
            className="flex items-center gap-2 px-3.5 py-1.5 rounded-md text-xs font-bold transition-all active:scale-97 bg-slate-900 text-white hover:bg-slate-800"
          >
            <Bluetooth className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Recolector</span>
          </Link>
        </div>
      </header>

      {/* ── MAIN ── */}
      <main className="max-w-7xl mx-auto p-4 md:p-8 space-y-8">

        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <div className="w-8 h-8 border-4 border-slate-200 border-t-[var(--lympha-accent)] rounded-full animate-spin"></div>
            <p className="text-xs font-semibold text-slate-500">
              Sincronizando con la boya...
            </p>
          </div>

        ) : data.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[40vh] rounded-md border border-dashed border-slate-300 bg-white p-8">
            <Droplets className="w-10 h-10 mb-3 text-slate-300" />
            <h2 className="text-lg font-bold text-slate-800">
              Sin lecturas aún
            </h2>
            <p className="text-xs text-slate-500 mt-1 text-center max-w-xs leading-relaxed">
              Usa el{" "}
              <Link href="/recolector" className="text-[var(--lympha-accent)] font-bold hover:underline">
                Recolector Móvil
              </Link>{" "}
              para enviar datos desde la boya.
            </p>
          </div>

        ) : (
          <div className="space-y-8">

            {/* ── METRIC READINGS (GRID SYSTEM - NO INDIVIDUAL CARDS) ── */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">
                Monitoreo en tiempo real
              </p>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-y-6 gap-x-8 border-y border-slate-200 py-6 bg-white px-6 rounded-md border">
                {metrics.map((key) => {
                  const val = data[data.length - 1][key];
                  const status = getStatus(key, val);
                  const meta = metricLabel[key] ?? { label: key, unit: "" };
                  return (
                    <div key={key} className="flex flex-col">
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                        {meta.label}
                      </span>
                      <span className="text-3xl font-extrabold tracking-tight text-slate-800 font-mono">
                        {typeof val === "number" ? val.toFixed(1) : val}
                        <span className="text-sm font-normal text-slate-400 ml-1 font-sans">
                          {meta.unit}
                        </span>
                      </span>
                      <span className="text-xs mt-2 font-bold flex items-center gap-1.5" style={{ color: status.color }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: status.color }} />
                        {status.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── ML DIAGNOSTIC PANEL ── */}
            {diagnostico && (
              <div
                className="p-6 border relative overflow-hidden rounded-md"
                style={{
                  backgroundColor: diagnostico.clasificacion === "normal" ? "var(--lympha-green-bg)"
                    : diagnostico.clasificacion === "advertencia" ? "var(--lympha-yellow-bg)"
                    : "var(--lympha-red-bg)",
                  borderColor: diagnostico.clasificacion === "normal" ? "#16653420"
                    : diagnostico.clasificacion === "advertencia" ? "#854d0e20"
                    : "#991b1b20",
                }}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                      Análisis Predictivo
                    </p>
                    <div className="flex items-center gap-3">
                      <div
                        className="p-2 rounded-md"
                        style={{
                          backgroundColor: diagnostico.clasificacion === "normal" ? "#16653415"
                            : diagnostico.clasificacion === "advertencia" ? "#854d0e15"
                            : "#991b1b15",
                        }}
                      >
                        <Brain
                          className="w-5 h-5"
                          style={{
                            color: diagnostico.clasificacion === "normal" ? "var(--lympha-green)"
                              : diagnostico.clasificacion === "advertencia" ? "var(--lympha-yellow)"
                              : "var(--lympha-red)",
                          }}
                        />
                      </div>
                      <div>
                        <h2 className="text-lg font-bold text-slate-800">
                          Diagnóstico ML
                        </h2>
                        <p className="text-xs font-medium text-slate-500">
                          Basado en 1,400 registros históricos · NOM-127-SSA1-2021
                        </p>
                      </div>
                    </div>
                  </div>

                  <div
                    className="flex items-center gap-1.5 px-3 py-1 rounded-md font-bold text-xs self-start uppercase tracking-wider"
                    style={{
                      backgroundColor: diagnostico.clasificacion === "normal" ? "#16653415"
                        : diagnostico.clasificacion === "advertencia" ? "#854d0e15"
                        : "#991b1b15",
                      color: diagnostico.clasificacion === "normal" ? "var(--lympha-green)"
                        : diagnostico.clasificacion === "advertencia" ? "var(--lympha-yellow)"
                        : "var(--lympha-red)",
                    }}
                  >
                    {diagnostico.clasificacion === "normal" && <ShieldCheck className="w-3.5 h-3.5" />}
                    {diagnostico.clasificacion === "advertencia" && <AlertTriangle className="w-3.5 h-3.5" />}
                    {diagnostico.clasificacion === "alerta" && <ShieldAlert className="w-3.5 h-3.5" />}
                    {diagnostico.clasificacion}
                  </div>
                </div>

                {/* Parameter tags - Flat vertical layout, NO nested cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-6 py-4 border-y border-slate-200/50">
                  {diagnostico.etiquetas.map((et, idx) => {
                    const dotColor = et.severidad === 0 ? "var(--lympha-green)" : et.severidad === 1 ? "var(--lympha-yellow)" : "var(--lympha-red)";
                    return (
                      <div key={idx} className="flex flex-col">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: dotColor }} />
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                            {et.parametro}
                          </span>
                          <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded uppercase ml-auto" style={{ backgroundColor: `${dotColor}15`, color: dotColor }}>
                            {et.estado}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 leading-relaxed">
                          {et.detalle}
                        </p>
                      </div>
                    );
                  })}
                </div>

                {/* Recommendations - Integrated flat text block, NO nested cards */}
                {diagnostico.recomendaciones.length > 0 && (
                  <div className="mt-4 pt-2">
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                      Recomendaciones del Modelo
                    </p>
                    <ul className="space-y-2">
                      {diagnostico.recomendaciones.map((rec, idx) => (
                        <li key={idx} className="flex items-start gap-2 text-xs text-slate-600 leading-relaxed">
                          <ChevronRight className="w-3.5 h-3.5 text-slate-400 mt-0.5 flex-shrink-0" />
                          <span>{rec}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Loading overlay */}
                {diagLoading && (
                  <div className="absolute inset-0 bg-white/60 backdrop-blur-xs flex items-center justify-center">
                    <div className="w-6 h-6 border-3 border-slate-200 border-t-[var(--lympha-accent)] rounded-full animate-spin"></div>
                  </div>
                )}
              </div>
            )}

            {/* ── CHARTS ── */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                Histórico de lecturas
              </p>
              <h2 className="text-xl font-extrabold text-slate-800 mb-4 tracking-tight">
                Evolución de Parámetros
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {metrics.map((key, i) => {
                  const color = chartColors[i % chartColors.length];
                  const meta = metricLabel[key] ?? { label: key, unit: "" };
                  return (
                    <div
                      key={`chart-${key}`}
                      className="rounded-md p-5 border border-slate-200 bg-white"
                    >
                      <div className="flex items-center justify-between gap-2 mb-4">
                        <h3 className="text-sm font-bold text-slate-800">
                          {meta.label}
                          {meta.unit && (
                            <span className="text-xs font-normal text-slate-400 ml-1">
                              ({meta.unit.trim()})
                            </span>
                          )}
                        </h3>
                        <span
                          className="text-[10px] font-extrabold px-1.5 py-0.5 rounded-md flex-shrink-0 font-mono"
                          style={{ backgroundColor: `${color}15`, color }}
                        >
                          {data.length} pts
                        </span>
                      </div>

                      <div className="h-[200px] md:h-[240px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                            <XAxis
                              dataKey="timestamp"
                              tickFormatter={formatTime}
                              stroke="#cbd5e1"
                              fontSize={10}
                              tickMargin={8}
                              tick={{ fill: "#64748b", fontWeight: 500, fontFamily: "var(--font-mono)" }}
                            />
                            <YAxis
                              stroke="#cbd5e1"
                              fontSize={10}
                              tickMargin={8}
                              domain={["auto", "auto"]}
                              tick={{ fill: "#64748b", fontWeight: 500, fontFamily: "var(--font-mono)" }}
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: "#0f172a",
                                borderColor: "#334155",
                                borderRadius: "6px",
                                padding: "8px 12px",
                                fontFamily: "var(--font-mono)",
                              }}
                              itemStyle={{ color, fontWeight: 700, fontSize: 13 }}
                              labelStyle={{ color: "#94a3b8", fontSize: 10, marginBottom: 4 }}
                              labelFormatter={formatTime}
                            />
                            <Line
                              type="monotone"
                              dataKey={key}
                              stroke={color}
                              strokeWidth={2}
                              dot={false}
                              activeDot={{ r: 4, strokeWidth: 0, fill: color }}
                              animationDuration={300}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── DATA TABLE ── */}
            <div className="mt-8">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                Registros
              </p>
              <h2 className="text-xl font-extrabold text-slate-800 mb-4 tracking-tight">
                Tabla de Lecturas — Boya {String(selectedBuoy).padStart(2, "0")}
              </h2>
              
              <div className="rounded-md border border-slate-200 overflow-hidden bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50">
                        <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-slate-500">Fecha / Hora</th>
                        {metrics.map(key => (
                          <th key={key} className="text-right px-4 py-3 font-bold uppercase tracking-wider text-slate-500">
                            {metricLabel[key]?.label ?? key}
                            {metricLabel[key]?.unit ? <span className="font-normal opacity-60 ml-1">({metricLabel[key].unit.trim()})</span> : null}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {[...data].reverse().slice(0, 50).map((row, i) => (
                        <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-4 py-2.5 font-medium text-slate-500 font-mono">
                            {(() => { try { return format(new Date(row.timestamp), "dd/MM/yy HH:mm:ss"); } catch { return row.timestamp; } })()}
                          </td>
                          {metrics.map(key => {
                            const val = row[key];
                            const { color } = val !== undefined ? getStatus(key, val) : { color: "var(--lympha-muted)" };
                            return (
                              <td key={key} className="px-4 py-2.5 text-right font-bold font-mono" style={{ color }}>
                                {val !== undefined ? val.toFixed(1) : <span className="text-slate-300">—</span>}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-3 text-[10px] font-semibold text-slate-400 text-right border-t border-slate-200 bg-slate-50">
                  Mostrando {Math.min(50, data.length)} de {data.length} registros
                </div>
              </div>
            </div>

          </div>
        )}
      </main>

      {/* ── FOOTER ── */}
      <footer className="px-4 py-6 text-center border-t border-slate-200 bg-white mt-12">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Flotaya · Soberanía Hídrica
        </p>
      </footer>
    </div>
  );
}
