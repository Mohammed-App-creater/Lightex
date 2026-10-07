/*
 * "Cut x" mark and app-icon tiles as standalone SVG strings (board 35 "App icon"), for places that
 * can't use the React <LogoMark>: next/og image routes (apple-icon, maskable/PWA icons, Open
 * Graph). Colours are fixed brand values because these images live outside the theme.
 */

export const BRAND = {
  tile: "#0F1830",
  tileStroke: "#2B3A5E",
  bar: "#EAF0FF",
  bolt: "#3B7BFF",
  spark: "#5BE0FF",
} as const;

const CUTS = {
  text: { bolt: "M50 -5L27 17H38L-4 44", boltW: 8.5, barW: 9.5, maskW: 13.5 },
  icon: { bolt: "M50 -5L26 18H39L-4 44", boltW: 10, barW: 11, maskW: 16 },
} as const;

/** Inner <svg> for the mark, positioned at x/y with width/height inside a parent viewBox. */
function markEl(id: string, cut: keyof typeof CUTS, x: number, y: number, w: number, h: number, bar: string, bolt: string) {
  const c = CUTS[cut];
  return (
    `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 46 39">` +
    `<defs><clipPath id="c${id}"><rect width="46" height="39"/></clipPath>` +
    `<mask id="m${id}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="70" height="60"><rect x="-10" y="-10" width="70" height="60" fill="#fff"/>` +
    `<path d="${c.bolt}" fill="none" stroke="#000" stroke-width="${c.maskW}" stroke-linejoin="miter" stroke-miterlimit="10"/></mask></defs>` +
    `<g clip-path="url(#c${id})"><path d="M-4 -4L50 43" stroke="${bar}" stroke-width="${c.barW}" fill="none" mask="url(#m${id})"/>` +
    `<path d="${c.bolt}" stroke="${bolt}" stroke-width="${c.boltW}" fill="none" stroke-linejoin="miter" stroke-miterlimit="10"/></g></svg>`
  );
}

/** The bare mark (46×39 viewBox). */
export function markSvg({ cut = "text", bar = BRAND.bar, bolt = BRAND.bolt }: { cut?: keyof typeof CUTS; bar?: string; bolt?: string } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 46 39" width="46" height="39">${markEl("k", cut, 0, 0, 46, 39, bar, bolt)}</svg>`;
}

/**
 * App icon tile on a 96 grid (board: rx 21.6; ≤32px uses the larger cut at 12/18/72×61.2,
 * otherwise 18/22/60×51). `shape: "square"` drops the radius for platforms that mask themselves.
 */
export function appIconSvg({ size, shape = "rounded" }: { size: number; shape?: "rounded" | "square" }) {
  const small = size <= 32;
  const [x, y, w, h] = small ? [12, 18, 72, 61.2] : [18, 22, 60, 51];
  const rx = shape === "square" ? 0 : 21.6;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="${size}" height="${size}">` +
    `<rect width="96" height="96" rx="${rx}" fill="${BRAND.tile}"/>` +
    (shape === "rounded" ? `<rect x=".5" y=".5" width="95" height="95" rx="${rx}" fill="none" stroke="${BRAND.tileStroke}"/>` : "") +
    markEl("a", "icon", x, y, w, h, BRAND.bar, BRAND.bolt) +
    `</svg>`
  );
}

/** Maskable icon (100 grid): full-bleed tile, mark inside the 80% safe zone (25/28.8, 50×42.4). */
export function maskableIconSvg(size: number) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">` +
    `<rect width="100" height="100" fill="${BRAND.tile}"/>` +
    markEl("x", "icon", 25, 28.8, 50, 42.4, BRAND.bar, BRAND.bolt) +
    `</svg>`
  );
}

export const svgDataUri = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`;
