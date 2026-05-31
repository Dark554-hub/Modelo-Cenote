import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const size = parseInt(searchParams.get("size") ?? "192");

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#14100E",
        }}
      >
        <span
          style={{
            fontSize: size * 0.58,
            fontStyle: "italic",
            fontWeight: 900,
            color: "#C9A227",
            lineHeight: 1,
          }}
        >
          F
        </span>
      </div>
    ),
    { width: size, height: size }
  );
}
