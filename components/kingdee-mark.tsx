/**
 * The Kingdee symbol — the four dots, drawn rather than imported.
 *
 * WHY IT IS AN SVG AND NOT THE SUPPLIED JPEG. The brand asset we were given is a 1200x675 JPEG whose
 * background is a flat #f7f7f7, not transparency. Dropped into the sidebar's 40px rounded badge that
 * renders as a grey tile in light mode and a bright grey box in dark mode, and it resamples badly at
 * that size. The mark itself is four circles, so it costs less to draw it exactly: crisp at any size,
 * correct in both themes, and no extra request.
 *
 * The geometry and the colours are MEASURED FROM THE SUPPLIED ARTWORK, not eyeballed — connected-
 * component analysis over the source gave each circle's centre, radius and modal fill, which were then
 * normalised into a square 100x100 viewBox with 6% padding (source bbox 40.3,269.8 -> 304.0,651.4).
 * The mark is taller than it is wide, so it does not fill the box horizontally; that is the artwork's
 * own proportion and must not be "fixed" by stretching it.
 *
 * The colours are the brand's and are therefore hard-coded, never themed — a logo that changes hue with
 * the colour scheme is no longer the logo.
 */
export function KingdeeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" role="img" aria-hidden focusable="false" className={className}>
      <circle cx="51.67" cy="17.29" r="14.46" fill="#0085d0" />
      <circle cx="51.67" cy="66.32" r="11.00" fill="#00b1c3" />
      <circle cx="27.17" cy="41.79" r="9.77" fill="#00b7f0" />
      <circle cx="76.29" cy="90.87" r="6.30" fill="#c170aa" />
    </svg>
  );
}
