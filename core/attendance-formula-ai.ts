import type {SessionContext,Tx} from '../db/client';
import {withTenant} from '../db/client';
import {resolveEntitlementsTx} from './entitlements';
import {assertModuleGate} from './module-gate';
import {assertAttendanceFormulaAuthorTx} from './attendance-formulas';
import {assertAiPrincipalTx} from './ai-principal';
import {withAiCentreFunction} from './ai-centre-control';
import {resolveActiveAiConfig} from './ai-config';
import {preparePrivateAiTask,withAiAdmissionCheck} from './ai-governance';
import {generateDraft} from '../lib/ai';
import {draftInputDigest} from '../lib/ai/draft-input';
import {ATTENDANCE_FORMULA_DRAFT_CONTRACT,attendanceFormulaDraftCompanyRequest,adjudicateAttendanceFormulaDraft} from '../lib/attendance-formula-ai';
/** Explicit author wording and public grammar only. No employee/test/result read or save/activate effect. */
export async function draftAttendanceFormula(ctx:SessionContext,input:unknown){
 ctx=structuredClone(ctx);const request=attendanceFormulaDraftCompanyRequest.parse(structuredClone(input));
 const author=async(tx:Tx,current=ctx)=>{await assertAiPrincipalTx(tx,current);const fresh={...current,entitlements:await resolveEntitlementsTx(tx,current.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};assertModuleGate(fresh,'attendance');await assertAttendanceFormulaAuthorTx(tx,current,request.companyId);};
 return withAiCentreFunction(ctx,'read:operation_attendance_formula_draft',async()=>{
  const configuration=await withTenant(ctx,async tx=>{await author(tx);return resolveActiveAiConfig(tx,ctx,'pay_rule_draft');});if(!configuration)throw Error('not_configured');
  let expected:string|undefined;const bound=withAiAdmissionCheck(configuration,'pay_rule_draft',async(tx,call)=>{await author(tx);if(call.operation!=='draft'||call.inputDigest!==expected)throw Error('source_changed');});
  const task=await preparePrivateAiTask(bound,ATTENDANCE_FORMULA_DRAFT_CONTRACT,async(tx,current)=>{await author(tx,current);return {requirement:request.requirement,disclosureAccepted:request.disclosureAccepted};});
  try{if(task.operation!=='draft')throw Error('invalid_output');expected=draftInputDigest(task.args);const proposal=adjudicateAttendanceFormulaDraft(await generateDraft(task.configuration,task.args));await withTenant(ctx,tx=>author(tx));return proposal;}finally{task.dispose();}
 });
}
