/** Candidate authenticated human browser binding; no model executor or posted session/identity. */
import 'server-only';
import {withTenant,type SessionContext} from '../../db/client';
import {appOrigin} from '../../lib/real-auth';
import {createModuleActionBrowserHandler} from '../../lib/assistant-actions/module-action-http';
import {authenticateOwnLeaveBrowserSession} from './own-leave-server';
import {resolveOwnNotificationServerIdentity} from './own-notification-preferences-source';
import {prepareModuleActionReview,confirmModuleActionReview,reopenModuleActionReview,discardModuleActionReview,listModuleActionReviews} from './module-action-review-store';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {resolveEntitlementsTx,assertModuleEnabled} from '../entitlements';
import {readOwnNotificationEmailChoiceSubjectsTx} from '../notification-email';
/** Minimal source choices only after fresh authority; this read does not prepare or execute effects. */
export async function readNotificationModuleActionChoices(supplied:SessionContext):Promise<{kind:'choices';employments:{employmentId:string;employeeCode:string;companyName:string}[]}|{kind:'unavailable'}>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
  await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'notifications');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');
  const employments=await readOwnNotificationEmailChoiceSubjectsTx(tx,fresh);if(employments.length>16)throw Error();return{kind:'choices',employments};
 });}catch{return{kind:'unavailable'};}
}
/** Resolve verified identity outside EACH effect/reopen transaction, never from a packet, cached
 * tenant config or encrypted body. Listing/retirement requires no provider-identity admission. */
export async function handleConfiguredModuleActionBrowserCommand(request:Request):Promise<Response>{
 let publicOrigin:string|undefined;try{publicOrigin=appOrigin();}catch{publicOrigin=undefined;}
 return createModuleActionBrowserHandler({authenticate:authenticateOwnLeaveBrowserSession,
  list:session=>listModuleActionReviews(session.ctx),
  prepare:async(session,input)=>prepareModuleActionReview(session.ctx,input,await resolveOwnNotificationServerIdentity()),
  reopen:async(session,id)=>reopenModuleActionReview(session.ctx,id,await resolveOwnNotificationServerIdentity()),
  confirm:async(session,input)=>confirmModuleActionReview(session.ctx,input,await resolveOwnNotificationServerIdentity()),
  discard:(session,input)=>discardModuleActionReview(session.ctx,input),
 },{publicOrigin})(request);
}
