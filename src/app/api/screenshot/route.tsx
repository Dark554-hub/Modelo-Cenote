import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const form = searchParams.get("form") ?? "wide";
  const wide = form === "wide";
  const w = wide ? 1280 : 390;
  const h = wide ? 720 : 844;
  const cols = wide ? 4 : 2;

  const metrics = [
    { label: "PH", value: "7.4" },
    { label: "TURBIDEZ", value: "2.8" },
    { label: "TEMPERATURA", value: "24.8" },
    { label: "CONDUCTIVIDAD", value: "412" },
  ].slice(0, cols);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#EAE4D8",
          fontFamily: "serif",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: "#FFFFFF",
            padding: wide ? "0 40px" : "0 16px",
            height: wide ? 64 : 56,
            borderBottom: "1px solid #C9A22718",
          }}
        >
          <span style={{ fontSize: wide ? 28 : 20, fontWeight: 900, color: "#14100E", fontStyle: "italic" }}>
            Flotaya
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, backgroundColor: "#14100E", borderRadius: 99, padding: wide ? "8px 20px" : "6px 14px" }}>
            <span style={{ fontSize: wide ? 13 : 11, fontWeight: 700, color: "#FFFFFF" }}>Recolector</span>
          </div>
        </div>

        {/* Content */}
        <div style={{ display: "flex", flexDirection: "column", padding: wide ? 32 : 12, gap: 16, flex: 1 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#C9A227", letterSpacing: 3, textTransform: "uppercase" }}>
            MONITOREO EN TIEMPO REAL
          </span>

          {/* Metric cards */}
          <div style={{ display: "flex", gap: 12 }}>
            {metrics.map((m) => (
              <div
                key={m.label}
                style={{
                  flex: 1,
                  backgroundColor: "#FFFFFF",
                  borderRadius: 20,
                  padding: wide ? "20px 24px" : "14px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  border: "1px solid #C9A22722",
                }}
              >
                <span style={{ fontSize: 9, fontWeight: 700, color: "#C9A227", letterSpacing: 2 }}>{m.label}</span>
                <span style={{ fontSize: wide ? 44 : 32, fontWeight: 900, color: "#14100E", fontStyle: "italic", lineHeight: 1 }}>{m.value}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 99, backgroundColor: "#4A7C59" }} />
                  <span style={{ fontSize: 9, fontWeight: 700, color: "#4A7C59" }}>Óptimo</span>
                </div>
              </div>
            ))}
          </div>

          {/* Diagnostic card */}
          <div style={{
            backgroundColor: "#FFFFFF",
            borderRadius: 20,
            padding: wide ? "24px 28px" : "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            border: "1px solid #4A7C5928",
            flex: 1,
          }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: "#C9A227", letterSpacing: 2 }}>INTELIGENCIA ARTIFICIAL</span>
            <span style={{ fontSize: wide ? 26 : 20, fontWeight: 900, color: "#14100E", fontStyle: "italic" }}>Diagnóstico ML</span>
            <div style={{ display: "flex", gap: 10 }}>
              {["pH", "Turbidez", "Temperatura"].map((p) => (
                <div key={p} style={{ backgroundColor: "#4A7C5910", borderRadius: 12, padding: "8px 14px", border: "1px solid #4A7C5922" }}>
                  <span style={{ fontSize: 10, color: "#4A7C59", fontWeight: 700 }}>{p} — óptimo</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    ),
    { width: w, height: h }
  );
}
