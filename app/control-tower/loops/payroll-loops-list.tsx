import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import Link from '@/components/intent-link';
import { Card } from '@/components/ui';
import { cn } from '@/lib/utils';
import { AUDIT_LOOP_HREF } from '@/components/payroll-audit/audit-loop-column';
import type { PayrollCycleOverview } from '@/core/loops/payroll-cycle-views';
import { ATTENTION, DONE, payrollLoopStates, pill, type PayrollLoopStates } from './payroll-cycle/loop-states';

/** AI Centre › Operations › Loops: the three payroll loops in order (owner, 4 Nov 2026: the Audit loop was reachable only
 * from the Payroll cycle page's third column). Each row is the loop's own page and its status for this month, the same
 * status the Payroll cycle page shows (./payroll-cycle/loop-states.ts), from the same read (payrollCycleOverview, under the
 * viewer's row-level security and limited to the companies they administer). Nothing here reads or computes pay.
 *
 * The status streams: the names and links paint with the page, and each status follows when the read returns, so the six
 * loops' table above is never kept waiting for it. The read starts with the page's own reads (the page passes it in). A
 * failed read shows the names and links without a status. Guarded by the page's requireAdmin. AI Centre, never Noveri. */
export const PAYROLL_LOOP_HREFS = Object.freeze({
  pre: '/control-tower/loops/payroll-cycle',
  salary: '/control-tower/loops/payroll-cycle/salary',
  audit: AUDIT_LOOP_HREF,
});

// Async, like the sections it holds, so the server renders it with the page (and a test's server-tree resolver does too).
export async function PayrollLoopsList({ overview }: { overview: Promise<PayrollCycleOverview | null> }) {
  return (
    <Suspense fallback={<PayrollLoopsRows states={null} />}>
      <PayrollLoopsStatus overview={overview} />
    </Suspense>
  );
}

async function PayrollLoopsStatus({ overview }: { overview: Promise<PayrollCycleOverview | null> }) {
  const view = await overview;
  return <PayrollLoopsRows states={view && view.companies.length > 0 ? payrollLoopStates(view) : null} />;
}

const LINK = 'inline-flex min-h-9 items-center font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11';

async function PayrollLoopsRows({ states }: { states: PayrollLoopStates | null }) {
  const [t, ta] = await Promise.all([getTranslations('aiCentre.payrollCycle'), getTranslations('payrollAudit.column')]);
  const pre = states?.pre ?? null, salary = states?.salary ?? null, audit = states?.audit ?? null;
  const rows = [
    { key: 'pre', title: t('pre.title'), href: PAYROLL_LOOP_HREFS.pre, state: pre,
      text: pre === 'open' ? (states!.daysToCutOff >= 0 ? t('pre.state.open', { count: states!.daysToCutOff }) : t('pre.state.openPast')) : pre ? t(`pre.state.${pre}`) : null,
      tone: pre === 'done' ? DONE : pre === 'open' || pre === 'missed' ? ATTENTION : undefined },
    { key: 'salary', title: t('salary.title'), href: PAYROLL_LOOP_HREFS.salary, state: salary, text: salary ? t(`salary.state.${salary}`) : null,
      tone: salary === 'done' ? DONE : salary === 'attention' ? ATTENTION : undefined },
    { key: 'audit', title: t('audit.title'), href: PAYROLL_LOOP_HREFS.audit, state: audit, text: audit === 'done' ? ta('done') : audit ? ta('badge') : null,
      tone: audit === 'done' ? DONE : undefined },
  ] as const;
  return (
    <section aria-labelledby="loops-payroll-heading" data-payroll-loops-list={states ? 'status' : 'names'} className="space-y-2">
      <h2 id="loops-payroll-heading" className="text-sm font-semibold">{t('loopsLabel')}</h2>
      <Card className="overflow-hidden">
        <ol className="m-0 list-none divide-y divide-border p-0">
          {rows.map(row => (
            <li key={row.key} data-payroll-loop={row.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm">
              <Link href={row.href} className={LINK}>{row.title}</Link>
              {row.state && row.text && <span data-loop-state={row.state} className={cn(pill, row.tone)}>{row.text}</span>}
            </li>
          ))}
        </ol>
      </Card>
    </section>
  );
}
