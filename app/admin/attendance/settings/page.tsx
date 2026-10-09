import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { ATTENDANCE_SETTINGS_CARDS } from './cards';

/**
 * r431 (bdfe4968) — Attendance › Settings: one card page for the five setup screens that used to sit in the
 * Attendance menu beside the everyday ones (Shift, File Structure Mapping, Schedule, Attendance Allowance,
 * Locations). Modelled on Payroll's /payroll/setup, copying only its card grid — the readiness panel there
 * is payroll-specific.
 *
 * Navigation only: no write, no query, no new permission. Every card opens the page the row opened, so
 * bookmarks and the destinations' own guards are untouched. requireAdmin matches the menu row (adminOnly)
 * and every destination. The page lives under app/admin/attendance so the attendance moduleLayout covers
 * it; /admin/attendance-allowance and /admin/work-locations are outside that layout, which is why the
 * landing could not sit anywhere else.
 */
export default async function AttendanceSettingsPage() {
  await requireAdmin();
  const t = await getTranslations('attendanceSettingsHub');

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('subtitle')} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ATTENDANCE_SETTINGS_CARDS.map((c) => (
          <Card key={c.key} className="flex flex-col p-5">
            <h2 className="text-base font-semibold">{t(`${c.key}.title`)}</h2>
            <p className="mt-1 flex-1 text-sm text-muted-foreground">{t(`${c.key}.desc`)}</p>
            <Link
              href={c.href}
              className="mt-4 inline-flex w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t(`${c.key}.cta`)}
            </Link>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{t('footnote')}</p>
    </div>
  );
}
