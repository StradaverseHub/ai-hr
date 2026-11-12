import {withAiCentreFunction} from './ai-centre-control';
import type { SessionContext, Tx } from '../db/client';
import { withTenant } from '../db/client';
import { assertAiPrincipalTx } from './ai-principal';
import { resolveActiveAiConfig } from './ai-config';
import { preparePrivateAiTask, withAiAdmissionCheck } from './ai-governance';
import { generateDraft, AiAllowanceError } from '../lib/ai';
import { AiPrivacyGateError } from '../lib/ai/provider-privacy-error';
import { AiAdmissionRefusal } from '../lib/ai/admission-refusal';
import { draftInputDigest } from '../lib/ai/draft-input';
import { assertPayFormulaDraftAuthorTx, validatePayFormulaDraft, payFormulaPermittedDraftFieldsTx } from '../packs/payroll/service';
import type { PayFormulaDraftFailureReason } from '../lib/pay-formula-draft-job';
import { adjudicatePayFormulaDraft, payFormulaSuggestionSource, PAY_FORMULA_DRAFT_CONTRACT, payFormulaDraftRequest } from '../lib/pay-formula-ai';

/** Provider budget of the background generator (core/pay-formula-ai-job.ts). The request path keeps the gateway's
 *  22 s cap; only this caller passes GenerateArgs.background, and the gateway bounds it at 120 s. */
export const PAY_FORMULA_BACKGROUND_TIMEOUT_MS=90_000;
export class PayFormulaDraftFailure extends Error{
 constructor(readonly reason:PayFormulaDraftFailureReason){super('pay_formula_draft_'+reason);this.name='PayFormulaDraftFailure';}
}
/** Maps any refusal of the draft path to one closed reason. Stage-specific reasons are raised inside the activity. */
export function payFormulaDraftFailureReason(error:unknown):PayFormulaDraftFailureReason{
 if(error instanceof PayFormulaDraftFailure)return error.reason;
 if(error instanceof AiAllowanceError)return error.reason;
 if(error instanceof AiPrivacyGateError)return 'review_required';
 if(error instanceof Error&&error.message==='not_configured')return 'unavailable';
 if(error instanceof Error&&(error.message==='source_changed'||error.message==='Formula access is unavailable.'))return 'access_changed';
 if(error instanceof AiAdmissionRefusal)return error.code==='source_check_failed'?'access_changed':'failed';
 return 'failed';
}

/** Request-path draft: the gateway's 22 s cap applies. */
export async function draftPayFormula(ctx:SessionContext,input:unknown):Promise<Awaited<ReturnType<typeof draftPayFormulaActivity>>>{
 return governedDraft(ctx,input);
}
async function governedDraft(...args:Parameters<typeof draftPayFormulaActivity>):Promise<Awaited<ReturnType<typeof draftPayFormulaActivity>>>{
 args=structuredClone(args);
 return withAiCentreFunction(args[0],'read:operation_pay_formula_draft',()=>draftPayFormulaActivity(...args));
}
/** The same governed draft with the background provider budget. Every refusal leaves as a PayFormulaDraftFailure.
 *  Never call this from a request path: it can wait on the model for up to timeoutMs. */
export async function draftPayFormulaInBackground(ctx:SessionContext,input:unknown,timeoutMs=PAY_FORMULA_BACKGROUND_TIMEOUT_MS){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>PAY_FORMULA_BACKGROUND_TIMEOUT_MS)throw new PayFormulaDraftFailure('failed');
 try{return await governedDraft(ctx,input,{timeoutMs});}
 catch(error){throw new PayFormulaDraftFailure(payFormulaDraftFailureReason(error));}
}
async function draftPayFormulaActivity(ctx: SessionContext, input: unknown, background?: {timeoutMs:number}) {
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
  let expected: string | undefined,permittedMetadata:string|undefined,permittedFields:Awaited<ReturnType<typeof payFormulaPermittedDraftFieldsTx>>|undefined;
  const bound = withAiAdmissionCheck(configuration, 'pay_rule_draft', async (tx, call) => {
    await author(tx);
    if (call.operation !== 'draft' || call.inputDigest !== expected || JSON.stringify(await payFormulaPermittedDraftFieldsTx(tx,ctx))!==permittedMetadata) throw new Error('source_changed');
  });
  const task = await preparePrivateAiTask(bound, PAY_FORMULA_DRAFT_CONTRACT, async (tx, current) => {
    await author(tx, current);
    permittedFields=await payFormulaPermittedDraftFieldsTx(tx,current);permittedMetadata=JSON.stringify(permittedFields);return {...request,permittedFields};
  });
  try {
    if (task.operation !== 'draft' || !permittedFields) throw new Error('invalid_output');
    expected = draftInputDigest(task.args);
    // Background only: a longer provider budget through the gateway's explicit option, and stage-specific reasons.
    const started = performance.now();
    let raw: string;
    try { raw = await generateDraft(task.configuration, background ? {...task.args, timeoutMs: background.timeoutMs, background: true} : task.args); }
    catch (error) {
      if (background && !(error instanceof AiAllowanceError) && !(error instanceof AiPrivacyGateError) && !(error instanceof AiAdmissionRefusal))
        throw new PayFormulaDraftFailure(performance.now() - started >= background.timeoutMs ? 'timeout' : 'provider_unavailable');
      throw error;
    }
    let result: ReturnType<typeof adjudicatePayFormulaDraft>;
    try { result = adjudicatePayFormulaDraft(raw,permittedFields); }
    catch (error) { if (background) throw new PayFormulaDraftFailure('invalid_draft'); throw error; }
    await withTenant(ctx,async tx=>{await author(tx);if(JSON.stringify(await payFormulaPermittedDraftFieldsTx(tx,ctx))!==permittedMetadata)throw new Error('source_changed');});
    // No employee reads, payroll writes, formula save, activation or link operation.
    if (result.source) {
      try { await validatePayFormulaDraft(ctx, result.unresolved ? payFormulaSuggestionSource(result.source).surrogate : result.source); }
      catch (error) { if (background && payFormulaDraftFailureReason(error) === 'failed') throw new PayFormulaDraftFailure('invalid_draft'); throw error; }
    }
    else await withTenant(ctx, tx => author(tx));
    return result;
  } finally { task.dispose(); }
}
