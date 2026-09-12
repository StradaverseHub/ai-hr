import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { Card, SectionHeader } from '@/components/ui';
import type { SessionContext } from '@/db/client';
import { listEmploymentsWithoutEntitlementTable } from '@/packs/leave/service';

/**
 * 9e2a89e9 (r269) — EVERY EMPLOYEE NO ENTITLEMENT TABLE REACHES, in one list.
 *
 * The reporter asked to be told when a grade change lands on nobody's table. The engine's refusal to
 * invent days is already right and already silent ("NO OPINION IS NOT ZERO", core/leave.ts): the employee
 * is skipped, nothing is written, and nobody finds out until year end. This is the telling.
 *
 * ⚠️ IT IS ONE CARD ON AN EXISTING SCREEN, NOT A NEW ROUTE, and that is a deliberate builder decision.
 * The plan promises "one list an administrator can open"; this is the screen where entitlement tables and
 * benefit schemes are configured, so it is where the answer belongs and where the next action already is.
 * A new guarded page would have needed a `SCREENS` column, a menu entry and an exact-set nav guard change
 * for a list whose whole content is about the configuration already on this page.
 *
 * ⚠️ AND IT MOUNTS ONLY HERE — never inside `EntitlementTablesBlock`, which the Entitlements screen
 * composes once per leave type (24 panels). The reader sweeps every active employment; running it per
 * panel would be twenty-four sweeps for one screen.
 *
 * ⚠️ THE COUNT THE REPORTER NEEDS MOST IS NOT AN ENGINE FACT. 47 of their 74 active employees have no job
 * grade recorded at all, so a grade-matched scheme can reach at most the other 27. No configuration
 * change fixes that, which is why the card says it in its own line rather than leaving an administrator to
 * infer it from a column of blanks.
 *
 * SERVER COMPONENT. One read, no client island, no action — it is a list and two links.
 */
export async function UncoveredEmployeesCard({ s, asOf }: { s: SessionContext; asOf: string }) {
  const t = await getTranslations('admin.entitlementTemplates');
  const { rows, total, withoutJobGrade, activeTotal } = await listEmploymentsWithoutEntitlementTable(s, { asOf });

  return (
    <Card>
      <SectionHeader title={t('uncoveredTitle')} count={total} />
      <div className="space-y-2 px-4 pb-3 pt-3 text-xs text-muted-foreground">
        <p>{t('uncoveredHelp')}</p>
        {/* Said whether or not anybody is listed: "nobody is unreached" and "nobody has a job grade to
            match on" are both worth knowing, and the second is the larger half of the reporter's problem. */}
        {withoutJobGrade > 0 ? (
          <p className="font-medium text-amber-700 dark:text-amber-500">
            {t('uncoveredNoGrade', { count: withoutJobGrade, total: activeTotal })}
          </p>
        ) : null}
      </div>
      {total === 0 ? (
        <div className="px-4 pb-4 text-sm text-muted-foreground">{t('uncoveredNone')}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t('uncoveredColEmployee')}</th>
                <th className="px-3 py-2">{t('uncoveredColGrade')}</th>
                <th className="px-3 py-2">{t('uncoveredColTypes')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employmentId} className="border-t align-top">
                  <td className="px-3 py-2">
                    <Link href={`/admin/personnel/${r.employmentId}?tab=leave`} className="underline">
                      {r.employeeName}
                    </Link>
                    {r.employeeCode ? (
                      <span className="ml-2 text-xs text-muted-foreground">{r.employeeCode}</span>
                    ) : null}
                  </td>
                  {/* An em dash is the honest rendering of "no job grade recorded": it asserts nothing,
                      where a blank cell reads as a loading failure. */}
                  <td className="px-3 py-2 text-xs">
                    {r.gradeName ?? <span className="text-amber-700 dark:text-amber-500">{t('uncoveredNoGradeCell')}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.leaveTypeNames.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* The cap is applied after counting, so this line states a fact rather than implying the list
              is complete. */}
          {total > rows.length ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              {t('uncoveredMore', { shown: rows.length, total })}
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
