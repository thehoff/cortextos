/**
 * BrandMark — the cortextOS "cO" logomark.
 *
 * Replaces hardcoded `<div>cO</div>` markup in the sidebar, splash screen,
 * and login page (issue #11). Rendered as inline SVG so:
 *   - No extra HTTP request
 *   - Colors come from `--primary` / `--primary-foreground` via CSS classes,
 *     so dark mode + future per-org theme overrides (#9) work for free
 *   - Scales cleanly at any size (sidebar 28px / login 48px / splash 64px)
 *
 * When #9 ships per-org `theme.logoPath` overrides, this component can
 * accept an optional `logoPath` prop and render `<img>` when set.
 */

interface BrandMarkProps {
  /** Rendered size in pixels. Defaults to 32 (matches the source SVG viewbox). */
  size?: number;
  /** Optional className, applied to the outer `<svg>`. */
  className?: string;
  /** Optional accessible label. Defaults to "cortextOS". */
  label?: string;
}

export function BrandMark({ size = 32, className, label = 'cortextOS' }: BrandMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label={label}
    >
      <rect width="32" height="32" rx="6" className="fill-primary" />
      <text
        x="16"
        y="22"
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="16"
        fontWeight="700"
        className="fill-primary-foreground"
      >
        cO
      </text>
    </svg>
  );
}
