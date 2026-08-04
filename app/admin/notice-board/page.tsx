import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { listNotices, NOTICE_STATUSES, type NoticeStatus } from '@/core/notice';
import {
  Card,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  StatusBadge,
  btnPrimary,
  inputCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * 6e122302 — Admin → Notice Board, the listing.
 *
 * SERVER COMPONENT, and there is no client island on it at all: search, status filter and sort are a plain
 * GET form and `?q=&status=&sort=`, so the screen works with JavaScript disabled and every number on it is
 * one the server computed. The interactive part of this module is the setup form on the detail page.
 *
 * STATUS IS DERIVED — `listNotices` runs `deriveNoticeStatus` per row against the tenant-local today. This
 * page never computes it, which is why the listing and the employee reads can never disagree about whether
 * a notice is live.
 *
 * ⚠️ ONE i18n NAMESPACE ON PURPOSE. test/i18n-coverage.test.ts check C SKIPS any file opening more than
 * one, which is exactly how r127 shipped a screen whose every chip rendered a MISSING_MESSAGE behind a
 * green suite. The criteria vocabulary this module also needs (org axes, employment types) is resolved on
 * the detail page, which carries its own guard — see test/notice-board.test.ts.
 */
export default async function NoticeBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; q?: string; status?: string; sort?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('notices');
  const { error, q, status, sort } = await searchParams;

  const all = await listNotices(s, { includeArchived: true });

  const needle = (q ?? '').trim().toLowerCase();
  const wanted = NOTICE_STATUSES.includes(status as NoticeStatus) ? (status as NoticeStatus) : null;
  const rows = all
    .filter((n) => (needle ? n.title.toLowerCase().includes(needle) : true))
    .filter((n) => (wanted ? n.status === wanted : true));

  // Sort keys are a closed set — an unknown `?sort=` falls back to newest-first rather than throwing or
  // silently sorting by something the user did not ask for.
  const sorted = [...rows].sort((a, b) => {
    switch (sort) {
      case 'title':
        return a.title.localeCompare(b.title);
      case 'start':
        return a.startOn.localeCompare(b.startOn);
      case 'end':
        return a.endOn.localeCompare(b.endOn);
      case 'status':
        return a.status.localeCompare(b.status);
      default:
        return b.createdAt.getTime() - a.createdAt.getTime();
    }
  });

  const sortHref = (key: string) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    p.set('sort', key);
    return `/admin/notice-board?${p.toString()}`;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={
          <Link href="/admin/notice-board/new" className={btnPrimary}>
            {t('add')}
          </Link>
        }
      />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title={t('listTitle')} count={sorted.length} />
        <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('search')}
            <input name="q" type="search" defaultValue={q ?? ''} className={cn(inputCls, 'w-56')} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filterStatus')}
            <select name="status" defaultValue={status ?? ''} className={cn(inputCls, 'w-40')}>
              <option value="">{t('allStatuses')}</option>
              {NOTICE_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {t(`status.${v}`)}
                </option>
              ))}
            </select>
          </label>
          {sort && <input type="hidden" name="sort" value={sort} />}
          <button type="submit" className={btnPrimary}>
            {t('applyFilter')}
          </button>
        </form>

        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>
                  <Link href={sortHref('title')}>{t('colTitle')}</Link>
                </th>
                <th className={thCls}>
                  <Link href={sortHref('start')}>{t('colStart')}</Link>
                </th>
                <th className={thCls}>
                  <Link href={sortHref('end')}>{t('colEnd')}</Link>
                </th>
                <th className={thCls}>
                  <Link href={sortHref('status')}>{t('colStatus')}</Link>
                </th>
                <th className={thCls}>{t('colPublishedBy')}</th>
                <th className={thCls}>{t('colRecipients')}</th>
                <th className={thCls}>{t('colActions')}</th>
              </tr>
            </thead>
            <tbody className={tbodyCls}>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {t('listEmpty')}
                  </td>
                </tr>
              )}
              {sorted.map((n) => (
                <tr key={n.id}>
                  <td className="px-3 py-2 font-medium">{n.title}</td>
                  <td className="px-3 py-2">{n.startOn}</td>
                  <td className="px-3 py-2">{n.endOn}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={n.status} label={t(`status.${n.status}`)} />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{n.publishedBy ?? '—'}</td>
                  {/* Targeted, not delivered — the snapshot size. Zero for a draft, because a draft has no
                      audience until it is published, which is the whole point of snapshotting at publish. */}
                  <td className="px-3 py-2 text-muted-foreground">{n.recipientCount}</td>
                  <td className="px-3 py-2">
                    <Link href={`/admin/notice-board/${n.id}`} className="text-primary underline underline-offset-2">
                      {t('viewEdit')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
