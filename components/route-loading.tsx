import { getTranslations } from 'next-intl/server';

/**
 * r394 — THE INSTANT NAVIGATION SHELL. Every page folder's `loading.tsx` re-exports this.
 *
 * Why it exists: every page here is dynamic (session, scope, RLS), and Next 16 does NOT prefetch a dynamic
 * route that has no `loading.tsx` — so before r394 a sidebar click left the old page frozen on screen until
 * the next page's whole server render finished (measured on production 2026-10-07: up to 510 ms for an
 * employee's My Leave, nothing prefetched on any hop). With a boundary, the click commits at once to this
 * shell (the sidebar highlight moves, the old page goes) and Next prefetches the shell on hover/viewport.
 *
 * A boundary only covers its own segment: a sibling navigation (/leave → /leave/history) shows a skeleton
 * only if the DESTINATION folder has one, which is why every page folder carries its own one-line file
 * (test/r394-route-loading.test.ts keeps that true). Deliberately generic: a page-shaped placeholder, not a
 * guess at each page's layout, so it can never promise content the page does not have.
 */
export default async function RouteLoading() {
  const t = await getTranslations('common');
  // r399: the first shell (r394) drew three empty cards and a panel — on a slow page (a feedback item: ~350 ms of
  // it on production) that read as "weird empty white boxes", not as loading. Now: a title, a subtitle and a
  // few hairline rows (no filled cards, no shadows), drawn with theme tokens so Monolith and Classic each get
  // their own quiet version, and FADED IN after 150 ms (`.route-loading` in app/globals.css) so a fast load
  // never shows it at all. Reduced motion: no fade and no pulse, still announced.
  return (
    <div role="status" aria-live="polite" aria-busy="true" data-route-loading className="route-loading w-full min-w-0 space-y-6">
      <span className="sr-only">{t('loading')}</span>
      <div aria-hidden className="space-y-2.5">
        <div className="h-6 w-56 max-w-full animate-pulse rounded-md bg-muted/80 motion-reduce:animate-none" />
        <div className="h-3.5 w-80 max-w-full animate-pulse rounded-md bg-muted/50 motion-reduce:animate-none" />
      </div>
      <div aria-hidden className="divide-y divide-border border-y border-border">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-6 py-4">
            <div className="h-3 w-24 shrink-0 animate-pulse rounded-sm bg-muted/60 motion-reduce:animate-none" />
            <div className="h-3 flex-1 animate-pulse rounded-sm bg-muted/40 motion-reduce:animate-none" style={{ maxWidth: `${60 - i * 6}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
