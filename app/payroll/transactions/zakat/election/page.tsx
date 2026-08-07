import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { getStatutoryProfileMY } from '@/localization/my/statutory';
import { MY_STATES } from '@/localization/my/holidays';
import { Button, Card, EmployeeName, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { saveZakatElectionAction } from '../election-actions';

/**
 * 6a1f2bd6 — the dedicated Add / Edit page for ONE employee's zakat setup.
 *
 * WHAT IT REPLACES, AND WHY THE REPORTER SENT THE FIRST ATTEMPT BACK. The editor used to be rendered
 * UNCONDITIONALLY on the Zakat list screen the moment an employee resolved, so picking somebody to READ
 * their record opened a form to CHANGE it, before anyone had asked for anything. The list now shows the
 * person's records and an Add / Edit button, and the form lives here — the same three steps, in the same
 * order, as Fixed Transaction (app/payroll/transactions/fixed/[id]/page.tsx).
 *
 * THE FORM IS MOVED, NOT FORKED. This is the field set that used to sit in `zakat/page.tsx`, character for
 * character, still posting to the unchanged `saveZakatElectionAction` → `setStatutoryProfileMY` (validation
 * + domain event intact). Nothing here changes a rate, an effective date, or how a deduction reaches
 * payroll. The "no Malaysian statutory profile yet" branch moved with it, because that is a state of the
 * EDITOR, not of the list.
 *
 * ONE ELECTION PER EMPLOYEE — THERE IS NO VERSION LIST AND THIS PAGE MUST NOT IMPLY ONE. `employee_
 * statutory_my` holds a single row per person and saving OVERWRITES it; switching zakat off nulls every
 * zakat field (resolveZakatElection's "no election regardless of stray values" rule). So the route takes
 * `?employmentId=`, never a record id, and the caption says Add when there is no setup on file and Edit
 * when there is.
 *
 * SCOPE GUARD, SAME FENCE AS THE LIST. `?employmentId=` is resolved against this admin's OWN non-terminated
 * employee set before anything is read — company scope is an application concern (RLS isolates tenants
 * only), so an out-of-scope or terminated id is a 404 here rather than a cross-company read. It is the same
 * set the list feeds its panel, so no row the panel offers can 404 and no id it refuses can open.
 */
export default async function ZakatElectionPage({
  searchParams,
}: {
  searchParams: Promise<{ employmentId?: string; error?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const { employmentId, error } = await searchParams;

  const employees = (await listEmployees(s, scopeIds)).filter((e) => !e.terminatedOn);
  const emp = employmentId ? (employees.find((e) => e.employmentId === employmentId) ?? null) : null;
  if (!emp) notFound();

  const statutory = await getStatutoryProfileMY(s, emp.personId);
  // "Has a setup on file" is the SAME predicate listZakatElections uses for the history list, so the button
  // that brought the reader here and the row they see afterwards can never disagree about which it was.
  const hasElection = statutory != null && (statutory.zakatMethod != null || statutory.zakatActive === true);
  const backHref = `/payroll/transactions/zakat?employmentId=${encodeURIComponent(emp.employmentId)}`;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        back={{ href: backHref, label: t('zakat.title') }}
        title={hasElection ? t('zakat.election.editTitle') : t('zakat.election.addTitle')}
        description={t('zakat.election.subtitle')}
      />

      <ErrorBanner message={error} />

      {/* Employee identity, stated as fact — this page cannot change WHO the setup belongs to, and a
          disabled picker would offer a change the action is designed to refuse. */}
      <Card className="p-4">
        <EmployeeName code={emp.employeeCode} name={emp.name} className="text-sm font-semibold text-foreground" />
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {emp.company} · {emp.department ?? '—'} · {emp.position ?? '—'}
        </p>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('zakat.election.title')} />
        {statutory ? (
          /* The exact field set relocated from Personnel > Statutory (MY) by 58755260. Percent shows as a
             %, stored as a decimal; both amount inputs render and the setter keeps only the one for the
             chosen method. Effective dates are display-only metadata (no calc-path filtering). */
          <form action={saveZakatElectionAction} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <input type="hidden" name="personId" value={emp.personId} />
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                name="zakatActive"
                defaultChecked={statutory.zakatActive ?? false}
                className="size-4 rounded"
              />
              {t('zakat.election.active')}
            </label>
            <Field label={t('zakat.election.state')}>
              <select name="zakatState" defaultValue={statutory.zakatState ?? ''} className={inputCls}>
                <option value="">—</option>
                {MY_STATES.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('zakat.election.method')}>
              <select name="zakatMethod" defaultValue={statutory.zakatMethod ?? ''} className={inputCls}>
                <option value="">—</option>
                <option value="percent_of_pcb">{t('zakat.election.methodPercentOfPcb')}</option>
                <option value="fixed">{t('zakat.election.methodFixed')}</option>
              </select>
            </Field>
            <Field label={t('zakat.election.percent')}>
              <input
                name="zakatPercent"
                type="number"
                min="0"
                step="0.01"
                defaultValue={statutory.zakatPercent ? (Number(statutory.zakatPercent) * 100).toString() : ''}
                placeholder="2.5"
                className={inputCls}
              />
            </Field>
            <Field label={t('zakat.election.fixed')}>
              <input
                name="zakatFixed"
                type="number"
                min="0"
                step="0.01"
                defaultValue={statutory.zakatFixed ?? ''}
                className={inputCls}
              />
            </Field>
            <Field label={t('zakat.election.effectiveFrom')}>
              <input
                name="zakatEffectiveFrom"
                type="date"
                defaultValue={statutory.zakatEffectiveFrom ?? ''}
                className={inputCls}
              />
            </Field>
            <Field label={t('zakat.election.effectiveTo')}>
              <input
                name="zakatEffectiveTo"
                type="date"
                defaultValue={statutory.zakatEffectiveTo ?? ''}
                className={inputCls}
              />
            </Field>
            <p className="sm:col-span-2 text-xs text-muted-foreground">{t('zakat.election.nonResidentHint')}</p>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
              <Button type="submit">{t('zakat.election.save')}</Button>
              <Link
                href={backHref}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {t('zakat.election.cancel')}
              </Link>
            </div>
          </form>
        ) : (
          /* No MY statutory row yet (no IC): the election has nowhere to live. Point at Personnel. */
          <p className="p-4 text-sm text-muted-foreground">
            {t('zakat.election.noProfile')}{' '}
            <Link
              href={`/admin/personnel/${emp.employmentId}`}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('zakat.election.openPersonnel')}
            </Link>
          </p>
        )}
      </Card>
    </div>
  );
}
