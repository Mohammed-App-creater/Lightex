import { ImageResponse } from "next/og";
import { appIconSvg, svgDataUri } from "@/components/brand/icon-svg";

/* 512px rounded app icon for the web manifest ("any" purpose), board 35. */

export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(
    (
      // eslint-disable-next-line @next/next/no-img-element -- next/og renders <img>, not next/image
      <img src={svgDataUri(appIconSvg({ size: 512 }))} width={512} height={512} alt="" />
    ),
    { width: 512, height: 512 },
  );
}
