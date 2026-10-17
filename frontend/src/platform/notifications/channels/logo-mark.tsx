/** The "cut X" logo at 12 px (design preview `.ch-pvi`), token colours only. */
export function LogoMark() {
  return (
    <svg aria-hidden width={12} height={10} viewBox="0 0 46 39" overflow="visible">
      <path d="M-4 -4L50 43" stroke="var(--text)" strokeWidth={10} fill="none" />
      <path d="M50 -5L26 18H39L-4 44" stroke="var(--surface)" strokeWidth={17} fill="none" strokeLinejoin="miter" strokeMiterlimit={10} />
      <path d="M50 -5L26 18H39L-4 44" stroke="var(--logo)" strokeWidth={10} fill="none" strokeLinejoin="miter" strokeMiterlimit={10} />
    </svg>
  );
}
