import { ImageResponse } from "next/og";
import { maskableIconSvg, svgDataUri } from "@/components/brand/icon-svg";

/* Maskable PWA icon (board 35 "Maskable · 80%"): full-bleed tile, mark inside the safe zone. */

export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(
    (
      // eslint-disable-next-line @next/next/no-img-element -- next/og renders <img>, not next/image
      <img src={svgDataUri(maskableIconSvg(512))} width={512} height={512} alt="" />
    ),
    { width: 512, height: 512 },
  );
}
