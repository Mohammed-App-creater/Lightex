import { ImageResponse } from "next/og";
import { appIconSvg, svgDataUri } from "@/components/brand/icon-svg";

/* Apple touch icon (board 35 "App icon" 180). iOS rounds the corners itself, so the tile is square. */

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      // eslint-disable-next-line @next/next/no-img-element -- next/og renders <img>, not next/image
      <img src={svgDataUri(appIconSvg({ size: 180, shape: "square" }))} width={180} height={180} alt="" />
    ),
    size,
  );
}
