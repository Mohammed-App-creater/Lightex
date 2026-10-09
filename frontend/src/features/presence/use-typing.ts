"use client";

import { useEffect, useRef, useState } from "react";
import { presenceClaims } from "@/lib/realtime/presence";

/*
 * useTypingSignal (spec §2.8): typing comes from the comment composer only. The first key turns
 * typing on; while keys keep coming the heartbeat is re-sent every 4 s (the server keeps the flag
 * 8 s); blur, send or 5 s without a key turn it off.
 */

export const TYPING_RESEND_MS = 4000;
export const TYPING_IDLE_MS = 5000;

export function useTypingSignal() {
  const [typing, setTyping] = useState(false);
  const lastSent = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(idle.current), []);

  const stop = () => {
    clearTimeout(idle.current);
    setTyping(false);
  };

  return {
    typing,
    onKeyDown: (e: { key: string; metaKey?: boolean; ctrlKey?: boolean }) => {
      // ⌘↵ sends; modifiers alone aren't typing.
      if (e.metaKey || e.ctrlKey || e.key === "Shift" || e.key === "Alt" || e.key === "Meta" || e.key === "Control" || e.key === "Escape" || e.key === "Tab") return;
      const now = Date.now();
      if (!typing) {
        setTyping(true);
        lastSent.current = now;
      } else if (now - lastSent.current >= TYPING_RESEND_MS) {
        lastSent.current = now;
        presenceClaims.touch();
      }
      clearTimeout(idle.current);
      idle.current = setTimeout(stop, TYPING_IDLE_MS);
    },
    onBlur: stop,
    onSend: stop,
  };
}

export type TypingSignal = ReturnType<typeof useTypingSignal>;
