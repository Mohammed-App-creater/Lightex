"use client";

/*
 * Auth flow backdrop + motion (board 21 §2.2, §2.8).
 * Plain global classes in a hoisted <style> (React 19 dedupes by href): the project's turbopack
 * rule compiles every *.css as plain CSS, so CSS modules aren't available.
 */

export const authStylesClasses = {
  b1: "au-b1",
  b2: "au-b2",
  b3: "au-b3",
  backdrop: "au-backdrop",
  bolt: "au-bolt",
  fade: "au-fade",
  glow: "au-glow",
  grid: "au-grid",
  in: "au-in",
  inSlow: "au-inSlow",
  pop: "au-pop",
  spark: "au-spark",
  ws: "au-ws",
} as const;

const CSS = `/* Auth flow backdrop + motion (board 21 §2.2, §2.8). Colours come from theme tokens only. */

.au-backdrop {
  --au-grid: color-mix(in srgb, var(--accent-t) 7%, transparent);
  --au-glow: color-mix(in srgb, var(--accent) 16%, transparent);
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
}
[data-theme="light"] .au-backdrop {
  --au-grid: color-mix(in srgb, var(--text) 5.5%, transparent);
  --au-glow: color-mix(in srgb, var(--accent) 8%, transparent);
}

.au-glow {
  position: absolute;
  left: 50%;
  top: -30%;
  width: 120%;
  height: 80%;
  transform: translateX(-50%);
  background: radial-gradient(closest-side, var(--au-glow), transparent);
}

.au-grid {
  position: absolute;
  inset: -40px;
  background-image:
    linear-gradient(var(--au-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--au-grid) 1px, transparent 1px);
  background-size: 40px 40px;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 45%, #000 20%, transparent 80%);
  -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 45%, #000 20%, transparent 80%);
  animation: audrift 28s linear infinite;
}

.au-bolt {
  position: absolute;
  fill: none;
  stroke-linejoin: miter;
  animation: aufloat 16s ease-in-out infinite alternate;
}
.au-b1 {
  width: 180px;
  height: 152px;
  right: -30px;
  top: 60px;
  opacity: 0.07;
  stroke: var(--logo);
  stroke-width: 2;
}
.au-b2 {
  width: 110px;
  height: 93px;
  left: -20px;
  bottom: 90px;
  opacity: 0.05;
  stroke: var(--logo);
  stroke-width: 2.5;
  animation-duration: 21s;
  animation-delay: -6s;
}
.au-b3 {
  width: 70px;
  height: 59px;
  left: 18%;
  top: 36px;
  opacity: 0.06;
  stroke: var(--text-3);
  stroke-width: 3;
  animation-duration: 13s;
  animation-delay: -3s;
}

@keyframes audrift {
  from {
    transform: translate(0, 0);
  }
  to {
    transform: translate(40px, 40px);
  }
}
@keyframes aufloat {
  from {
    transform: translate(0, 0) rotate(0);
  }
  to {
    transform: translate(-18px, 26px) rotate(-4deg);
  }
}

/* Error / banner entrance (auin). */
.au-in {
  animation: auin 160ms var(--ease) both;
}
.au-inSlow {
  animation: auin 220ms var(--ease) both;
}
@keyframes auin {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.au-fade {
  animation: aufade 200ms var(--ease) both;
}
@keyframes aufade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* Workspace name in the post-sign-in transition (wordIn at 760ms). */
.au-ws {
  animation: auword 300ms var(--ease) 760ms both;
}
@keyframes auword {
  from {
    opacity: 0;
    transform: translateX(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Success tile spark burst: six dots at ±26/±30 (auspark 520ms after 80ms). */
.au-spark {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 4px;
  margin: -2px 0 0 -2px;
  border-radius: 50%;
  background: var(--spark);
  opacity: 0;
  animation: auspark 520ms var(--ease) 80ms both;
}
@keyframes auspark {
  0% {
    opacity: 1;
    transform: translate(0, 0) scale(0.3);
  }
  100% {
    opacity: 0;
    transform: translate(var(--dx), var(--dy)) scale(1);
  }
}

.au-pop {
  animation: aupop 300ms var(--spring) both;
}
@keyframes aupop {
  0% {
    transform: scale(0.6);
  }
  60% {
    transform: scale(1.12);
  }
  100% {
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .au-grid,
  .au-bolt {
    animation: none;
  }
}
`;

export function AuthStyles() {
  return (
    <style href="lx-au-styles" precedence="default">
      {CSS}
    </style>
  );
}
