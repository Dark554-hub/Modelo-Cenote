/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useState, useEffect } from "react";
import {
  Bluetooth, LayoutDashboard, RefreshCw, Database,
  Search, Wifi, WifiOff, CloudUpload, Activity,
  AlertCircle, Droplets
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
  const [bleLastRaw, setBleLastRaw] = useState<string>("—");
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
      return "El ESP32 se conecto, pero no expone el servicio/caracteristica BLE esperados. Verifica UUIDs del firmware o usa un perfil BLE UART (NUS/FFE0).";
    }
    if (msg.includes("notallowederror") || msg.includes("user cancelled")) {
      return "Seleccion de dispositivo cancelada.";
    }
    if (msg.includes("connection attempt failed")) {
      return "La boya fue detectada, pero el enlace BLE fallo al abrir GATT. Reinicia Bluetooth del PC y energiza de nuevo la ESP32; la app ahora reintenta automaticamente varias veces.";
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
    setBleLastRaw(normalized || "—");
    setBleFramesCount((prev) => prev + 1);
    setBleLogs((prev) => [
      {
        at: new Date().toLocaleTimeString(),
        raw: normalized || "(trama vacia)",
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
    // 1) Probar explícitamente UUIDs de servicio conocidos (más confiable con permisos Web Bluetooth)
    for (const serviceUuid of BLE_FALLBACK_SERVICE_UUIDS) {
      try {
        const service = await server.getPrimaryService(serviceUuid);
        const picked = await pickCharacteristicFromService(service);
        if (picked) return picked;
      } catch {
        // Continuar con el siguiente UUID conocido.
      }
    }

    // 2) Intentar barrido de servicios disponibles
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
    throw new Error("No se encontro ninguna caracteristica util (notify/indicate/read) en el dispositivo.");
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
      // Ignorar y devolver null
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
                // Ignorar lecturas fallidas intermitentes durante polling BLE.
              }
            }, 1500);
          } else {
            const readableFallback = await findReadableCharacteristic(server);
            if (!readableFallback) {
              throw new Error("La caracteristica BLE seleccionada no permitio notificaciones y no existe una alternativa de lectura.");
            }
            char = readableFallback;
            connectionMode = "polling";
            pollTimerRef.current = window.setInterval(async () => {
              try {
                const value = await char.readValue();
                const text = new TextDecoder("utf-8").decode(value).trim();
                if (text) parseAndStore(text);
              } catch {
                // Ignorar lecturas fallidas intermitentes durante polling BLE.
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
            // Ignorar lecturas fallidas intermitentes durante polling BLE.
          }
        }, 1500);
      } else {
        throw new Error(`La caracteristica ${char.uuid} no soporta notify/indicate/read.`);
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
    setBleLastRaw(chunk.trim() || "—");
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

    // Algunos firmwares envian sin salto de linea; hacemos flush por inactividad.
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
      // El frame no era JSON, intentamos CSV.
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
          setSyncError(`Error ${res.status}: ${err.error ?? "fallo al subir"}`);
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
      list.push({ color: "#A34A3E", bg: "#A34A3E12",
        title: `pH alcalino detectado (${d.ph})`,
        desc: "El pH supera el límite saludable (8.0). Causa probable: uso de cremas y bloqueadores solares por turistas. Recomendación: restringir acceso temporalmente y tomar muestras para laboratorio." });
    else if (d.ph >= 6.5)
      list.push({ color: "#4A7C59", bg: "#4A7C5912",
        title: `pH en rango óptimo (${d.ph})`,
        desc: "El agua mantiene un índice neutro y purificado. Las condiciones son favorables para la fauna y flora endémica del cenote." });
    if (d.turbidez > 4)
      list.push({ color: "#C9A227", bg: "#C9A22712",
        title: `Visibilidad reducida (${d.turbidez} NTU)`,
        desc: "El agua está turbia. Verificar deslaves, obras de construcción o actividad agrícola cercana que pueda estar filtrando sedimentos al manto freático." });
    if (d.temperatura > 26.5)
      list.push({ color: "#d97706", bg: "#d9770612",
        title: `Temperatura elevada (${d.temperatura} °C)`,
        desc: "Temperatura sobre 26.5 °C favorece la proliferación de algas nocivas que asfixian a la fauna nativa del cenote. Monitorear en las próximas 24 h." });
    return list;
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--lympha-sand)" }}>

      {/* ── HEADER ── */}
      <header
        style={{ backgroundColor: "#FFFFFF", borderBottom: "1px solid #C9A22718" }}
        className="px-4 md:px-10 py-3 md:py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm"
      >
        {/* Logo + back */}
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="p-2 rounded-full transition-opacity hover:opacity-70 flex-shrink-0 border"
            style={{ backgroundColor: "#F5F3EF", borderColor: "#C9A22722" }}
          >
            <LayoutDashboard className="w-4 h-4" style={{ color: "var(--lympha-walnut)" }} />
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
          <div className="hidden sm:flex items-center pl-4 border-l" style={{ borderColor: "#C9A22728" }}>
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--lympha-amber)" }}>
                RECOLECTOR DE CAMPO
              </p>
              <p className="text-xs font-medium mt-0.5" style={{ color: "#0F172A55" }}>
                {isOnline ? "Panel de recomendaciones activo" : "Modo sin conexión — datos locales"}
              </p>
            </div>
          </div>
        </div>

        {/* Network badge */}
        <div
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border"
          style={{
            backgroundColor: isOnline ? "#4A7C5910" : "#C9A22710",
            borderColor:     isOnline ? "#4A7C5935" : "#C9A22735",
            color:           isOnline ? "#4A7C59"   : "#C9A227",
          }}
        >
          {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{isOnline ? "ONLINE" : "SIN RED"}</span>
        </div>
      </header>

      {/* ── BODY ── */}
      <div className="p-3 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-6">

        {/* ── LEFT PANEL ── */}
        <div className="lg:col-span-4 space-y-4 order-2 lg:order-1">

          {/* Bluetooth connect */}
          <div
            className="rounded-3xl p-6 border"
            style={{ backgroundColor: "var(--lympha-cream)", borderColor: "#C9A22722" }}
          >
            <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--lympha-amber)" }}>
              VÍNCULO DE CAMPO
            </p>
            <h2 className="font-bold mb-1 flex items-center gap-2 serif-italic text-xl" style={{ color: "var(--lympha-walnut)" }}>
              <Bluetooth style={{ color: "var(--lympha-amber)" }} className="w-5 h-5" />
              Conectar boya
            </h2>
            <p className="text-xs mb-5 font-medium" style={{ color: "#0F172A55" }}>
              Enlace BLE · recibe tramas JSON o CSV
            </p>

            <div className="space-y-3">
              <button
                onClick={connectBluetooth}
                disabled={isConnecting || !isWebBluetoothSupported}
                className="w-full py-3.5 rounded-full font-semibold text-sm transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
                style={{ backgroundColor: "var(--lympha-walnut)", color: "#FFFFFF" }}
              >
                {isConnecting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                {isConnecting ? "Buscando BLE..." : "Conectar boya"}
              </button>

              <button
                onClick={simulateData}
                className="w-full py-3 rounded-full font-medium text-sm transition-all active:scale-95 border flex items-center justify-center gap-2"
                style={{ backgroundColor: "transparent", borderColor: "#C9A22735", color: "var(--lympha-amber)" }}
              >
                Simular dato (prueba)
              </button>
            </div>

            {device && (
              <div
                className="mt-4 p-3 rounded-2xl flex items-center gap-3 border"
                style={{ backgroundColor: "#4A7C5910", borderColor: "#4A7C5930" }}
              >
                <Bluetooth className="w-4 h-4 flex-shrink-0" style={{ color: "#4A7C59" }} />
                <div>
                  <p className="text-sm font-semibold" style={{ color: "var(--lympha-walnut)" }}>{device.name || "ESP32 Boya"}</p>
                  <p className="text-xs font-medium" style={{ color: "#4A7C59" }}>Conectado · BLE</p>
                </div>
              </div>
            )}
          </div>

          {/* BLE logger */}
          <div
            className="rounded-3xl p-5 border"
            style={{ backgroundColor: "var(--lympha-cream)", borderColor: "#0EA5E928" }}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm" style={{ color: "var(--lympha-walnut)" }}>
                Logger BLE
              </h3>
              <span className="text-xs font-semibold px-2 py-1 rounded-full"
                style={{ backgroundColor: "#0EA5E910", color: "#0EA5E9" }}>
                {bleFramesCount} tramas
              </span>
            </div>

            <p className="text-xs mb-2" style={{ color: "#0F172A70" }}>
              Última trama cruda: <span className="font-semibold">{bleLastRaw}</span>
            </p>

            <div
              className="max-h-44 overflow-auto rounded-xl border p-2 space-y-2"
              style={{ borderColor: "#0EA5E925", backgroundColor: "#0EA5E907" }}
            >
              {bleLogs.length === 0 ? (
                <p className="text-xs text-center py-4" style={{ color: "#0F172A55" }}>
                  Sin tramas BLE recibidas todavia.
                </p>
              ) : (
                bleLogs.map((entry, i) => (
                  <div key={`${entry.at}-${i}`} className="text-xs rounded-lg px-2 py-1.5 border"
                    style={{
                      borderColor: entry.status === "ok" ? "#4A7C5930" : "#A34A3E35",
                      backgroundColor: entry.status === "ok" ? "#4A7C5910" : "#A34A3E10",
                      color: "#0F172A",
                    }}
                  >
                    <span className="font-semibold">[{entry.at}] {entry.status === "ok" ? "OK" : "INVALID"}</span>
                    <span> {entry.raw}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Cache / sync panel */}
          <div
            className="rounded-3xl p-5 border"
            style={{ backgroundColor: "var(--lympha-cream)", borderColor: "#C9A22722" }}
          >
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold flex items-center gap-2 text-sm"
                style={{ color: "var(--lympha-walnut)" }}>
                <Database className="w-4 h-4" style={{ color: "var(--lympha-amber)" }} />
                Almacenamiento local
              </h3>
              <span
                className="text-xs font-bold px-2.5 py-1 rounded-full"
                style={{ backgroundColor: "#C9A22715", color: "var(--lympha-amber)" }}
              >
                {pendingSync.length} registros
              </span>
            </div>

            {lastSyncTime && (
              <p className="text-xs font-medium mb-3 px-3 py-2 rounded-lg"
                style={{ backgroundColor: "#4A7C5912", color: "#4A7C59" }}>
                Última sincronización: {lastSyncTime}
              </p>
            )}

            {pendingSync.length > 0 ? (
              <div className="space-y-2">
                {syncError && (
                  <p className="text-xs font-medium px-3 py-2 rounded-lg" style={{ backgroundColor: "#A34A3E12", color: "#A34A3E" }}>
                    {syncError}
                  </p>
                )}
                {isOnline && (
                  <button
                    onClick={syncAll}
                    disabled={isSyncing}
                    className="w-full flex items-center justify-center gap-2 text-sm font-semibold py-3 rounded-full text-white transition active:scale-95"
                    style={{ backgroundColor: "var(--lympha-walnut)" }}
                  >
                    {isSyncing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
                    {isSyncing ? "Sincronizando..." : "Subir a la nube"}
                  </button>
                )}
                <button
                  onClick={clearCache}
                  className="w-full text-xs font-semibold py-2 rounded-xl transition"
                  style={{ color: "var(--lympha-terracota)", backgroundColor: "#A34A3E0D" }}
                >
                  Purgar caché local
                </button>
              </div>
            ) : (
              <p
                className="text-xs font-medium text-center py-4 rounded-xl border border-dashed"
                style={{ borderColor: "#C9A22730", color: "#0F172A50" }}
              >
                Todo está sincronizado
              </p>
            )}
          </div>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div className="lg:col-span-8 order-1 lg:order-2">

          {/* OFFLINE: last local reading */}
          {!isOnline && (
            <div
              className="rounded-3xl p-6 md:p-8 border h-full"
              style={{ backgroundColor: "var(--lympha-cream)", borderColor: "#C9A22722" }}
            >
              <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--lympha-amber)" }}>
                SIN CONEXIÓN
              </p>
              <h2 className="text-2xl font-bold serif-italic mb-1" style={{ color: "var(--lympha-walnut)" }}>
                Última extracción de campo
              </h2>
              <p className="text-sm font-medium mb-8" style={{ color: "#0F172A60" }}>
                Datos almacenados localmente. Conéctate a internet para el análisis inteligente.
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
                      className="rounded-3xl p-6 text-center border"
                      style={{ backgroundColor: "var(--lympha-walnut)", borderColor: "#C9A22720" }}
                    >
                      <p className="text-xs font-semibold uppercase tracking-wider mb-2"
                        style={{ color: "#C9A22780" }}>{k}</p>
                      <p className="text-5xl font-bold serif-italic" style={{ color: "var(--lympha-amber)" }}>
                        {v.toFixed(1)}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className="flex flex-col items-center justify-center h-48 rounded-2xl border-2 border-dashed"
                  style={{ borderColor: "#C9A22730" }}
                >
                  <Activity className="w-10 h-10 mb-3" style={{ color: "#C9A22740" }} />
                  <p className="text-sm font-medium" style={{ color: "#0F172A50" }}>
                    Sin lecturas descargadas hoy
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ONLINE: smart recommendations */}
          {isOnline && (
            <div
              className="rounded-3xl p-6 md:p-8 border h-full"
              style={{ backgroundColor: "var(--lympha-cream)", borderColor: "#C9A22722" }}
            >
              <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--lympha-amber)" }}>
                ANÁLISIS EN TIEMPO REAL
              </p>
              <h2 className="text-2xl font-bold serif-italic mb-1" style={{ color: "var(--lympha-walnut)" }}>
                Diagnóstico del cenote
              </h2>
              <p className="text-sm font-medium mb-6" style={{ color: "#0F172A60" }}>
                Análisis automático basado en la última lectura registrada
              </p>

              {!lastRead ? (
                <div
                  className="p-5 rounded-2xl border flex items-start gap-3"
                  style={{ backgroundColor: "#0EA5E910", borderColor: "#0EA5E925" }}
                >
                  <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: "var(--lympha-iot)" }} />
                  <div>
                    <p className="font-semibold text-sm" style={{ color: "var(--lympha-slate)" }}>
                      En espera de datos
                    </p>
                    <p className="text-sm mt-1" style={{ color: "#0F172A70" }}>
                      Conecta la boya o usa "Simular dato" para activar el diagnóstico.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {recommendations(lastRead).map((rec, i) => (
                    <div
                      key={i}
                      className="p-4 md:p-5 rounded-3xl border"
                      style={{ backgroundColor: rec.bg, borderColor: `${rec.color}28` }}
                    >
                      <div>
                        <p className="font-semibold text-sm mb-1" style={{ color: rec.color }}>
                          {rec.title}
                        </p>
                        <p className="text-sm leading-relaxed" style={{ color: "#0F172A80" }}>
                          {rec.desc}
                        </p>
                      </div>
                    </div>
                  ))}
                  {recommendations(lastRead).length === 0 && (
                    <div
                      className="p-5 rounded-2xl border flex items-start gap-3"
                      style={{ backgroundColor: "#4A7C5912", borderColor: "#4A7C5928" }}
                    >
                      <Droplets className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: "#4A7C59" }} />
                      <p className="text-sm font-medium" style={{ color: "#4A7C59" }}>
                        Todos los parámetros son normales. El cenote está en buen estado.
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
      <footer className="px-4 py-4 mt-2 text-center border-t" style={{ borderColor: "#C9A22718", backgroundColor: "#FFFFFF" }}>
        <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#0F172A35" }}>
          Flotaya · Soberanía Hídrica · Modo {isOnline ? "En línea" : "Sin conexión"}
        </p>
      </footer>
    </div>
  );
}
