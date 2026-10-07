import type { Transition } from "motion/react";

/** Motion tokens from board 02 ("Type, space, motion"). */
export const dur = {
  fast: 0.12,
  base: 0.18,
  slow: 0.25,
  data: 0.7,
} as const;

export const ease = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
  spring: [0.34, 1.56, 0.64, 1],
} as const satisfies Record<string, [number, number, number, number]>;

export const t = {
  fast: { duration: dur.fast, ease: ease.out },
  base: { duration: dur.base, ease: ease.out },
  slow: { duration: dur.slow, ease: ease.out },
  data: { duration: dur.data, ease: ease.out },
  /** Drag lift: "spring 520 / 38". */
  lift: { type: "spring", stiffness: 520, damping: 38 },
  /** Layout reflow of siblings (columns, lists). */
  reflow: { type: "spring", stiffness: 520, damping: 42, mass: 0.8 },
} satisfies Record<string, Transition>;

/** Toast / menu / tooltip: fade + 6px rise, 180ms ease-out. */
export const riseIn = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6 },
  transition: t.base,
};
