import type { SVGProps } from "react";

import { cn } from "~/lib/utils";

/**
 * The Adly mark: an open "A" drawn as two strokes with a detached crossbar.
 * Used where a glyph is needed (assistant avatar, favicons); the sidebar
 * brand is the wordmark alone.
 */
export function AdlyMark({
  className,
  accent = "brand",
  ...props
}: SVGProps<SVGSVGElement> & {
  readonly className?: string;
  // "inherit" keeps the crossbar in the text color where the brand blue
  // would sink into a colored background.
  readonly accent?: "brand" | "inherit";
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d="M4 29 L13.6 4 H18.4 L28 29 H22.9 L16 10.2 L9.1 29 Z" fill="currentColor" />
      <path
        d="M11.2 22.4 H20.8 V26.2 H11.2 Z"
        className={accent === "brand" ? "fill-adly-accent" : "fill-current opacity-60"}
      />
    </svg>
  );
}

// Avenir Next is on every Mac and carries the wordmark's geometry; the
// interface face is the fallback everywhere else.
const WORDMARK_FONT = "font-['Avenir_Next','Helvetica_Neue',var(--font-sans)]";

/**
 * "ADLY" as pure typography: capitals, demi-bold, letterspaced wide so the
 * four letters sit as a plate rather than a word. `size` keeps every surface
 * on the same proportions.
 */
export function AdlyWordmark({
  size = "sm",
  className,
}: {
  readonly size?: "sm" | "md" | "lg";
  readonly className?: string;
}) {
  const sizeClass =
    size === "lg"
      ? "text-[1.75rem] tracking-[0.3em]"
      : size === "md"
        ? "text-lg tracking-[0.28em]"
        : "text-[13px] tracking-[0.26em]";
  return (
    <span
      role="img"
      aria-label="Adly"
      className={cn(
        "inline-block select-none leading-none font-semibold uppercase text-current",
        // Trailing letterspacing would otherwise offset the plate to the left.
        "-me-[0.26em]",
        WORDMARK_FONT,
        sizeClass,
        className,
      )}
    >
      ADLY
    </span>
  );
}
