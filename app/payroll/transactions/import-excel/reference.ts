import { getTranslations } from 'next-intl/server';

import { listEmployees } from '@/core/read';
import { FIXED_TRANSACTION_CYCLES, listPayComponents } from '@/core/pay-components';
import { payRuleInputUnit, type PayRule } from '@/core/pay-rule';
import { TXN_KINDS } from '@/core/payroll-individual-txn';
import type { SessionContext } from '@/db/client';
import type { TxnTemplateReference } from '@/lib/import-template-xlsx';

/**
 * 5c65367d — the reference sheets' CONTENT, read on the server by whichever screen is mounting the
 * import buttons.
 *
 * WHY IT IS BUILT HERE AND NOT INSIDE THE TEMPLATE BUILDER. `lib/import-template-xlsx.ts` is
 * client-safe and must stay that way — it runs in the browser when Download Template is pressed, and a
 * `db/` import in it would drag the whole data layer into the bundle (and fail the RSC boundary). So the
 * screen reads the catalogues and passes plain data down, exactly as d8471481's employee template does.
 *
 * EVERY LIST COMES FROM THE SAME PLACE THE VALIDATOR RESOLVES AGAINST — `listEmployees` under the same
 * company scope, `listPayComponents` minus the archived ones, and the two code-level vocabularies. That
 * is what makes "a code on the sheet is a code that validates" true rather than aspirational; the
 * alternative is a second hand-maintained list that drifts the first time somebody adds a pay item.
 */
export async function buildTxnTemplateReference(
  s: SessionContext,
  scopeIds: string[],
): Promise<TxnTemplateReference> {
  const t = await getTranslations('payroll.txnImport');
  const tc = await getTranslations('payroll.transactions.individual');
  const [employees, components] = await Promise.all([listEmployees(s, scopeIds), listPayComponents(s)]);

  return {
    headings: {
      employees: t('sheetEmployees'),
      employeeId: t('colEmployeeId'),
      employeeName: t('colEmployeeName'),
      company: t('colCompany'),
      department: t('colDepartment'),
      payItems: t('sheetPayItems'),
      payItemCode: t('colPayItemCode'),
      payItemName: t('colPayItemName'),
      payItemKind: t('colPayItemKind'),
      payItemInput: t('colPayItemInput'),
      cycles: t('sheetCycles'),
      cycleCode: t('colCycleCode'),
      cycleLabel: t('colCycleLabel'),
      kinds: t('sheetKinds'),
      kindCode: t('colKindCode'),
      kindLabel: t('colKindLabel'),
      example: t('sheetExample'),
      note: t('sheetExampleNote'),
    },
    // Employees the ADMIN MAY ACT IN, not every employee on the tenant: company scope is an application
    // concern (RLS only isolates tenants), so a template that listed people outside the scope would be
    // handing out names the import would then refuse.
    employees: employees.map((e) => ({
      code: e.employeeCode ?? '',
      name: e.name,
      company: e.company,
      department: e.department ?? '',
    })),
    // ACTIVE items only — the request asks for "Payroll Item is active", and the validator refuses an
    // archived one, so listing it would be an invitation to a refusal.
    payItems: components
      .filter((c) => c.archivedAt == null)
      .map((c) => ({
        code: c.code,
        name: c.name,
        kind: c.kind,
        // WHICH BOX THE FILE HAS TO FILL IN, decided by the pay item's own rule through the SAME
        // resolver the entry form and the validator ask. Blank means "no quantity needed — key an
        // amount", which is what a fixed-rule or ruleless item wants.
        input: payRuleInputUnit((c.rule ?? null) as PayRule | null) ?? '',
      })),
    // The file's "Payroll cycle" column takes the run_type values, NOT a `payroll_cycle` name or code.
    // 4fffe638 — employment_pay_component now has a payroll_cycle_id, but the import fills it only under
    // the one-match rule (the employee's company has exactly one active cycle of that run type; see
    // core/payroll-txn-import.ts loadOneMatchCycles). Listing the cycle catalogue here would still be
    // listing values the import cannot accept.
    cycles: FIXED_TRANSACTION_CYCLES.map((c) => ({ code: c, label: tc(`cycle.${c}` as never) })),
    kinds: TXN_KINDS.map((k) => ({ code: k, label: tc(`kindLabel.${k}` as never) })),
  };
}
