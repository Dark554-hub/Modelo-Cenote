/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useEffect, useState, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { WifiOff, Bluetooth, Droplets, Brain, ShieldCheck, AlertTriangle, ShieldAlert, Waves } from "lucide-react";
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
    // Generar una clave con los valores para detectar cambios reales
    const key = `${lectura.ph}-${lectura.turbidez}-${lectura.temperatura}-${lectura.conductividad}`;
    if (key === lastDiagKey.current) return; // Sin cambios, no re-consultar
    lastDiagKey.current = key;

    try {
      // Solo mostrar spinner en la carga inicial
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
        // Solo re-diagnosticar si los datos cambiaron
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

  const chartColors = ["#C9A227", "#4A7C59", "#0EA5E9", "#A34A3E", "#8b5cf6"];

  const metricLabel: Record<string, { label: string; unit: string }> = {
    ph:          { label: "pH",           unit: "" },
    turbidez:    { label: "Turbidez",     unit: " NTU" },
    temperatura: { label: "Temperatura",  unit: " °C" },
    nitratos:    { label: "Nitratos",     unit: " mg/L" },
    conductividad: { label: "Conductividad", unit: " µS/cm" },
  };

  const getStatus = (key: string, val: number) => {
    if (key === "ph") {
      if (val >= 6.5 && val <= 8.0) return { label: "Óptimo",        color: "#4A7C59" };
      return                                { label: "Fuera de rango", color: "#A34A3E" };
    }
    if (key === "turbidez") {
      if (val <= 4) return { label: "Agua clara", color: "#4A7C59" };
      if (val <= 8) return { label: "Moderada",   color: "#C9A227" };
      return               { label: "Turbia",     color: "#A34A3E" };
    }
    if (key === "temperatura") {
      if (val <= 26.5) return { label: "Normal",  color: "#4A7C59" };
      return                  { label: "Elevada", color: "#C9A227" };
    }
    return { label: "—", color: "#64748b" };
  };

  // ── BUOY SELECTOR SCREEN ──
  if (!buoyReady) return null;

  if (!selectedBuoy) {
    return (
      <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--lympha-sand)" }}>
        <header
          style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #C9A22718" }}
          className="px-4 md:px-10 py-4 flex items-center justify-between shadow-sm"
        >
          <div className="h-8 w-auto flex items-center">
            <Image src="/logo.png" alt="Flotaya" width={100} height={32}
              style={{ objectFit: "contain", filter: "brightness(0)" }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          </div>
          <Link href="/recolector"
            className="flex items-center gap-2 px-4 py-2 md:px-5 md:py-2.5 rounded-full text-sm font-semibold transition-all active:scale-95"
            style={{ backgroundColor: "var(--lympha-walnut)", color: "#FFFFFF" }}>
            <Bluetooth className="w-4 h-4" />
            <span className="hidden sm:inline">Recolector</span>
          </Link>
        </header>

        <main className="flex-1 flex flex-col items-center justify-center px-4 py-10 md:py-16">
          <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: "var(--lympha-amber)" }}>
            RED DE MONITOREO
          </p>
          <h1 className="text-3xl md:text-5xl font-bold serif-italic mb-3 text-center" style={{ color: "var(--lympha-walnut)" }}>
            Selecciona una boya
          </h1>
          <p className="text-sm font-medium mb-8 md:mb-12 text-center max-w-sm" style={{ color: "#0F172A60" }}>
            Elige la boya cuyo monitoreo deseas consultar.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4 w-full max-w-xl">
            {BOYAS.map((num) => (
              <button
                key={num}
                onClick={() => selectBuoy(num)}
                className="rounded-2xl md:rounded-3xl p-4 md:p-6 border text-left transition-all active:scale-95 hover:shadow-md"
                style={{ backgroundColor: "#FFFFFF", borderColor: "#C9A22722" }}
              >
                <div className="flex items-center gap-2 mb-2 md:mb-3">
                  <div className="p-1.5 md:p-2 rounded-full" style={{ backgroundColor: "#C9A22715" }}>
                    <Waves className="w-3.5 h-3.5 md:w-4 md:h-4" style={{ color: "var(--lympha-amber)" }} />
                  </div>
                  <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--lympha-amber)" }}>
                    Boya
                  </span>
                </div>
                <p className="text-3xl md:text-4xl font-bold serif-italic" style={{ color: "var(--lympha-walnut)" }}>
                  {String(num).padStart(2, "0")}
                </p>
                <div className="mt-2 md:mt-3 flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span className="text-xs font-semibold" style={{ color: "#4A7C59" }}>Activa</span>
                </div>
              </button>
            ))}
          </div>
        </main>

        <footer className="px-4 md:px-10 py-4 text-center border-t" style={{ borderColor: "#C9A22718", backgroundColor: "#FFFFFF" }}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#0F172A35" }}>
            Flotaya · Soberanía Hídrica
          </p>
        </footer>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--lympha-sand)" }}>

      {/* ── HEADER ── */}
      <header
        style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #C9A22718" }}
        className="px-4 md:px-10 py-3 md:py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm"
      >
        <div className="flex items-center gap-3">
          <div className="h-8 w-auto flex items-center">
            <Image
              src="/logo.png" alt="Flotaya" width={90} height={30}
              style={{ objectFit: "contain", filter: "brightness(0)" }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          </div>
          <div className="flex items-center pl-3 border-l" style={{ borderColor: "#C9A22728" }}>
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--lympha-amber)" }}>
              Boya {String(selectedBuoy).padStart(2, "0")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold"
            style={{ color: error ? "#A34A3E" : "#4A7C59" }}>
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
            className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-all active:scale-95 border"
            style={{ borderColor: "var(--lympha-walnut)", color: "var(--lympha-walnut)", backgroundColor: "transparent" }}
          >
            <Waves className="w-4 h-4" />
            <span className="hidden sm:inline">Cambiar boya</span>
          </button>

          <Link
            href="/recolector"
            className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-all active:scale-95"
            style={{ backgroundColor: "var(--lympha-walnut)", color: "#FFFFFF" }}
          >
            <Bluetooth className="w-4 h-4" />
            <span className="hidden sm:inline">Recolector</span>
          </Link>
        </div>
      </header>

      {/* ── MAIN ── */}
      <main className="p-3 md:p-8">

        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <div
              className="w-10 h-10 border-4 rounded-full animate-spin"
              style={{ borderColor: "#C9A22725", borderTopColor: "var(--lympha-amber)" }}
            ></div>
            <p className="text-sm font-medium" style={{ color: "#0F172A60" }}>
              Sincronizando con la boya...
            </p>
          </div>

        ) : data.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-[50vh] rounded-3xl border-2 border-dashed"
            style={{ backgroundColor: "var(--lympha-cream)", borderColor: "#C9A22730" }}
          >
            <Droplets className="w-12 h-12 mb-4" style={{ color: "#C9A22740" }} />
            <h2 className="text-xl font-bold serif-italic" style={{ color: "var(--lympha-walnut)" }}>
              Sin lecturas aún
            </h2>
            <p className="text-sm mt-2 text-center max-w-sm px-4" style={{ color: "#0F172A70" }}>
              Usa el{" "}
              <Link href="/recolector" className="underline font-semibold" style={{ color: "var(--lympha-amber)" }}>
                Recolector Móvil
              </Link>{" "}
              para enviar datos desde la boya.
            </p>
          </div>

        ) : (
          <div className="space-y-8">

            {/* ── METRIC CARDS ── */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: "var(--lympha-amber)" }}>
                MONITOREO EN TIEMPO REAL
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mt-3 md:mt-4">
                {metrics.map((key) => {
                  const val = data[data.length - 1][key];
                  const status = getStatus(key, val);
                  const meta = metricLabel[key] ?? { label: key, unit: "" };
                  return (
                    <div
                      key={key}
                      className="rounded-2xl md:rounded-3xl p-4 md:p-5 relative overflow-hidden border"
                      style={{ backgroundColor: "var(--lympha-cream)", borderColor: "#C9A22722" }}
                    >
                      <p className="text-xs font-semibold uppercase tracking-widest mb-2 md:mb-3"
                        style={{ color: "var(--lympha-amber)" }}>
                        {meta.label}
                      </p>
                      <p className="text-3xl md:text-4xl font-bold tracking-tight serif-italic leading-none"
                        style={{ color: "var(--lympha-walnut)" }}>
                        {typeof val === "number" ? val.toFixed(1) : val}
                        <span className="text-base md:text-lg ml-1 font-normal" style={{ color: "#0F172A40" }}>
                          {meta.unit}
                        </span>
                      </p>
                      <span
                        className="inline-block mt-2 md:mt-3 text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{ backgroundColor: `${status.color}18`, color: status.color }}
                      >
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
                className="rounded-3xl p-6 md:p-8 border relative overflow-hidden"
                style={{
                  backgroundColor: "var(--lympha-cream)",
                  borderColor: diagnostico.clasificacion === "normal" ? "#4A7C5928"
                    : diagnostico.clasificacion === "advertencia" ? "#C9A22728"
                    : "#A34A3E28",
                }}
              >
                {/* Eyebrow + Header */}
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--lympha-amber)" }}>
                      INTELIGENCIA ARTIFICIAL
                    </p>
                    <div className="flex items-center gap-3">
                      <div
                        className="p-2.5 rounded-2xl"
                        style={{
                          backgroundColor: diagnostico.clasificacion === "normal" ? "#4A7C5915"
                            : diagnostico.clasificacion === "advertencia" ? "#C9A22715"
                            : "#A34A3E15",
                        }}
                      >
                        <Brain
                          className="w-5 h-5"
                          style={{
                            color: diagnostico.clasificacion === "normal" ? "#4A7C59"
                              : diagnostico.clasificacion === "advertencia" ? "#C9A227"
                              : "#A34A3E",
                          }}
                        />
                      </div>
                      <div>
                        <h2 className="text-xl font-bold serif-italic" style={{ color: "var(--lympha-walnut)" }}>
                          Diagnóstico ML
                        </h2>
                        <p className="text-xs font-medium" style={{ color: "#0F172A50" }}>
                          7,401 registros · NOM-127-SSA1-2021
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Classification badge */}
                  <div
                    className="flex items-center gap-2 px-4 py-2.5 rounded-full font-bold text-sm self-start"
                    style={{
                      backgroundColor: diagnostico.clasificacion === "normal" ? "#4A7C5918"
                        : diagnostico.clasificacion === "advertencia" ? "#C9A22718"
                        : "#A34A3E18",
                      color: diagnostico.clasificacion === "normal" ? "#4A7C59"
                        : diagnostico.clasificacion === "advertencia" ? "#C9A227"
                        : "#A34A3E",
                    }}
                  >
                    {diagnostico.clasificacion === "normal" && <ShieldCheck className="w-4 h-4" />}
                    {diagnostico.clasificacion === "advertencia" && <AlertTriangle className="w-4 h-4" />}
                    {diagnostico.clasificacion === "alerta" && <ShieldAlert className="w-4 h-4" />}
                    {diagnostico.clasificacion.toUpperCase()}
                  </div>
                </div>

                {/* Parameter tags */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                  {diagnostico.etiquetas.map((et, idx) => (
                    <div
                      key={idx}
                      className="rounded-2xl p-4 border"
                      style={{
                        backgroundColor: et.severidad === 0 ? "#4A7C5908" : et.severidad === 1 ? "#C9A22708" : "#A34A3E08",
                        borderColor: et.severidad === 0 ? "#4A7C5922" : et.severidad === 1 ? "#C9A22722" : "#A34A3E22",
                      }}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#0F172A55" }}>
                          {et.parametro}
                        </span>
                        <span
                          className="text-xs font-bold px-2 py-0.5 rounded-full"
                          style={{
                            backgroundColor: et.severidad === 0 ? "#4A7C5918" : et.severidad === 1 ? "#C9A22718" : "#A34A3E18",
                            color: et.severidad === 0 ? "#4A7C59" : et.severidad === 1 ? "#C9A227" : "#A34A3E",
                          }}
                        >
                          {et.estado}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed" style={{ color: "#0F172A70" }}>
                        {et.detalle}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Recommendations */}
                {diagnostico.recomendaciones.length > 0 && (
                  <div
                    className="rounded-2xl p-5 border"
                    style={{ backgroundColor: "var(--lympha-walnut)", borderColor: "#C9A22720" }}
                  >
                    <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: "#C9A22790" }}>
                      Recomendaciones del modelo
                    </p>
                    <ul className="space-y-2">
                      {diagnostico.recomendaciones.map((rec, idx) => (
                        <li key={idx} className="flex items-start gap-2 text-sm" style={{ color: "#FAF7F3DD" }}>
                          <span className="text-amber-400 mt-0.5 flex-shrink-0">›</span>
                          {rec}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Loading overlay */}
                {diagLoading && (
                  <div className="absolute inset-0 bg-white/50 backdrop-blur-sm flex items-center justify-center rounded-3xl">
                    <div
                      className="w-8 h-8 border-4 rounded-full animate-spin"
                      style={{ borderColor: "#C9A22725", borderTopColor: "var(--lympha-amber)" }}
                    ></div>
                  </div>
                )}
              </div>
            )}

            {/* ── CHARTS ── */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: "var(--lympha-amber)" }}>
                HISTÓRICO DE LECTURAS
              </p>
              <h2 className="text-2xl font-bold serif-italic mb-5" style={{ color: "var(--lympha-walnut)" }}>
                Evolución de Parámetros
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {metrics.map((key, i) => {
                  const color = chartColors[i % chartColors.length];
                  const meta = metricLabel[key] ?? { label: key, unit: "" };
                  return (
                    <div
                      key={`chart-${key}`}
                      className="rounded-3xl p-5 md:p-6 border"
                      style={{ backgroundColor: "var(--lympha-cream)", borderColor: "#C9A22720" }}
                    >
                      {/* Chart title: serif para el nombre de la métrica */}
                      <div className="flex items-start justify-between gap-2 mb-4">
                        <h3 className="text-base md:text-lg font-bold serif-italic" style={{ color: "var(--lympha-walnut)" }}>
                          {meta.label}
                          {meta.unit && (
                            <span className="text-sm font-normal ml-1" style={{ color: "#0F172A50", fontStyle: "normal" }}>
                              {meta.unit.trim()}
                            </span>
                          )}
                        </h3>
                        <span
                          className="text-xs font-medium px-2 py-0.5 rounded-md flex-shrink-0"
                          style={{ backgroundColor: `${color}15`, color, fontFamily: "var(--font-sans)" }}
                        >
                          {data.length}
                        </span>
                      </div>

                      <div className="h-[180px] md:h-[260px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#C9A22718" vertical={false} />
                            <XAxis
                              dataKey="timestamp"
                              tickFormatter={formatTime}
                              stroke="#0F172A20"
                              fontSize={11}
                              tickMargin={8}
                              tick={{ fill: "#0F172A55", fontWeight: 500, fontFamily: "Inter, sans-serif" }}
                            />
                            <YAxis
                              stroke="#0F172A20"
                              fontSize={11}
                              tickMargin={8}
                              domain={["auto", "auto"]}
                              tick={{ fill: "#0F172A55", fontWeight: 500, fontFamily: "Inter, sans-serif" }}
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: "var(--lympha-walnut)",
                                borderColor: "#C9A22740",
                                borderRadius: "14px",
                                padding: "10px 14px",
                                boxShadow: "0 8px 32px rgba(20,16,14,0.25)",
                                fontFamily: "Inter, sans-serif",
                              }}
                              itemStyle={{ color, fontWeight: 700, fontSize: 14 }}
                              labelStyle={{ color: "#C9A22790", fontSize: 11, marginBottom: 4 }}
                              labelFormatter={formatTime}
                            />
                            <Line
                              type="monotone"
                              dataKey={key}
                              stroke={color}
                              strokeWidth={2.5}
                              dot={false}
                              activeDot={{ r: 5, strokeWidth: 0, fill: color }}
                              animationDuration={400}
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
              <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: "var(--lympha-amber)" }}>
                REGISTROS
              </p>
              <h2 className="text-2xl font-bold serif-italic mb-5" style={{ color: "var(--lympha-walnut)" }}>
                Tabla de Lecturas — Boya {String(selectedBuoy).padStart(2, "0")}
              </h2>
              <div className="rounded-3xl border overflow-hidden" style={{ borderColor: "#C9A22720", backgroundColor: "var(--lympha-cream)" }}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ borderBottom: "1px solid #C9A22718", backgroundColor: "#C9A22708" }}>
                        <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-widest" style={{ color: "var(--lympha-amber)" }}>Fecha / Hora</th>
                        {metrics.map(key => (
                          <th key={key} className="text-right px-4 py-3 text-xs font-bold uppercase tracking-widest" style={{ color: "var(--lympha-amber)" }}>
                            {metricLabel[key]?.label ?? key}
                            {metricLabel[key]?.unit ? <span className="font-normal opacity-60 ml-1">{metricLabel[key].unit.trim()}</span> : null}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...data].reverse().slice(0, 50).map((row, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid #C9A22710" }} className="hover:bg-amber-50 transition-colors">
                          <td className="px-4 py-2.5 font-medium tabular-nums" style={{ color: "#0F172A70", fontSize: 12 }}>
                            {(() => { try { return format(new Date(row.timestamp), "dd/MM/yy HH:mm:ss"); } catch { return row.timestamp; } })()}
                          </td>
                          {metrics.map(key => {
                            const val = row[key];
                            const { label: _, color } = val !== undefined ? (() => { const s = getStatus(key, val); return { label: s.label, color: s.color }; })() : { label: "—", color: "#64748b" };
                            return (
                              <td key={key} className="px-4 py-2.5 text-right font-bold tabular-nums" style={{ color, fontSize: 13 }}>
                                {val !== undefined ? val : <span style={{ color: "#0F172A30" }}>—</span>}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-3 text-xs font-medium text-right" style={{ color: "#0F172A40", borderTop: "1px solid #C9A22710" }}>
                  Mostrando {Math.min(50, data.length)} de {data.length} registros
                </div>
              </div>
            </div>

          </div>
        )}
      </main>

      {/* ── FOOTER ── */}
      <footer className="px-4 py-4 text-center border-t" style={{ borderColor: "#C9A22718", backgroundColor: "#FFFFFF" }}>
        <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#0F172A35" }}>
          Flotaya · Soberanía Hídrica
        </p>
      </footer>
    </div>
  );
}
