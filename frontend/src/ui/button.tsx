"use client";

import { Slot, Slottable } from "@radix-ui/react-slot";
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Kbd } from "./kbd";
import { Spinner } from "./spinner";
import { Tooltip } from "./tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-sm border border-transparent font-medium leading-none " +
  "transition-[background-color,border-color,box-shadow,transform,color] duration-[var(--dur-fast)] ease-out " +
  "active:scale-[.97] motion-reduce:active:scale-100";

const variants: Record<ButtonVariant, string> = {
  primary:
    "on-accent bg-accent text-white hover:bg-accent-h hover:shadow-[0_0_0_4px_var(--accent-s)] active:bg-accent-p",
  secondary: "border-control bg-raised text-fg hover:bg-hover",
  ghost: "bg-transparent text-fg-2 hover:bg-hover hover:text-fg",
  danger:
    "bg-danger-solid text-white hover:shadow-[0_0_0_4px_var(--danger-s)]",
  "danger-ghost": "bg-transparent text-danger hover:bg-hover",
};

/** While loading, hold the resting look: no hover/press feedback, slightly dimmed. */
const loadingVariants: Record<ButtonVariant, string> = {
  primary: "hover:bg-accent hover:shadow-none active:bg-accent",
  secondary: "hover:bg-raised",
  ghost: "hover:bg-transparent hover:text-fg-2",
  danger: "hover:shadow-none",
  "danger-ghost": "hover:bg-transparent",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px]",
  md: "h-8 px-3 text-[13px]",
  lg: "h-10 px-4 text-[14px]",
};

const iconSizes: Record<ButtonSize, string> = {
  sm: "h-7 w-7 px-0",
  md: "h-8 w-8 px-0",
  lg: "h-10 w-10 px-0",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square icon-only button. Requires aria-label. */
  icon?: boolean;
  loading?: boolean;
  /** Trailing keycap hint, e.g. "C". */
  kbd?: string;
  /**
   * Design rule: "Disabled = visible reason". When set, the button renders as
   * aria-disabled (still focusable) with this reason in a tooltip and aria-describedby.
   */
  disabledReason?: string;
  /** Tooltip label (+ optional shortcut keys) for icon buttons. */
  tooltip?: ReactNode;
  tooltipKeys?: string[];
  asChild?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    icon,
    loading,
    kbd,
    disabledReason,
    tooltip,
    tooltipKeys,
    asChild,
    className,
    children,
    onClick,
    type = "button",
    ...props
  },
  ref,
) {
  const reasonId = useId();
  const blocked = Boolean(disabledReason);
  const Comp = asChild ? Slot : "button";

  const button = (
    <Comp
      ref={ref}
      type={asChild ? undefined : type}
      aria-busy={loading || undefined}
      aria-disabled={blocked || loading || undefined}
      aria-describedby={blocked ? reasonId : props["aria-describedby"]}
      onClick={blocked || loading ? (e: React.MouseEvent<HTMLButtonElement>) => e.preventDefault() : onClick}
      className={cn(
        base,
        variants[variant],
        icon ? iconSizes[size] : sizes[size],
        blocked &&
          "border-line bg-raised text-fg-3 shadow-none hover:bg-raised hover:shadow-none active:scale-100",
        loading && cn("cursor-progress opacity-80 active:scale-100", loadingVariants[variant]),
        className,
      )}
      {...props}
    >
      {loading && <Spinner className={variant === "primary" || variant === "danger" ? "text-white" : undefined} />}
      {asChild ? (
        // Slottable: the child element becomes the button and the spinner is prepended inside it.
        <Slottable>{children}</Slottable>
      ) : (
        <>
          {children}
          {kbd && <Kbd>{kbd}</Kbd>}
          {blocked && (
            // aria-hidden keeps the reason out of the accessible *name*; aria-describedby
            // still exposes it as the description.
            <span id={reasonId} className="sr-only" aria-hidden>
              {disabledReason}
            </span>
          )}
        </>
      )}
    </Comp>
  );

  if (blocked) return <Tooltip content={disabledReason}>{button}</Tooltip>;
  if (tooltip) return <Tooltip content={tooltip} keys={tooltipKeys}>{button}</Tooltip>;
  return button;
});
