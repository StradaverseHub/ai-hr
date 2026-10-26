/** Candidate authenticated human browser binding; no model executor or posted session/identity. */
import 'server-only';
import {withTenant,type SessionContext} from '../../db/client';
import {appOrigin} from '../../lib/real-auth';
import {createModuleActionBrowserHandler} from '../../lib/assistant-actions/module-action-http';
import {authenticateOwnLeaveBrowserSession} from './own-leave-server';
import {resolveOwnNotificationServerIdentity} from './own-notification-preferences-source';
import {prepareModuleActionReview,confirmModuleActionReview,reopenModuleActionReview,discardModuleActionReview,listModuleActionReviews,prepareProfileModuleActionReview,confirmProfileModuleActionReview,reopenProfileModuleActionReview,discardProfileModuleActionReview,listProfileModuleActionReviews} from './module-action-review-store';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {resolveEntitlementsTx,assertModuleEnabled} from '../entitlements';
import {readOwnNotificationEmailChoiceSubjectsTx} from '../notification-email';
import {myOwnEmploymentSubjectsTx} from '../read';
import {readOwnProfileWorkspace} from '../profile-edit';
import {PERSONNEL_FIELDS} from '../../lib/personnel-field-registry';
/** Minimal source choices only after fresh authority; this read does not prepare or execute effects. */
export async function readNotificationModuleActionChoices(supplied:SessionContext):Promise<{kind:'choices';employments:{employmentId:string;employeeCode:string|null;companyName:string}[]}|{kind:'unavailable'}>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
  await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'notifications');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');
  const employments=await readOwnNotificationEmailChoiceSubjectsTx(tx,fresh);if(employments.length>16)throw Error();return{kind:'choices',employments};
 });}catch{return{kind:'unavailable'};}
}
/** Actual canonical ESS workspace in THIS guarded Tx; only supported text-field IDs/labels and
 * opaque baselines leave this owner. No current values, full Person/statutory/register rows or
 * editable-but-unsupported fields are serialized. Those remain explicit manual workflow. */
export async function readProfileModuleActionChoices(supplied:SessionContext){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
  await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'ess');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');
  const subjects=await myOwnEmploymentSubjectsTx(tx,fresh,{profileEdit:true});if(subjects.length>16)throw Error();
  const employments=[];
  for(const subject of subjects){const workspace=await readOwnProfileWorkspace(fresh,{employmentId:subject.employmentId},undefined,tx);
   if(workspace.employmentId!==subject.employmentId||workspace.personId!==fresh.personId)throw Error();
   const editable=new Set(workspace.editable),visible=new Set(workspace.visible);
   const permitted=PERSONNEL_FIELDS.filter(field=>editable.has(field.id)&&visible.has(field.id)&&field.ess.edit==='approval'&&field.ess.binding);
   const supported=permitted.filter(field=>field.type==='text'&&field.grain==='single'&&field.ess.binding?.owner==='person'&&!field.ess.masked&&!field.allowedValuesOwner);
   if(supported.length>32)throw Error();
   const fields=supported.map(field=>{const baseline=workspace.baselines[field.id];if(typeof baseline!=='string'||!/^sha256:[a-f0-9]{64}$/.test(baseline))throw Error();return {fieldId:field.id,baseline,type:'text' as const};});
   employments.push({employmentId:subject.employmentId,employeeCode:subject.employeeCode,companyName:subject.company,fields,manualPending:permitted.length!==supported.length||workspace.registers.length>0});
  }
  return {kind:'choices' as const,employments};
 });}catch{return {kind:'unavailable' as const};}
}
/** Resolve verified identity outside EACH effect/reopen transaction, never from a packet, cached
 * tenant config or encrypted body. Listing/retirement requires no provider-identity admission. */
export async function handleConfiguredModuleActionBrowserCommand(request:Request):Promise<Response>{
 let publicOrigin:string|undefined;try{publicOrigin=appOrigin();}catch{publicOrigin=undefined;}
 return createModuleActionBrowserHandler({authenticate:authenticateOwnLeaveBrowserSession,
  profile:{list:session=>listProfileModuleActionReviews(session.ctx),prepare:(session,input)=>prepareProfileModuleActionReview(session.ctx,input),reopen:(session,id)=>reopenProfileModuleActionReview(session.ctx,id),confirm:(session,input)=>confirmProfileModuleActionReview(session.ctx,input),discard:(session,input)=>discardProfileModuleActionReview(session.ctx,input)},
  list:session=>listModuleActionReviews(session.ctx),
  prepare:async(session,input)=>prepareModuleActionReview(session.ctx,input,await resolveOwnNotificationServerIdentity()),
  reopen:async(session,id)=>reopenModuleActionReview(session.ctx,id,await resolveOwnNotificationServerIdentity()),
  confirm:async(session,input)=>confirmModuleActionReview(session.ctx,input,await resolveOwnNotificationServerIdentity()),
  discard:(session,input)=>discardModuleActionReview(session.ctx,input),
 },{publicOrigin})(request);
}
