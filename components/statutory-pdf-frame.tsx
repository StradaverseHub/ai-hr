'use client';

/**
 * r402 (item f3cf2444) — the viewer's frame, and the ONE thing in the viewer that needs the client.
 *
 * A form's inline route does not always answer with a PDF. PCB 2(II) refuses a selection it cannot
 * prepare (no Selected Date, no authorised signatory, a field that will not fit) with a 303 back to its
 * picker, carrying the reason — and inside a frame that would draw the whole picker, header and all, in a
 * box in the middle of the viewer. So when the frame finishes loading somewhere OTHER than the inline
 * route, the page follows it at the top level and the operator sees the refusal where it was written to
 * be seen. Same-origin only: a frame this page cannot read is left exactly as it is.
 */
export function StatutoryPdfFrame({
  src,
  inlinePath,
  title,
  className,
}: {
  src: string;
  /** The inline route's path (no query); anything else the frame lands on is followed at the top level. */
  inlinePath: string;
  title: string;
  className?: string;
}) {
  return (
    <iframe
      src={src}
      title={title}
      className={className}
      onLoad={(e) => {
        try {
          const loc = e.currentTarget.contentWindow?.location;
          if (loc && loc.href !== 'about:blank' && loc.pathname !== inlinePath) window.location.assign(loc.href);
        } catch {
          // Cross-origin or otherwise unreadable — leave the frame alone.
        }
      }}
    />
  );
}
