import 'server-only';

import { sql } from 'drizzle-orm';
import { assertModuleGate } from '@/core/module-gate';
import { withTenant, type SessionContext } from '@/db/client';
import { describePayFormula, type FormulaExplanationRow } from '@/lib/pay-formula-explain';
import { parsePayFormula } from '@/lib/pay-formula-language';
import { PayFormulaError } from '@/lib/pay-formula-model';

export type PayItemFormulaOption = {
  formulaId: string;
  description: string;
  dependencies: string[];
  explanation: FormulaExplanationRow[] | null;
};

/** Project the native formula catalogue for the Pay Item form. Only the translated explanation and
 * existing picker metadata cross the client boundary. The saved revision's source stays server-side. */
export async function readPayItemFormulaOptions(
  ctx: SessionContext,
  translate: Parameters<typeof describePayFormula>[1],
): Promise<PayItemFormulaOption[]> {
  assertModuleGate(ctx, 'payroll');
  assertModuleGate(ctx, 'typed_pay_components');

  return withTenant(ctx, async tx => {
    const [access] = await tx.execute<{ allowed: boolean }>(sql`select app.pay_formula_catalog_access() as allowed`);
    if (!access?.allowed) throw new PayFormulaError('Formula access is unavailable.');

    const options = await tx.execute<{
      formulaId: string;
      description: string;
      dependencies: string[];
      source: string;
    }>(sql`
      select saved.code as "formulaId", r.description, saved.dependencies, r.source
        from pay_formula f
        cross join lateral app.pay_formula_saved(f.formula_id) saved
        join pay_formula_revision r on r.id = saved.revision_id and r.tenant_id = f.tenant_id
        where f.tenant_id = ${ctx.tenantId}::uuid
        order by f.formula_id
    `);

    return options.map(({ source, ...option }) => {
      try {
        return { ...option, explanation: describePayFormula(parsePayFormula(source), translate) };
      } catch {
        // A retained revision can predate the current parser. Keep its selection visible.
        return { ...option, explanation: null };
      }
    });
  });
}
