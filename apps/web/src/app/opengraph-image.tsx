// apps/web/src/app/opengraph-image.tsx
import { ImageResponse } from "next/og";
import { defaultTitle } from "@/lib/seo";

export const alt = defaultTitle;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Monochrome card matching the site's near-black-on-warm-white brand.
export default function OpengraphImage(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 88,
          background: "#faf9f7",
          color: "#1c1a17",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <div
            style={{
              width: 76,
              height: 76,
              borderRadius: 22,
              background: "#1c1a17",
              color: "#faf9f7",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 44,
              fontWeight: 700,
            }}
          >
            U
          </div>
          <div style={{ fontSize: 54, fontWeight: 700, letterSpacing: -1 }}>UltraVora</div>
        </div>
        <div style={{ marginTop: 56, fontSize: 72, fontWeight: 700, lineHeight: 1.08, letterSpacing: -2, maxWidth: 980 }}>
          Promo videos for your product
        </div>
        <div style={{ marginTop: 30, fontSize: 32, color: "rgba(28,26,23,0.62)", maxWidth: 920 }}>
          One prompt in. Script, voiceover and final cut out.
        </div>
      </div>
    ),
    { ...size },
  );
}
