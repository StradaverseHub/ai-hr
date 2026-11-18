import {describe,expect,it} from 'vitest';
import {
 canEditSigningContent,currentRoundActions,pendingSigningSteps,recordSigningAction,resendSigningDocument,
 signingContentLocked,signingDocumentOwner,signingSendBack,type SigningDocument,
} from '../lib/document-signing-model';

const hash='a'.repeat(64),rules={requiredRoles:[] as string[]},at='2026-11-19T03:00:00Z';
function document():SigningDocument{return{
 tenantId:'tenant',companyId:'company',subjectId:'resignation',subjectType:'resignation',contentRevision:2,contentHash:hash,
 routing:{templateId:'template',templateVersion:1,caseOwnerId:'case-owner'},
 route:{version:1,steps:[
  {id:'review',role:'gbs',kind:'review',stage:0,holderId:'owner',holderPersonId:'person-owner',required:true,owner:true},
  {id:'optional',role:'observer',kind:'sign',stage:0,holderId:'observer',holderPersonId:'person-observer',required:false},
  {id:'bp',role:'bp',kind:'sign',stage:1,holderId:'bp',holderPersonId:'person-bp',required:true},
  {id:'employee',role:'employee',kind:'sign',stage:2,holderId:'employee',holderPersonId:'person-employee',required:true},
 ]},actions:[],
};}
function act(doc:SigningDocument,stepId:string,actorId:string,action:'reviewed'|'signed'|'returned'){
 return recordSigningAction(doc,rules,{id:stepId+'-'+action+'-'+doc.actions.length,actorId,actorPersonId:'person-'+actorId,actorName:actorId,
  stepId,revision:doc.contentRevision,hash:doc.contentHash,action,at,...(action==='returned'?{comment:'Correct the letter'}:{}),
  ...(action==='signed'?{method:'typed' as const,value:actorId,consent:true}:{})});
}
const signed=()=>act(act(document(),'review','owner','reviewed'),'bp','bp','signed');
const pending=(doc:SigningDocument)=>pendingSigningSteps(doc).map(step=>step.id);

describe('managed Resignation signing compatibility',()=>{
 it.each(['hash','revision'] as const)('ignores a returned receipt for another %s in both owner custody and the current round',kind=>{
  const doc=signed(),returned=act(doc,'employee','employee','returned').actions.at(-1)!;
  const stale={...returned,...(kind==='hash'?{contentHash:'b'.repeat(64)}:{contentRevision:doc.contentRevision-1})};
  const malformed={...doc,actions:[...doc.actions,stale]};
  expect(currentRoundActions(malformed)).toEqual(doc.actions);expect(signingSendBack(malformed)).toBeNull();
  expect(signingContentLocked(malformed)).toBe(true);expect(canEditSigningContent(malformed,'owner')).toBe(false);
  expect(pending(malformed)).toEqual(['employee']);
 });
 it.each(['hash','revision'] as const)('ignores an unrelated %s resend without losing valid current signatures',kind=>{
  const doc=signed(),returned=act(doc,'employee','employee','returned');
  const receipt=resendSigningDocument(returned,{id:'resend',actorId:'owner',actorPersonId:'person-owner',actorName:'owner',at}).actions.at(-1)!;
  const stale={...receipt,...(kind==='hash'?{contentHash:'b'.repeat(64)}:{contentRevision:doc.contentRevision-1})};
  const malformed={...doc,actions:[...doc.actions,stale]};
  expect(currentRoundActions(malformed)).toEqual(doc.actions);expect(signingContentLocked(malformed)).toBe(true);
  expect(pending(malformed)).toEqual(['employee']);
 });
 it('starts a fresh round after a matching resend and counts only its fresh signatures',()=>{
  const prior=signed(),returned=act(prior,'employee','employee','returned');
  expect(signingSendBack(returned)).toEqual(returned.actions.at(-1));expect(canEditSigningContent(returned,'owner')).toBe(true);
  const resent=resendSigningDocument(returned,{id:'resend-current',actorId:'owner',actorPersonId:'person-owner',actorName:'owner',at});
  expect(currentRoundActions(resent)).toEqual([]);expect(signingSendBack(resent)).toBeNull();expect(signingContentLocked(resent)).toBe(false);
  expect(pending(resent)).toEqual(['review']);expect(resent.actions.slice(0,prior.actions.length)).toEqual(prior.actions);
  const fresh=act(act(resent,'review','owner','reviewed'),'bp','bp','signed');
  expect(currentRoundActions(fresh)).toEqual(fresh.actions.slice(resent.actions.length));expect(signingContentLocked(fresh)).toBe(true);
  expect(pending(fresh)).toEqual(['employee']);
 });
 it('keeps optional routed steps out of managed required-step admission',()=>{
  const doc=document();expect(pending(doc)).toEqual(['review']);
  expect(()=>act(doc,'optional','observer','signed')).toThrow('assigned');
  expect(pending(act(doc,'review','owner','reviewed'))).toEqual(['bp']);
 });
 it('refuses a return from a future step even when template metadata is present',()=>{
  expect(()=>act(document(),'employee','employee','returned')).toThrow('assigned');
 });
 it.each([false,true])('does not replace a missing Review holder with case-owner custody (flagged=%s)',flagged=>{
  const doc=document();doc.route.steps[0]={...doc.route.steps[0],owner:flagged,holderId:null,holderPersonId:undefined};
  expect(signingDocumentOwner(doc)).toEqual({stepId:'review',userId:null});
  expect(canEditSigningContent(doc,'case-owner')).toBe(false);
 });
});


describe('native routed-document behavior remains separate',()=>{
 it.each(['probation','onboarding','offboarding','contract'])('retains optional steps and returned custody for %s',subjectType=>{
  const doc={...document(),subjectType};expect(pending(doc)).toEqual(['review','optional']);
  const returned=act(doc,'employee','employee','returned');expect(signingSendBack(returned)).toEqual(returned.actions.at(-1));
  const revised={...returned,contentRevision:returned.contentRevision+1,contentHash:'b'.repeat(64)};
  expect(signingSendBack(revised)).toEqual(returned.actions.at(-1));expect(pending(revised)).toEqual([]);
 });
 it.each(['probation','onboarding','offboarding','contract'])('preserves missing Review holder custody for %s',subjectType=>{
  const doc={...document(),subjectType};doc.route.steps[0]={...doc.route.steps[0],holderId:null,holderPersonId:undefined};
  expect(signingDocumentOwner(doc)).toEqual({stepId:'review',userId:subjectType==='contract'?null:'case-owner'});
 });
 it('retains Contract live-merge review receipts for the same revision',()=>{
  const initial=document(),doc={...initial,subjectType:'contract',routing:{...initial.routing!,liveMergeReviews:true}};
  const reviewed=act(doc,'review','owner','reviewed'),merged={...reviewed,contentHash:'b'.repeat(64)};
  expect(currentRoundActions(merged)).toEqual(reviewed.actions);expect(signingSendBack(merged)).toBeNull();
 });
});
