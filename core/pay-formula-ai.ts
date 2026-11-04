import type { SessionContext, Tx } from '../db/client';
import { withTenant } from '../db/client';
import { assertAiPrincipalTx } from './ai-principal';
import { resolveActiveAiConfig } from './ai-config';
import { preparePrivateAiTask, withAiAdmissionCheck } from './ai-governance';
import { generateDraft } from '../lib/ai';
import { draftInputDigest } from '../lib/ai/draft-input';
import { assertPayFormulaDraftAuthorTx, validatePayFormulaDraft } from '../packs/payroll/service';
import { adjudicatePayFormulaDraft, payFormulaSuggestionSource, PAY_FORMULA_DRAFT_CONTRACT, payFormulaDraftRequest } from '../lib/pay-formula-ai';

export async function draftPayFormula(ctx: SessionContext, input: unknown) {
  const request = Object.freeze(payFormulaDraftRequest.parse(input));
  ctx = {...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({...grant}))};
  const author = async (tx: Tx, current = ctx) => {
    await assertAiPrincipalTx(tx, current);
    await assertPayFormulaDraftAuthorTx(tx, current);
  };
  const configuration = await withTenant(ctx, async tx => {
    await author(tx);
    return resolveActiveAiConfig(tx, ctx, 'pay_rule_draft');
  });
  if (!configuration) throw new Error('not_configured');
  let expected: string | undefined;
  const bound = withAiAdmissionCheck(configuration, 'pay_rule_draft', async (tx, call) => {
    await author(tx);
    if (call.operation !== 'draft' || call.inputDigest !== expected) throw new Error('source_changed');
  });
  const task = await preparePrivateAiTask(bound, PAY_FORMULA_DRAFT_CONTRACT, async (tx, current) => {
    await author(tx, current);
    return request;
  });
  try {
    if (task.operation !== 'draft') throw new Error('invalid_output');
    expected = draftInputDigest(task.args);
    const result = adjudicatePayFormulaDraft(await generateDraft(task.configuration, task.args));
    // No employee reads, payroll writes, formula save, activation or link operation.
    if (result.source) await validatePayFormulaDraft(ctx, result.unresolved ? payFormulaSuggestionSource(result.source).surrogate : result.source);
    else await withTenant(ctx, tx => author(tx));
    return result;
  } finally { task.dispose(); }
}
