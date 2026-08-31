import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { recordReadiness, PEOPLE_PER_GAP } from '@/core/record-readiness';
import { Card, EmployeeCode, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';

/**
 * ADR-0083 §3 item 2 — the readiness screen. The shift-left half of the control plane.
 *
 * THE PAGE IS A FIX LIST, NOT A FINDING LIST, AND THAT IS THE WHOLE POINT. The exceptions queue asks an
 * operator to disposition an occurrence; this asks them to complete a record. The difference is the ADR's
 * central economic claim — a fix is permanent, a review recurs every cycle — so the layout is built around
 * the gap, with the people inside it, rather than around the person with their gaps listed.
 *
 * EVERY GAP LEADS WITH WHAT IT STOPS. "No bank account" is a data complaint; "payment will fail for 14
 * people" is a consequence somebody acts on this afternoon. The consequence is the heading and the field
 * name is the detail, not the other way round.
 *
 * AN EMPTY LIST IS THE GOAL STATE AND IS RENDERED AS ONE. A readiness screen that looks identical whether
 * it found nothing or ran nothing teaches an operator to distrust it, so "everyone is ready" says so
 * explicitly and names the number it checked.
 */
export default async function ReadinessPage() {
  const s = await requireAdmin();
  const t = await getTranslations('controlTower.readinessScreen');
  const view = await recordReadiness(s);
  const pct = view.employees === 0 ? 1 : view.ready / view.employees;

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('title')}
        description={t('description')}
        back={{ href: '/control-tower', label: t('backToTower') }}
      />

      <Card className="p-5">
        <div className="flex flex-wrap items-end gap-8">
          <div>
            <p className="text-4xl font-semibold tabular-nums">{Math.round(pct * 100)}%</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('readyPct')}</p>
          </div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">
              {view.ready.toLocaleString()} / {view.employees.toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t('readyOf')}</p>
          </div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">{view.gaps.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('gapKinds')}</p>
          </div>
          {/* Said out loud, because a screen with no timestamp invites "is this from last night?" — and
              the honest answer here is better than a timestamp would be. */}
          <p className="max-w-sm text-xs text-muted-foreground">{t('liveNote')}</p>
        </div>
      </Card>

      {view.gaps.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm">{t('allReady', { n: view.employees })}</p>
        </Card>
      ) : (
        view.gaps.map((g) => (
          <Card key={g.id} className="overflow-hidden">
            <SectionHeader title={t(`gap.${g.id}`)} count={g.count} />
            <div className="px-4 pb-4">
              {/* The consequence, first and in its own right. */}
              <p
                className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-medium ${
                  g.blocks === 'payroll'
                    ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
                    : g.blocks === 'payment'
                      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      : 'bg-muted text-muted-foreground'
                }`}
              >
                {t(`blocks.${g.blocks}`, { n: g.count })}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">{t(`gap.${g.id}Fix`)}</p>

              <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
                {g.people.map((p) => (
                  <li key={p.employmentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    {/* Straight to the record. The entire deliverable of this page is getting somebody
                        from "14 people" to the field they have to fill in, in one click. */}
                    <Link
                      href={`/admin/personnel/${p.employmentId}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {p.name}
                    </Link>
                    {p.employeeCode && <EmployeeCode code={p.employeeCode} />}
                    <span className="ml-auto text-xs text-muted-foreground">{p.company}</span>
                  </li>
                ))}
              </ul>

              {g.count > g.people.length && (
                // The cap is stated rather than silent: a list that shows 25 of 200 without saying so
                // reads as "there are 25", which is the wrong number to plan an afternoon around.
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('moreNotShown', { shown: PEOPLE_PER_GAP, total: g.count })}
                </p>
              )}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
