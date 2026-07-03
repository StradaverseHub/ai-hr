import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listAttendancePolicies } from '@/core/attendance';
import { Card, ErrorBanner, Field, PageHeader, btnPrimary, inputCls } from '@/components/ui';
import { setAttendancePolicyAction } from '../actions';

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEY: Record<number, string> = { 1: 'dayMon', 2: 'dayTue', 3: 'dayWed', 4: 'dayThu', 5: 'dayFri', 6: 'daySat', 7: 'daySun' };
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;

export default async function AttendancePolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.attendancePolicy');
  const { error } = await searchParams;

  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id));
  const policies = await listAttendancePolicies(s, visible.map((c) => c.id));
  const byCompany = new Map(policies.map((p) => [p.companyId, p]));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>
      ) : (
        visible.map((c) => {
          const p = byCompany.get(c.id);
          if (!p) return null;
          const net = Math.max(0, toMin(p.workEnd) - toMin(p.workStart) - p.breakMinutes);
          return (
            <Card key={c.id}>
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">{c.name}</h2>
                {p.isDefault ? (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                    {t('usingDefaults')}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">{t('netScheduled', { hours: hm(net) })}</span>
                )}
              </div>
              <form action={setAttendancePolicyAction} className="space-y-4 p-4">
                <input type="hidden" name="companyId" value={c.id} />
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Field label={t('workStart')}>
                    <input type="time" name="workStart" required defaultValue={p.workStart.slice(0, 5)} className={inputCls} />
                  </Field>
                  <Field label={t('workEnd')}>
                    <input type="time" name="workEnd" required defaultValue={p.workEnd.slice(0, 5)} className={inputCls} />
                  </Field>
                  <Field label={t('breakMinutes')}>
                    <input type="number" name="breakMinutes" min={0} max={480} required defaultValue={p.breakMinutes} className={inputCls} />
                  </Field>
                  <Field label={t('lateAfter')}>
                    <input type="time" name="lateAfter" required defaultValue={p.lateAfter.slice(0, 5)} className={inputCls} />
                  </Field>
                  <Field label={t('halfDayBefore')}>
                    <input type="time" name="halfDayBefore" required defaultValue={p.halfDayBefore.slice(0, 5)} className={inputCls} />
                  </Field>
                </div>

                <fieldset>
                  <legend className="mb-1.5 text-sm font-medium text-foreground">{t('workingDays')}</legend>
                  <p className="mb-2 text-xs text-muted-foreground">{t('dayTypeHint')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {ISO_DAYS.map((d) => {
                      const dayType: 'full' | 'half' | 'rest' = p.workingDays.includes(d)
                        ? 'full'
                        : p.halfWorkingDays.includes(d)
                          ? 'half'
                          : 'rest';
                      return (
                        <div
                          key={d}
                          className="flex flex-col items-center gap-1 rounded-lg border border-border px-2 py-1.5"
                        >
                          <span className="text-xs font-medium text-foreground">{t(DAY_KEY[d])}</span>
                          {/* One <select> per weekday posts "full" | "half" | "rest" — decoded server-side in
                              setAttendancePolicyAction into the two ISO-weekday arrays the service expects.
                              Mutual exclusion is structural (one value per day), no extra client JS needed. */}
                          <select
                            name={`dayType_${d}`}
                            defaultValue={dayType}
                            className="rounded border border-border bg-transparent px-1 py-0.5 text-xs"
                          >
                            <option value="full">{t('dayTypeFull')}</option>
                            <option value="half">{t('dayTypeHalf')}</option>
                            <option value="rest">{t('dayTypeRest')}</option>
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </fieldset>

                <div className="flex items-center gap-3">
                  <button className={btnPrimary}>{t('save')}</button>
                  <span className="text-xs text-muted-foreground">{t('lateHint')}</span>
                </div>
              </form>
            </Card>
          );
        })
      )}

      <p className="px-1 text-xs text-muted-foreground">{t('rosterNote')}</p>
    </div>
  );
}
