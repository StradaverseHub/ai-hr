'use client';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Drawer } from '@/components/ui/drawer';

/** 5d34d00d Step 2 — the person side panel. The open person lives in the URL (?person=<entryId>) so the
 *  server renders the panel from the same visible rows as the table, Previous / Next follow the table's
 *  order, and a refresh or shared link reopens the same person. Closing drops only that parameter. */
export function PersonDrawer({ title, description, prevId, nextId, position, children, editHref }: {
  title: string; description: string; prevId: string | null; nextId: string | null;
  position: { index: number; total: number }; children: ReactNode; editHref: string;
}) {
  const t = useTranslations('rewards.desk.person');
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();
  const hrefFor = (id: string | null) => { const q = new URLSearchParams(params.toString()); if (id) q.set('person', id); else q.delete('person'); const s = q.toString(); return `${pathname}${s ? `?${s}` : ''}`; };
  const nav = 'rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent';
  return <Drawer open onOpenChange={open => { if (!open) router.replace(hrefFor(null), { scroll: false }); }} title={title} description={description} closeLabel={t('close')}
    footer={<div className="flex flex-wrap items-center gap-2">
      {prevId ? <Link scroll={false} replace href={hrefFor(prevId)} className={nav}>← {t('previous')}</Link> : <span aria-disabled className={`${nav} opacity-40`}>← {t('previous')}</span>}
      {nextId ? <Link scroll={false} replace href={hrefFor(nextId)} className={nav}>{t('next')} →</Link> : <span aria-disabled className={`${nav} opacity-40`}>{t('next')} →</span>}
      <span className="text-sm text-muted-foreground tabular-nums">{t('position', position)}</span>
      <Link href={editHref} className="ml-auto text-sm font-medium text-primary hover:underline">{t('openRecord')}</Link>
    </div>}>{children}</Drawer>;
}
