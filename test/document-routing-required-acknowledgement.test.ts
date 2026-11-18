import {describe,expect,it} from 'vitest';
import {documentRoutingProblems,documentRoutingSignatureProblems,resolveDocumentRouting,type DocumentRouting} from '../lib/document-signing-routing';
import {documentRoutingSchema} from '../lib/document-signing-routing-schema';
import {currentRoundActions,pendingSigningSteps,recordSigningAction,signingComplete,type SigningDocument} from '../lib/document-signing-model';
const refs={routingExists:()=>true,groupExists:()=>true,personExists:()=>true};
const routing:DocumentRouting=[{id:'optional-review',order:1,action:'review',who:{kind:'employee'},owner:false,required:false},{id:'ack',order:2,action:'acknowledge',who:{kind:'employee'},owner:false,required:true}];
function document():SigningDocument{
 const resolved=resolveDocumentRouting(routing,{employeeUserId:'employee',directSuperiorUserId:null,facts:{},routing:()=>null,groupMembers:()=>null,choose:people=>people[0]??null,fallback:null,describe:()=>''});
 return{tenantId:'tenant',companyId:'company',subjectId:'subject',subjectType:'probation',contentRevision:1,contentHash:'a'.repeat(64),route:resolved.route,actions:[],routing:{templateId:'template',templateVersion:1,caseOwnerId:'hr'}};
}
describe('required signing and explicit acknowledgement',()=>{
 it('preserves absent required flags and accepts explicit acknowledgement in the same routing schema',()=>{
  expect(documentRoutingSchema.parse(routing)).toEqual(routing);
  expect(documentRoutingProblems(routing,refs)).toEqual([]);
  expect(documentRoutingSignatureProblems(routing,[{id:'signature',type:'signature',role:'step:ack'}])).toEqual([]);
  expect(documentRoutingSignatureProblems(routing,[])).toHaveLength(1);
  const old=[{id:'old',order:1,action:'sign' as const,who:{kind:'employee' as const},owner:false}];
  expect(resolveDocumentRouting(old,{employeeUserId:'employee',directSuperiorUserId:null,facts:{},routing:()=>null,groupMembers:()=>null,choose:()=>null,fallback:null,describe:()=>''}).route.steps[0].required).toBe(true);
 });
 it('lets optional work act without blocking the next required step and requires an actual acknowledged signature',()=>{
  const before=document();
  expect(pendingSigningSteps(before).map(step=>step.id)).toEqual(['optional-review','ack']);
  const after=recordSigningAction(before,{requiredRoles:[]},{id:'action',actorId:'employee',actorPersonId:'person',actorName:'Sample Employee',stepId:'ack',revision:1,hash:before.contentHash,action:'signed',method:'typed',value:'Sample Employee',consent:true,at:'2026-11-18T02:00:00Z'});
  expect(signingComplete(after,{requiredRoles:[]})).toBe(true);
  expect(pendingSigningSteps(after)).toEqual([]);
  expect(after.actions[0]).toMatchObject({role:'employee',stepId:'ack',action:'signed'});
 });
 it('does not silently convert existing non-routed optional subject steps into task grants',()=>{
  const before={...document(),routing:undefined};
  expect(pendingSigningSteps(before).map(step=>step.id)).toEqual(['ack']);
  expect(documentRoutingProblems(routing.map(step=>({...step,required:false})),refs)).toContain('At least one step must be a Sign step, or nobody signs the document.');
 });
});

it('allows a completed frozen route holder to send back and removes signatures from the current round immediately',()=>{
 let before=document();before.route.steps=[{id:'review',role:'reviewer',kind:'review',stage:1,holderId:'reviewer',required:true},{id:'sign',role:'signer',kind:'sign',stage:2,holderId:'signer',required:true},{id:'employee',role:'employee',kind:'acknowledge',stage:3,holderId:'employee',required:true}];
 const act=(doc:SigningDocument,stepId:string,actor:string,action:'reviewed'|'signed'|'returned')=>recordSigningAction(doc,{requiredRoles:[]},{id:stepId+'-'+action,actorId:actor,actorPersonId:actor+'-person',actorName:actor,stepId,revision:1,hash:doc.contentHash,action,comment:action==='returned'?'Correct the wording':'',...(action==='signed'?{method:'typed' as const,value:actor,consent:true}:{}),at:'2026-11-18T02:00:00Z'});
 before=act(before,'review','reviewer','reviewed');before=act(before,'sign','signer','signed');
 const returned=act(before,'review','reviewer','returned');
 expect(returned.actions).toHaveLength(3);
 expect(pendingSigningSteps(returned)).toEqual([]);
 expect(signingComplete(returned,{requiredRoles:[]})).toBe(false);
 // Earlier signatures remain in history, but cannot fulfil or print in this signing round.
 expect(currentRoundActions(returned).map(action=>action.action)).toEqual(['returned']);
 expect(()=>act(returned,'employee','employee','signed')).toThrow();
 expect(()=>act(before,'review','outsider','returned')).toThrow();
});
