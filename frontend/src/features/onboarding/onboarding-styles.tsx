"use client";

/*
 * "You’re ready" ring (board 23 §3.5).
 * Plain global classes in a hoisted <style> (React 19 dedupes by href): the project's turbopack
 * rule compiles every *.css as plain CSS, so CSS modules aren't available.
 */

export const onboardingStylesClasses = {
  ring: "ob-ring",
  spark: "ob-spark",
} as const;

const CSS = `/* "You’re ready" ring (board 23 §3.5): pop, check draws, spark burst. */
.ob-ring {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--ok);
  animation: obpop 300ms var(--spring) both;
}
.ob-ring::after {
  content: "";
  position: absolute;
  left: 18px;
  top: 11px;
  width: 9px;
  height: 18px;
  border: solid var(--bg);
  border-width: 0 3px 3px 0;
  transform: rotate(45deg);
  animation: obdraw 220ms var(--ease) 120ms both;
}
.ob-spark {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 5px;
  height: 5px;
  margin: -2.5px 0 0 -2.5px;
  border-radius: 50%;
  background: var(--spark);
  opacity: 0;
  animation: obspark 520ms var(--ease) 80ms both;
}
@keyframes obpop {
  0% {
    transform: scale(0.6);
  }
  60% {
    transform: scale(1.2);
  }
  100% {
    transform: scale(1);
  }
}
@keyframes obdraw {
  from {
    clip-path: inset(0 0 100% 0);
  }
  to {
    clip-path: inset(0);
  }
}
@keyframes obspark {
  0% {
    opacity: 1;
    transform: translate(0, 0) scale(0.3);
  }
  100% {
    opacity: 0;
    transform: translate(var(--dx), var(--dy)) scale(1.5);
  }
}
`;

export function OnboardingStyles() {
  return (
    <style href="lx-ob-styles" precedence="default">
      {CSS}
    </style>
  );
}
