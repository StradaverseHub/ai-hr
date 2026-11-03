import {describe,expect,it} from 'vitest';
import {pendingSigningSteps,recordSigningAction,signingComplete,validateSigningRoute,type SigningDocument,type SigningGuardrails} from '../lib/document-signing-model';

const guardrails:SigningGuardrails={requiredRoles:['lm','employee'],independentApprovalFromRole:'lm'};
const document:SigningDocument={
 tenantId:'fictional-tenant',companyId:'fictional-company',subjectId:'fictional-part',subjectType:'probation',
 contentRevision:1,contentHash:'a'.repeat(64),actions:[],
 route:{version:1,steps:[
  {id:'lm',role:'lm',kind:'sign',stage:0,required:true,holderId:'manager',holderPersonId:'manager-person'},
  {id:'employee',role:'employee',kind:'acknowledge',stage:1,required:true,holderId:'staff',holderPersonId:'staff-person'},
  {id:'hod',role:'hod',kind:'approve',stage:2,required:true,holderId:'approver',holderPersonId:'approver-person',coveredStepIds:['pbp']},
  {id:'pbp',role:'pbp',kind:'approve',stage:3,required:true,holderId:'approver',holderPersonId:'approver-person',coveredByStepId:'hod'},
 ]},
};
function sign(current:SigningDocument,stepId:string){
 const step=current.route.steps.find(item=>item.id===stepId)!;
 return recordSigningAction(current,guardrails,{id:'action-'+stepId,actorId:step.holderId!,actorPersonId:step.holderPersonId!,actorName:'Fictional signer',stepId,revision:1,hash:current.contentHash,action:'signed',method:'typed',value:'Fictional signer',consent:true,at:'2026-11-03T00:00:00.000Z'});
}
describe('content-bound approval role coverage',()=>{
 it('records one actual signature for the adjacent approval roles without bypassing acknowledgement',()=>{
  let current=sign(document,'lm');
  expect(()=>sign(current,'hod')).toThrow();
  current=sign(current,'employee');
  expect(pendingSigningSteps(current).map(step=>step.id)).toEqual(['hod']);
  expect(()=>sign(current,'pbp')).toThrow();
  current=sign(current,'hod');
  expect(current.actions).toHaveLength(3);
  expect(current.actions[2]).toMatchObject({role:'hod',actorPersonId:'approver-person',coveredStepIds:['pbp']});
  expect(signingComplete(current,guardrails)).toBe(true);
 });
 it('rejects approval coverage across an intervening required actor',()=>{
  const route=structuredClone(document.route);
  route.steps.find(step=>step.id==='pbp')!.stage=4;
  route.steps.push({id:'required',role:'gbs',kind:'approve',stage:3,required:true,holderId:'gbs',holderPersonId:'gbs-person'});
  expect(()=>validateSigningRoute(route,guardrails)).toThrow('adjacent approval');
 });
});
