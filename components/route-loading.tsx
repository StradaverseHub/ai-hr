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
  return (
    <div role="status" aria-live="polite" aria-busy="true" data-route-loading className="w-full min-w-0 space-y-6">
      <span className="sr-only">{t('loading')}</span>
      <div aria-hidden className="space-y-2">
        <div className="h-7 w-56 max-w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
        <div className="h-4 w-80 max-w-full animate-pulse rounded-md bg-muted/70 motion-reduce:animate-none" />
      </div>
      <div aria-hidden className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-[1.25rem] border border-border bg-card motion-reduce:animate-none" />
        ))}
      </div>
      <div aria-hidden className="h-72 animate-pulse rounded-[1.25rem] border border-border bg-card motion-reduce:animate-none" />
    </div>
  );
}
