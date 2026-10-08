import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies, listEmployees } from '@/core/read';
import { resolveCardMatch } from '@/core/attendance-card';
import { Button, Card, ErrorBanner, PageHeader, inputCls } from '@/components/ui';
import { saveCardIdAction } from './actions';

/**
 * 44bc1c33 — ATTENDANCE › CARD ASSIGNMENT.
 *
 * WHAT THE GAP WAS. The clocking importer (`importAttendancePunches`, retired in r424 for
 * core/attendance-clocking-import.ts) matched a clocking device's own identifier against the
 * employee code and the IC, and reports anything else as unmatched rather than guessing. A company whose
 * terminal records its own card numbers therefore matched NOTHING, and had no way to fix it. This screen
 * owns the third key.
 *
 * ONE COLUMN, ONE OWNER. The card lives on `employment.card_id` (0474), so this screen and the Card ID
 * field on the employee's own record are two views of ONE value — the reporter's requirement 7 satisfied by
 * construction rather than by a sync rule. There is no `card_assignment` table.
 *
 * ⚠️ "CARD ID IS THE SAME AS EMPLOYEE ID" IS NOT A SETTING HERE, AND THE REASON IS WORTH READING. The
 * ticket asks for a switch that fills every Card ID in from the Employee ID. It would change nothing about
 * matching: the importer ALREADY matches on employee code, so a device that records employee numbers has
 * always imported with no card at all. A copy would only duplicate one fact and need a sync rule on every
 * code rename. So a NULL card is not an empty field to be filled — it is the normal state, and the
 * "Matched by" column says "Employee ID" for it in as many words.
 *
 * Read-only apart from the one form: the list is `listEmployees`, which carries `cardId` as a column of the
 * employment row it already selects (no extra join).
 */
export default async function CardAssignmentPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; company?: string; error?: string; saved?: string }>;
}) {
  const t = await getTranslations('attendance');
  const { s, scopeIds } = await scopedAdmin();
  const sp = await searchParams;

  const [companies, employees] = await Promise.all([listCompanies(s), listEmployees(s, scopeIds)]);
  const visibleCompanies = companies.filter((c) => scopeIds.includes(c.id));

  const q = sp.q?.trim().toLowerCase() || undefined;
  const companyFilter = sp.company || undefined;

  // Search covers the three things a person has in hand: the name, the Employee ID and the Card ID. A
  // terminal file gives you a number and no name, so searching BY CARD is the common case, not an extra.
  const rows = employees
    .filter((e) => !e.terminatedOn)
    .filter((e) => (companyFilter ? e.companyId === companyFilter : true))
    .filter((e) =>
      q
        ? [e.name, e.employeeCode ?? '', e.cardId ?? ''].some((v) => v.toLowerCase().includes(q))
        : true,
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const th = 'px-3 py-2 font-medium';

  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <PageHeader title={t('cardTitle')} description={t('cardDescription')} />

      {sp.error && <ErrorBanner message={sp.error} />}

      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('cardSearch')}
          <input name="q" defaultValue={sp.q ?? ''} className={`${inputCls} w-80`} placeholder={t('cardSearch')} />
        </label>
        {visibleCompanies.length > 1 && (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            &nbsp;
            <select name="company" defaultValue={companyFilter ?? ''} className={inputCls}>
              <option value="">—</option>
              {visibleCompanies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit">{t('cardSearch')}</Button>
      </form>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className={th}>{t('cardMatchedCode')}</th>
                <th className={th}>{t('colEmployeeName')}</th>
                <th className={th}>{t('cardColCardId')}</th>
                <th className={th}>{t('cardColMatchedBy')}</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noRecords')}
                  </td>
                </tr>
              )}
              {rows.map((e) => {
                const match = resolveCardMatch(e);
                return (
                  <tr key={e.employmentId}>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{e.employeeCode ?? '—'}</td>
                    <td className="px-3 py-2">{e.name}</td>
                    <td className="px-3 py-2">
                      <form action={saveCardIdAction} className="flex items-center gap-2">
                        <input type="hidden" name="employmentId" value={e.employmentId} />
                        <input type="hidden" name="q" value={sp.q ?? ''} />
                        <input type="hidden" name="company" value={companyFilter ?? ''} />
                        <input
                          name="cardId"
                          defaultValue={e.cardId ?? ''}
                          className={`${inputCls} w-40`}
                          // TEXT, never a number input: card numbers carry leading zeros, and a number
                          // field would quietly turn '007' into '7' — a different card, and therefore
                          // somebody else's attendance.
                          inputMode="text"
                          autoComplete="off"
                        />
                        <Button type="submit" variant="ghost">
                          {t('cardSave')}
                        </Button>
                      </form>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {match.by === 'card'
                        ? t('cardMatchedCard')
                        : match.by === 'employee_code'
                          ? t('cardMatchedCode')
                          : t('cardMatchedNone')}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {match.by === 'employee_code' ? t('cardNoneNote') : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
