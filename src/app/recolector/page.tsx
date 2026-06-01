/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useState, useEffect } from "react";
import {
  Bluetooth, LayoutDashboard, RefreshCw, Database,
  Search, Wifi, WifiOff, CloudUpload, Activity,
  AlertCircle, Droplets, ChevronRight
} from "lucide-react";
import Link from "next/link";
import Image from "next/image";

interface PendingRead {
  id: string;
  data: any;
  timestamp: string;
}

interface SensorPayload {
  ph: number;
  turbidez: number;
  temperatura: number;
  conductividad?: number;
}

interface BleLogItem {
  at: string;
  raw: string;
  status: "ok" | "invalid";
}

const ESP32_DEVICE_NAME = "SatoruBoyon";
const BLE_SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
const BLE_CHARACTERISTIC_UUID = "abcdefab-1234-1234-1234-abcdefabcdef";
const BLE_FALLBACK_SERVICE_UUIDS = [
  BLE_SERVICE_UUID,
  "4fafc201-1fb5-459e-8fcc-c5c9c331914b", // ESP32 BLE example service
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART Service
  "0000ffe0-0000-1000-8000-00805f9b34fb", // HM-10 style service
];
const BLE_FALLBACK_CHARACTERISTIC_UUIDS = [
  BLE_CHARACTERISTIC_UUID,
  "beb5483e-36e1-4688-b7f5-ea07361b26a8", // ESP32 BLE example characteristic
  "6e400003-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART TX (notify)
  "0000ffe1-0000-1000-8000-00805f9b34fb", // HM-10 style characteristic
];
const BLE_RETRY_DELAYS_MS = [0, 700, 1500];

export default function MobileCollector() {
  const [device, setDevice] = useState<any | null>(null);
  const [characteristic, setCharacteristic] = useState<any | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [pendingSync, setPendingSync] = useState<PendingRead[]>([]);
  const [isWebBluetoothSupported, setIsWebBluetoothSupported] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [bleLogs, setBleLogs] = useState<BleLogItem[]>([]);
  const [bleFramesCount, setBleFramesCount] = useState(0);
  const [bleLastRaw, setBleLastRaw] = useState<string>("(sin datos)");
  const streamBufferRef = React.useRef("");
  const pollTimerRef = React.useRef<number | null>(null);
  const flushTimerRef = React.useRef<number | null>(null);

  useEffect(() => {
    setIsWebBluetoothSupported(typeof navigator !== "undefined" && !!(navigator as any).bluetooth);
    setIsOnline(navigator.onLine);

    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const stored = localStorage.getItem("lympha_offline_queue");
    if (stored) {
      try { setPendingSync(JSON.parse(stored)); } catch { /* ignore */ }
    }

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("lympha_offline_queue", JSON.stringify(pendingSync));
  }, [pendingSync]);

  useEffect(() => {
    return () => {
      if (characteristic) {
        characteristic.removeEventListener("characteristicvaluechanged", handleBTData as EventListener);
      }
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      device?.gatt?.disconnect();
    };
  }, [device, characteristic]);

  // Auto-sync: cuando vuelve la red o cada 30s si hay datos pendientes
  useEffect(() => {
    if (isOnline && pendingSync.length > 0 && !isSyncing) syncAll();
  }, [isOnline]);

  useEffect(() => {
    if (pendingSync.length === 0) return;
    const t = setInterval(() => {
      if (navigator.onLine && !isSyncing) syncAll();
    }, 30000);
    return () => clearInterval(t);
  }, [pendingSync.length, isSyncing]);

  const formatBLEError = (error: unknown) => {
    const msg = (error as Error)?.message?.toLowerCase() ?? "";
    if (msg.includes("not supported") || msg.includes("notfounderror")) {
      return "El ESP32 se conectó, pero no expone el servicio/característica BLE esperado.";
    }
    if (msg.includes("notallowederror") || msg.includes("user cancelled")) {
      return "Selección de dispositivo cancelada.";
    }
    if (msg.includes("connection attempt failed")) {
      return "La boya fue detectada, pero el enlace BLE falló al abrir GATT. Reinicia Bluetooth y energiza la ESP32.";
    }
    return (error as Error)?.message ?? "No se pudo conectar por BLE.";
  };

  const connectGattWithRetry = async (dev: any) => {
    let lastError: unknown = null;
    for (const waitMs of BLE_RETRY_DELAYS_MS) {
      if (waitMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, waitMs));
      }
      try {
        if (dev.gatt?.connected) {
          dev.gatt.disconnect();
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
        const server = await dev.gatt?.connect();
        if (server) return server;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("No se pudo abrir el servidor GATT.");
  };

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const pushBleLog = (raw: string, status: "ok" | "invalid") => {
    const normalized = raw.trim();
    setBleLastRaw(normalized || "(vacío)");
    setBleFramesCount((prev) => prev + 1);
    setBleLogs((prev) => [
      {
        at: new Date().toLocaleTimeString(),
        raw: normalized || "(trama vacía)",
        status,
      },
      ...prev,
    ].slice(0, 20));
  };

  const pickCharacteristicFromService = async (service: any) => {
    const chars = await service.getCharacteristics();
    const preferred = chars.find((c: any) =>
      BLE_FALLBACK_CHARACTERISTIC_UUIDS.includes(c.uuid.toLowerCase())
      && (c.properties.notify || c.properties.indicate || c.properties.read)
    );
    if (preferred) return preferred;

    const firstNotifiable = chars.find((c: any) => c.properties.notify || c.properties.indicate);
    if (firstNotifiable) return firstNotifiable;

    const firstReadable = chars.find((c: any) => c.properties.read);
    if (firstReadable) return firstReadable;

    return null;
  };

  const findBestCharacteristic = async (server: any) => {
    for (const serviceUuid of BLE_FALLBACK_SERVICE_UUIDS) {
      try {
        const service = await server.getPrimaryService(serviceUuid);
        const picked = await pickCharacteristicFromService(service);
        if (picked) return picked;
      } catch {
        // Continuar
      }
    }

    const services = await server.getPrimaryServices();
    for (const service of services) {
      const chars = await service.getCharacteristics();
      const preferred = chars.find((c: any) =>
        BLE_FALLBACK_CHARACTERISTIC_UUIDS.includes(c.uuid.toLowerCase())
        && (c.properties.notify || c.properties.indicate)
      );
      if (preferred) return preferred;

      const firstNotifiable = chars.find((c: any) => c.properties.notify || c.properties.indicate);
      if (firstNotifiable) return firstNotifiable;

      const firstReadable = chars.find((c: any) => c.properties.read);
      if (firstReadable) return firstReadable;
    }
    throw new Error("No se encontró ninguna característica útil (notify/indicate/read) en el dispositivo.");
  };

  const findReadableCharacteristic = async (server: any) => {
    try {
      const services = await server.getPrimaryServices();
      for (const service of services) {
        const chars = await service.getCharacteristics();
        const readable = chars.find((c: any) => c.properties.read);
        if (readable) return readable;
      }
    } catch {
      // Ignorar
    }
    return null;
  };

  const connectBluetooth = async () => {
    if (!isWebBluetoothSupported) {
      alert("Web Bluetooth requiere Chrome en Android o PC. Safari no es compatible.");
      return;
    }
    setIsConnecting(true);
    try {
      const dev = await (navigator as any).bluetooth.requestDevice({
        filters: [{ name: ESP32_DEVICE_NAME }, { namePrefix: "Satoru" }, { namePrefix: "ESP32" }],
        optionalServices: BLE_FALLBACK_SERVICE_UUIDS,
      });

      const server = await connectGattWithRetry(dev);
      if (!server) throw new Error("No se pudo abrir el servidor GATT.");

      let char: any;
      try {
        const service = await server.getPrimaryService(BLE_SERVICE_UUID);
        char = await service.getCharacteristic(BLE_CHARACTERISTIC_UUID);
      } catch {
        char = await findBestCharacteristic(server);
      }

      if (characteristic) {
        characteristic.removeEventListener("characteristicvaluechanged", handleBTData as EventListener);
      }
      stopPolling();

      let connectionMode: "notify" | "polling" = "notify";
      if (char.properties.notify || char.properties.indicate) {
        try {
          await char.startNotifications();
          char.addEventListener("characteristicvaluechanged", handleBTData as EventListener);
          connectionMode = "notify";
        } catch {
          if (char.properties.read) {
            connectionMode = "polling";
            pollTimerRef.current = window.setInterval(async () => {
              try {
                const value = await char.readValue();
                const text = new TextDecoder("utf-8").decode(value).trim();
                if (text) parseAndStore(text);
              } catch {
                // Ignorar
              }
            }, 1500);
          } else {
            const readableFallback = await findReadableCharacteristic(server);
            if (!readableFallback) {
              throw new Error("La característica BLE seleccionada no permitió notificaciones.");
            }
            char = readableFallback;
            connectionMode = "polling";
            pollTimerRef.current = window.setInterval(async () => {
              try {
                const value = await char.readValue();
                const text = new TextDecoder("utf-8").decode(value).trim();
                if (text) parseAndStore(text);
              } catch {
                // Ignorar
              }
            }, 1500);
          }
        }
      } else if (char.properties.read) {
        connectionMode = "polling";
        pollTimerRef.current = window.setInterval(async () => {
          try {
            const value = await char.readValue();
            const text = new TextDecoder("utf-8").decode(value).trim();
            if (text) parseAndStore(text);
          } catch {
            // Ignorar
          }
        }, 1500);
      } else {
        throw new Error(`La característica ${char.uuid} no soporta notify/indicate/read.`);
      }

      setDevice(dev);
      setCharacteristic(char);
      dev.addEventListener("gattserverdisconnected", () => {
        setDevice(null);
        setCharacteristic(null);
        streamBufferRef.current = "";
        stopPolling();
      });
      alert(connectionMode === "notify"
        ? "Conectado al ESP32 por BLE"
        : "Conectado al ESP32 en modo lectura (polling)");
    } catch (e: any) {
      console.warn(e.message);
      alert(`Error BLE: ${formatBLEError(e)}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleBTData = (event: any) => {
    const chunk = new TextDecoder("utf-8").decode(event.target.value).replace(/\0/g, "");
    setBleLastRaw(chunk.trim() || "(vacío)");
    streamBufferRef.current += chunk;

    const frames = streamBufferRef.current.split(/\r?\n/);
    streamBufferRef.current = frames.pop() ?? "";

    for (const frame of frames) {
      const normalized = frame.trim();
      if (normalized) parseAndStore(normalized);
    }

    if (streamBufferRef.current.length > 120) {
      const maybeFrame = streamBufferRef.current.trim();
      streamBufferRef.current = "";
      if (maybeFrame) parseAndStore(maybeFrame);
    }

    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
    }
    flushTimerRef.current = window.setTimeout(() => {
      const pending = streamBufferRef.current.trim();
      if (pending) {
        streamBufferRef.current = "";
        parseAndStore(pending);
      }
    }, 280);
  };

  const parsePayload = (raw: string): SensorPayload | null => {
    try {
      const json = JSON.parse(raw);
      const ph = Number(json.ph ?? json.pH);
      const turbidez = Number(json.turbidez ?? json.turbidity);
      const temperatura = Number(json.temperatura ?? json.temp ?? json.temp_c);
      const conductividad = Number(json.conductividad ?? json.cond ?? json.conductivity);

      if ([ph, turbidez, temperatura].every(Number.isFinite)) {
        return {
          ph,
          turbidez,
          temperatura,
          conductividad: Number.isFinite(conductividad) ? conductividad : undefined,
        };
      }
    } catch {
      // Intentar CSV
    }

    const parts = raw.split(",").map((p) => parseFloat(p.trim()));
    if (parts.length >= 3 && [parts[0], parts[1], parts[2]].every(Number.isFinite)) {
      return {
        ph: parts[0],
        turbidez: parts[1],
        temperatura: parts[2],
        conductividad: Number.isFinite(parts[3]) ? parts[3] : undefined,
      };
    }

    return null;
  };

  const sendToAPI = async (payload: SensorPayload): Promise<boolean> => {
    try {
      const res = await fetch("/api/lecturas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const parseAndStore = async (raw: string) => {
    const payload = parsePayload(raw);
    if (!payload) { pushBleLog(raw, "invalid"); return; }

    pushBleLog(raw, "ok");

    const read: PendingRead = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      data: payload,
      timestamp: new Date().toISOString(),
    };
    setPendingSync((prev) => [read, ...prev]);

    if (navigator.onLine) {
      const ok = await sendToAPI(payload);
      if (ok) {
        setLastSyncTime(new Date().toLocaleTimeString());
        setPendingSync((prev) => prev.filter((p) => p.id !== read.id));
      }
    }
  };

  const simulateData = () => {
    const csv = `${(Math.random() * 2 + 6.5).toFixed(2)},${(Math.random() * 3 + 1).toFixed(2)},${(Math.random() * 5 + 24).toFixed(1)},${(Math.random() * 400 + 250).toFixed(1)}`;
    parseAndStore(csv);
  };

  const syncAll = async () => {
    if (isSyncing || pendingSync.length === 0) return;
    setIsSyncing(true);
    setSyncError(null);
    const queue = [...pendingSync];
    const syncedIds: string[] = [];
    for (const item of queue) {
      try {
        const res = await fetch("/api/lecturas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item.data),
        });
        if (res.ok) {
          syncedIds.push(item.id);
        } else {
          const err = await res.json().catch(() => ({}));
          setSyncError(`Error ${res.status}: ${err.error ?? "Fallo al subir"}`);
          break;
        }
      } catch (e: any) {
        setSyncError(`Sin conexión: ${e.message}`);
        break;
      }
    }
    if (syncedIds.length > 0) {
      setPendingSync(prev => prev.filter(p => !syncedIds.includes(p.id)));
      setLastSyncTime(new Date().toLocaleTimeString());
    }
    setIsSyncing(false);
  };

  const clearCache = () => {
    if (confirm("¿Borrar todos los datos locales no sincronizados? Esta acción no se puede deshacer."))
      setPendingSync([]);
  };

  const lastRead = pendingSync[0]?.data ?? null;

  const recommendations = (d: any) => {
    if (!d) return [];
    const list = [];
    if (d.ph > 8.0)
      list.push({ color: "var(--lympha-red)", bg: "var(--lympha-red-bg)",
        title: `pH alcalino detectado (${d.ph})`,
        desc: "El pH supera el límite saludable (8.0). Causa probable: uso de cremas y bloqueadores solares por turistas. Recomendación: restringir acceso temporalmente y tomar muestras para laboratorio." });
    else if (d.ph >= 6.5)
      list.push({ color: "var(--lympha-green)", bg: "var(--lympha-green-bg)",
        title: `pH en rango óptimo (${d.ph})`,
        desc: "El agua mantiene un índice neutro y purificado. Las condiciones son favorables para la fauna y flora endémica del cenote." });
    if (d.turbidez > 4)
      list.push({ color: "var(--lympha-yellow)", bg: "var(--lympha-yellow-bg)",
        title: `Visibilidad reducida (${d.turbidez} NTU)`,
        desc: "El agua está turbia. Verificar deslaves, obras de construcción o actividad agrícola cercana que pueda estar filtrando sedimentos al manto freático." });
    if (d.temperatura > 26.5)
      list.push({ color: "var(--lympha-yellow)", bg: "var(--lympha-yellow-bg)",
        title: `Temperatura elevada (${d.temperatura} °C)`,
        desc: "Temperatura sobre 26.5 °C favorece la proliferación de algas nocivas que asfixian a la fauna nativa del cenote. Monitorear en las próximas 24 h." });
    return list;
  };

  return (
    <div className="min-h-screen bg-[var(--lympha-bg)]">

      {/* ── HEADER ── */}
      <header className="px-4 md:px-10 py-3.5 flex items-center justify-between sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 bg-white hover:bg-slate-50 text-xs font-bold transition-all active:scale-97"
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            <span>Panel de control</span>
          </Link>
          <div className="h-8 w-auto flex items-center">
            <Image
              src="/logo.png"
              alt="Flotaya"
              width={100}
              height={32}
              style={{ objectFit: "contain", filter: "brightness(0)" }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          </div>
          <div className="hidden sm:flex items-center pl-4 border-l border-slate-200">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-[var(--lympha-accent)]">
                Recolector de campo
              </p>
              <p className="text-[10px] font-semibold text-slate-400 mt-0.5 uppercase tracking-wider">
                {isOnline ? "Panel activo" : "Modo local offline"}
              </p>
            </div>
          </div>
        </div>

        {/* Network status */}
        <div
          className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold border uppercase tracking-wider ${
            isOnline ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-amber-50 border-amber-200 text-amber-800"
          }`}
        >
          {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{isOnline ? "En línea" : "Desconectado"}</span>
        </div>
      </header>

      {/* ── BODY ── */}
      <div className="max-w-7xl mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* ── LEFT PANEL ── */}
        <div className="lg:col-span-4 space-y-6 order-2 lg:order-1">

          {/* Bluetooth connect */}
          <div className="rounded-md p-6 border border-slate-200 bg-white">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
              Vínculo de campo
            </p>
            <h2 className="text-lg font-bold text-slate-800 mb-1 flex items-center gap-2">
              <Bluetooth className="w-5 h-5 text-[var(--lympha-accent)]" />
              Conectar boya
            </h2>
            <p className="text-xs text-slate-500 mb-5">
              Enlace BLE · Recibe tramas de sensores.
            </p>

            <div className="space-y-3">
              <button
                onClick={connectBluetooth}
                disabled={isConnecting || !isWebBluetoothSupported}
                className="w-full py-2.5 rounded-md font-bold text-xs transition-all active:scale-97 disabled:opacity-50 flex items-center justify-center gap-2 bg-slate-900 text-white hover:bg-slate-800"
              >
                {isConnecting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                {isConnecting ? "Buscando..." : "Conectar boya"}
              </button>

              <button
                onClick={simulateData}
                className="w-full py-2 rounded-md font-bold text-xs transition-all active:scale-97 border border-slate-300 text-slate-700 bg-white hover:bg-slate-50 flex items-center justify-center gap-2"
              >
                Simular lectura local
              </button>
            </div>

            {device && (
              <div className="mt-4 p-3 rounded-md flex items-center gap-3 border border-emerald-200 bg-emerald-50/50">
                <Bluetooth className="w-4 h-4 text-emerald-700 flex-shrink-0" />
                <div>
                  <p className="text-xs font-bold text-slate-800">{device.name || "ESP32 Boya"}</p>
                  <p className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wider">Conectado · BLE</p>
                </div>
              </div>
            )}
          </div>

          {/* BLE logger */}
          <div className="rounded-md p-5 border border-slate-200 bg-white">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-xs uppercase tracking-wider text-slate-500">
                Logs Telemetría
              </h3>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-mono">
                {bleFramesCount} tramas
              </span>
            </div>

            <p className="text-xs mb-3 text-slate-600">
              Último dato crudo: <span className="font-mono bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100 font-semibold">{bleLastRaw}</span>
            </p>

            <div className="max-h-44 overflow-auto rounded border border-slate-150 p-2 space-y-1.5 bg-slate-50">
              {bleLogs.length === 0 ? (
                <p className="text-xs text-center text-slate-400 py-6">
                  Sin telemetría BLE activa
                </p>
              ) : (
                bleLogs.map((entry, i) => (
                  <div key={`${entry.at}-${i}`} className="text-[10px] rounded p-1.5 border font-mono leading-relaxed"
                    style={{
                      borderColor: entry.status === "ok" ? "#16653420" : "#991b1b20",
                      backgroundColor: entry.status === "ok" ? "var(--lympha-green-bg)" : "var(--lympha-red-bg)",
                      color: entry.status === "ok" ? "var(--lympha-green)" : "var(--lympha-red)",
                    }}
                  >
                    <span className="font-bold">[{entry.at}]</span>
                    <span> {entry.raw}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Cache / sync panel */}
          <div className="rounded-md p-5 border border-slate-200 bg-white">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-xs uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                <Database className="w-4 h-4 text-slate-400" />
                Caché Local
              </h3>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono">
                {pendingSync.length} lecturas
              </span>
            </div>

            {lastSyncTime && (
              <p className="text-xs font-semibold mb-3 px-3 py-1.5 rounded bg-emerald-50 text-emerald-700">
                Sincronizado a las: {lastSyncTime}
              </p>
            )}

            {pendingSync.length > 0 ? (
              <div className="space-y-2">
                {syncError && (
                  <p className="text-xs font-semibold px-3 py-1.5 rounded bg-red-50 text-red-700">
                    {syncError}
                  </p>
                )}
                {isOnline && (
                  <button
                    onClick={syncAll}
                    disabled={isSyncing}
                    className="w-full flex items-center justify-center gap-2 text-xs font-bold py-2.5 rounded-md text-white transition active:scale-97 bg-slate-900 hover:bg-slate-800"
                  >
                    {isSyncing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
                    {isSyncing ? "Subiendo..." : "Subir a la nube"}
                  </button>
                )}
                <button
                  onClick={clearCache}
                  className="w-full text-xs font-bold py-2 rounded-md transition text-red-700 bg-red-50 hover:bg-red-100"
                >
                  Purgar caché local
                </button>
              </div>
            ) : (
              <p className="text-xs text-center py-4 border border-dashed border-slate-200 text-slate-400 rounded">
                Base de datos local limpia
              </p>
            )}
          </div>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div className="lg:col-span-8 order-1 lg:order-2">

          {/* OFFLINE: last local reading */}
          {!isOnline && (
            <div className="rounded-md p-6 md:p-8 border border-slate-200 bg-white h-full">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                Sin conexión
              </p>
              <h2 className="text-xl font-bold text-slate-800 mb-1">
                Última extracción de campo
              </h2>
              <p className="text-xs text-slate-500 mb-8">
                Visualizando datos guardados localmente. Requiere red para análisis NOM predictivo.
              </p>

              {lastRead ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {[
                    { k: "pH",           v: lastRead.ph },
                    { k: "Turbidez NTU", v: lastRead.turbidez },
                    { k: "Temp. °C",     v: lastRead.temperatura },
                  ].map(({ k, v }) => (
                    <div
                      key={k}
                      className="rounded-md p-6 text-center border border-slate-200 bg-slate-50"
                    >
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">{k}</p>
                      <p className="text-4xl font-extrabold text-slate-800 font-mono">
                        {v.toFixed(1)}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-48 border border-dashed border-slate-200 rounded">
                  <Activity className="w-8 h-8 mb-3 text-slate-300" />
                  <p className="text-xs text-slate-400">
                    Sin lecturas locales hoy
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ONLINE: smart recommendations */}
          {isOnline && (
            <div className="rounded-md p-6 md:p-8 border border-slate-200 bg-white h-full">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                Análisis en tiempo real
              </p>
              <h2 className="text-xl font-bold text-slate-800 mb-1">
                Diagnóstico del cenote
              </h2>
              <p className="text-xs text-slate-500 mb-6">
                Evaluación automatizada sobre la última lectura de los sensores.
              </p>

              {!lastRead ? (
                <div className="p-5 rounded-md border border-blue-200 bg-blue-50/50 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-blue-700 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold text-xs text-slate-800">
                      Esperando telemetría
                    </p>
                    <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                      Conecta la boya por Bluetooth o simula lecturas locales para activar el panel.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {recommendations(lastRead).map((rec, i) => (
                    <div
                      key={i}
                      className="p-4 md:p-5 rounded-md border"
                      style={{ backgroundColor: rec.bg, borderColor: `${rec.color}15` }}
                    >
                      <div className="flex items-start gap-3">
                        <ChevronRight className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: rec.color }} />
                        <div>
                          <p className="font-bold text-xs" style={{ color: rec.color }}>
                            {rec.title}
                          </p>
                          <p className="text-xs leading-relaxed text-slate-600 mt-1">
                            {rec.desc}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                  {recommendations(lastRead).length === 0 && (
                    <div className="p-5 rounded-md border border-emerald-250 bg-emerald-50/50 flex items-start gap-3">
                      <Droplets className="w-5 h-5 text-emerald-700 flex-shrink-0 mt-0.5" />
                      <p className="text-xs font-semibold text-emerald-800">
                        Todos los parámetros evaluados se encuentran dentro de las normativas vigentes.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

      </div>

      {/* ── FOOTER ── */}
      <footer className="px-4 py-6 border-t border-slate-200 bg-white mt-12 text-center">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Flotaya · Soberanía Hídrica · Modo {isOnline ? "En línea" : "Offline"}
        </p>
      </footer>
    </div>
  );
}
