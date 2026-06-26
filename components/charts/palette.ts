/**
 * Shared categorical palette for the analytics charts. Explicit hex (not CSS vars) so the SVG→canvas
 * export rasterises the SAME colours the screen shows — getComputedStyle on a `var(--x)` fill would
 * still resolve, but an explicit series palette keeps slices/bars distinguishable and theme-independent.
 * Indigo-led to match the locked single-accent design system (--primary #4f46e5 / #6366f1).
 */
export const CHART_PALETTE = [
  '#6366f1', // indigo-500
  '#0d9488', // teal-600
  '#9333ea', // purple-600
  '#d97706', // amber-600
  '#0ea5e9', // sky-500
  '#e11d48', // rose-600
  '#65a30d', // lime-600
  '#7c3aed', // violet-600
  '#0891b2', // cyan-600
  '#c026d3', // fuchsia-600
];

export const colorAt = (i: number): string => CHART_PALETTE[i % CHART_PALETTE.length];
