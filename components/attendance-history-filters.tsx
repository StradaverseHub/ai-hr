"use client";
import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from './ui';

/** Independent additional-filter fold; hidden controls stay mounted and submit their values. */
export function AttendanceHistoryFilters({ panel, selection, children, defaultOpen }: {
  panel: ReactNode; selection?: ReactNode; children: ReactNode; defaultOpen: boolean;
}) {
  const t = useTranslations('attendanceHistory'), id = useId(), [expanded, setExpanded] = useState(defaultOpen);
  function toggle() {
    setExpanded(!expanded);
    document.cookie = `attendance-history-panel=${expanded ? '0' : '1'}; path=/; max-age=31536000; samesite=lax`;
  }
  return <div className="space-y-5">
    <form method="get" className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        {selection}
        <Button type="button" variant="secondary" className="min-h-11" aria-expanded={expanded} aria-controls={id} onClick={toggle}>{t(expanded ? 'hideFilters' : 'showFilters')}</Button>
        <Button type="submit" className="min-h-11">{t('filter')}</Button>
        <Link className="inline-flex min-h-11 items-center px-3 text-sm text-primary underline" href="/attendance/application-history">{t('clear')}</Link>
      </div>
      <div id={id} hidden={!expanded}>{panel}</div>
    </form>
    <div className="min-w-0">{children}</div>
  </div>;
}
