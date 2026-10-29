/**
 * Decorative mountain landscapes (inline SVG, no external images).
 * "light": misty, sunlit ridges for the welcome banner.
 * "dark": navy ridges for the bottom of the sidebar.
 */
export function Mountains({ variant, className }: { variant: "light" | "dark"; className?: string }) {
  const id = `m-${variant}`;
  if (variant === "dark") {
    return (
      <svg viewBox="0 0 400 260" preserveAspectRatio="xMidYMax slice" className={className} aria-hidden>
        <defs>
          <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#001452" stopOpacity="0" />
            <stop offset="1" stopColor="#0b2266" stopOpacity="0.9" />
          </linearGradient>
          <linearGradient id={`${id}-far`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3b4f8f" />
            <stop offset="1" stopColor="#14286a" />
          </linearGradient>
          <linearGradient id={`${id}-mid`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#24387a" />
            <stop offset="1" stopColor="#0a1c58" />
          </linearGradient>
          <linearGradient id={`${id}-near`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0f2263" />
            <stop offset="1" stopColor="#000c33" />
          </linearGradient>
          <linearGradient id={`${id}-mist`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#c9d2ea" stopOpacity="0" />
            <stop offset="0.5" stopColor="#c9d2ea" stopOpacity="0.12" />
            <stop offset="1" stopColor="#c9d2ea" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect width="400" height="260" fill={`url(#${id}-sky)`} />
        <path d="M0 120 L40 92 L62 104 L96 64 L118 80 L150 40 L172 58 L196 46 L230 88 L262 70 L300 104 L330 84 L360 110 L400 96 L400 260 L0 260Z" fill={`url(#${id}-far)`} opacity="0.75" />
        <path d="M150 40 L162 52 L156 56 L172 58 L160 48Z M96 64 L104 72 L100 75Z" fill="#e8cc8a" opacity="0.35" />
        <rect y="110" width="400" height="40" fill={`url(#${id}-mist)`} />
        <path d="M0 160 L36 130 L70 150 L110 112 L140 136 L176 118 L214 150 L252 124 L290 150 L330 128 L372 152 L400 140 L400 260 L0 260Z" fill={`url(#${id}-mid)`} />
        <path d="M0 204 L50 176 L92 196 L140 168 L186 198 L232 178 L280 204 L330 182 L400 206 L400 260 L0 260Z" fill={`url(#${id}-near)`} />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 640 220" preserveAspectRatio="xMaxYMid slice" className={className} aria-hidden>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6f1e6" />
          <stop offset="0.55" stopColor="#f3e3bd" />
          <stop offset="1" stopColor="#f8f2e4" />
        </linearGradient>
        <radialGradient id={`${id}-sun`} cx="0.62" cy="0.42" r="0.45">
          <stop offset="0" stopColor="#fff7e2" stopOpacity="0.95" />
          <stop offset="1" stopColor="#fff7e2" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-far`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a9b1c0" />
          <stop offset="1" stopColor="#d9dbe0" />
        </linearGradient>
        <linearGradient id={`${id}-mid`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6c7488" />
          <stop offset="1" stopColor="#b7b6b2" />
        </linearGradient>
        <linearGradient id={`${id}-near`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4b4e57" />
          <stop offset="0.6" stopColor="#7d6f55" />
          <stop offset="1" stopColor="#c6b48c" />
        </linearGradient>
        <linearGradient id={`${id}-mist`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fbf7ee" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fbf7ee" stopOpacity="0.8" />
          <stop offset="1" stopColor="#fbf7ee" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset="0.35" stopColor="white" stopOpacity="1" />
        </linearGradient>
        <mask id={`${id}-mask`}>
          <rect width="640" height="220" fill={`url(#${id}-fade)`} />
        </mask>
      </defs>
      <g mask={`url(#${id}-mask)`}>
        <rect width="640" height="220" fill={`url(#${id}-sky)`} />
        <rect width="640" height="220" fill={`url(#${id}-sun)`} />
        <path d="M0 176 L80 162 L160 150 L230 110 L262 120 L320 74 L352 92 L404 40 L428 58 L452 46 L500 96 L540 78 L580 104 L640 86 L640 220 L0 220Z" fill={`url(#${id}-far)`} opacity="0.85" />
        <path d="M404 40 L418 56 L410 60 L428 58 L414 46Z M320 74 L332 86 L326 88Z M452 46 L462 58 L456 60Z" fill="#ffffff" opacity="0.8" />
        <rect x="0" y="96" width="640" height="44" fill={`url(#${id}-mist)`} />
        <path d="M0 196 L100 184 L200 176 L262 140 L300 156 L356 116 L392 140 L436 120 L486 150 L530 128 L586 156 L640 136 L640 220 L0 220Z" fill={`url(#${id}-mid)`} opacity="0.9" />
        <path d="M356 116 L366 128 L360 130Z M436 120 L446 130 L440 132Z" fill="#f4e2b8" opacity="0.7" />
        <rect x="0" y="150" width="640" height="30" fill={`url(#${id}-mist)`} />
        <path d="M0 212 L120 200 L240 206 L300 186 L346 198 L404 168 L452 190 L508 172 L560 196 L640 178 L640 220 L0 220Z" fill={`url(#${id}-near)`} opacity="0.85" />
      </g>
    </svg>
  );
}
