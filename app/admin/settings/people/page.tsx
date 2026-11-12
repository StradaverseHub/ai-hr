import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { canConfigurePeopleGeneral } from '@/core/people-general';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { visiblePeopleSettingsSections } from './cards';

/**
 * 82748f92 — People › Configuration › Settings: one card page for the six People setup screens that used to be
 * separate menu rows (Employee ID numbering, General, System Labels, Movement Settings, Hiring Defaults, Employee
 * Change Requests). Modelled on Payroll Settings (/payroll/setup) through its closest copy, Attendance Settings
 * (app/admin/attendance/settings/page.tsx): the same header and card grid, no readiness panel.
 *
 * Navigation only: no write and no new permission. Every card opens the page the row opened, so bookmarks and the
 * destinations' own guards are untouched. requireAdmin matches the menu row (adminOnly) and every destination's
 * floor. A card shows only when its page would open for this viewer: General additionally needs
 * app.people_general_can_configure() (a group-wide administrator; the General page redirects anyone else home).
 * That is ONE statement for the whole page, with no per-company or per-section loop and no Access lock: the other
 * five sections need nothing beyond the admin floor already checked.
 */
export default async function PeopleSettingsPage() {
  const s = await requireAdmin();
  const t = await getTranslations('peopleSettingsHub');
  const cards = visiblePeopleSettingsSections({ isAdmin: true, canConfigurePeopleGeneral: await canConfigurePeopleGeneral(s) });

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('subtitle')} />

      {cards.length ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => (
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
      ) : (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      )}
    </div>
  );
}
