import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listReimbursementsDue } from '@/core/claims';
import { Button, Card, EmployeeName, ErrorBanner, PageHeader, SectionHeader, inputCls, pageWideCls } from '@/components/ui';
import { ClaimsTabs } from '@/components/claims-tabs';
import { markReimbursementsPaidAction } from './actions';

/** Approved NON-taxable claims awaiting an off-cycle reimbursement: review, export a bank-upload CSV,
 *  then mark them paid once the transfer is done. (Taxable claims are paid through payroll instead.)
 *
 *  e7eb5d83 rev 6 — FULL WIDTH, with the rest of the claim configuration module. This is the widest table
 *  of the four (employee, type, incurred, bank, amount) and it was the narrowest page at `max-w-4xl`, so
 *  bank name and account number were the pair that ran out of room. The table keeps its own
 *  `overflow-x-auto`: full width is not infinite width. */
export default async function ReimbursementsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.reimbursements');
  const { error } = await searchParams;
  const due = await listReimbursementsDue(s);

  const rm = (n: number) => `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;
  const total = due.reduce((sum, r) => sum + Math.round(r.amount * 100), 0) / 100;
  const missingBank = due.filter((r) => !r.bankName || !r.bankAccountNo).length;

  return (
    <div className={pageWideCls}>
      <PageHeader
        back={{ href: '/admin/claims', label: t('back') }}
        title={t('title')}
        description={t('subtitle')}
        actions={
          due.length > 0 ? (
            <a
              href="/admin/claims/reimbursements/export"
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              title={t('exportTitle')}
            >
              ⬇ {t('export')}
            </a>
          ) : undefined
        }
      />
      <ClaimsTabs active="reimbursements" />
      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        <SectionHeader title={t('dueTitle')} count={due.length} />
        {due.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <form action={markReimbursementsPaidAction}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="w-10 px-4 py-2" />
                    <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                    <th className="px-4 py-2 font-medium">{t('colType')}</th>
                    <th className="px-4 py-2 font-medium">{t('colIncurred')}</th>
                    <th className="px-4 py-2 font-medium">{t('colBank')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('colAmount')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {due.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5">
                        <input type="checkbox" name="claimId" value={r.id} defaultChecked className="size-4" />
                      </td>
                      <td className="px-4 py-2.5 font-medium">
                        {/* Employee ID left-of-name (feedback 38668d9b) */}
                        <EmployeeName code={r.employeeCode} name={r.claimant} />
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{r.typeName}</td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{r.incurredOn}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {r.bankName && r.bankAccountNo ? (
                          <span className="tabular-nums">
                            {r.bankName} · {r.bankAccountNo}
                          </span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400">{t('noBank')}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-muted/30">
                    <td colSpan={5} className="px-4 py-2.5 text-right text-xs uppercase tracking-wide text-muted-foreground">
                      {t('total')}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{rm(total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                {t('payoutRefLabel')}
                <input name="payoutRef" placeholder={t('payoutRefPlaceholder')} className={`${inputCls} w-56`} />
              </label>
              <Button type="submit" size="sm">
                {t('markPaid')}
              </Button>
            </div>
          </form>
        )}
      </Card>

      {missingBank > 0 && (
        <p className="px-1 text-xs text-amber-600 dark:text-amber-400">{t('missingBankWarning', { count: missingBank })}</p>
      )}
      <p className="px-1 text-xs text-muted-foreground">{t('footnote')}</p>
    </div>
  );
}
