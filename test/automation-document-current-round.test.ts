import {describe,expect,it} from 'vitest';
import {automationDocument} from '../lib/automation-document';
import {recordSigningAction,resendSigningDocument,type SigningDocument} from '../lib/document-signing-model';

const hash='a'.repeat(64),at='2026-11-19T02:00:00Z';
const rules={requiredRoles:[] as string[]};
function routed():SigningDocument{return{tenantId:'tenant',companyId:'company',subjectId:'case',subjectType:'probation',contentRevision:1,contentHash:hash,route:{version:1,steps:[{id:'hr',role:'hr',kind:'sign',stage:1,holderId:'hr-user',required:true,owner:true},{id:'employee',role:'employee',kind:'sign',stage:1,holderId:'employee-user',required:true}]},routing:{templateId:'template',templateVersion:1,caseOwnerId:'hr-user'},actions:[]};}
function act(document:SigningDocument,stepId:'hr'|'employee',action:'signed'|'returned'){
 return recordSigningAction(document,rules,{id:stepId+'-'+action+'-'+document.actions.length,stepId,actorId:stepId+'-user',actorPersonId:stepId+'-person',actorName:stepId,revision:document.contentRevision,hash:document.contentHash,action,at,...(action==='signed'?{method:'typed' as const,value:stepId,consent:true}:{comment:'Correct the document'})});
}
const project=(signing:SigningDocument)=>automationDocument({id:'document',name:'Letter',templateId:'template',templateVersion:1,blocks:[],fields:[],merge:{},createdAt:at,signing});
describe('shared document signature projections',()=>{
 it('clears previous-round main and per-step signatures on send-back, retaining their audit receipts',()=>{
  const signed=act(routed(),'hr','signed');
  expect(project(signed).hrSignature?.by.id).toBe('hr-user');
  const returned=act(signed,'employee','returned');
  expect(project(returned).hrSignature).toBeNull();
  expect(project(returned).stepSignatures).toEqual({});
  const resent=resendSigningDocument(returned,{id:'resend',actorId:'hr-user',actorPersonId:'hr-person',actorName:'hr',at});
  expect(project(resent).hrSignature).toBeNull();
  const signedAgain=act(resent,'hr','signed');
  expect(project(signedAgain).hrSignature?.by.id).toBe('hr-user');
  expect(project(signedAgain).employeeSignature).toBeNull();
  expect(signedAgain.actions.filter(action=>action.action==='signed')).toHaveLength(2);
 });
 it('preserves explicit content-visible receipt projections without deriving additional signing authority',()=>{
  const signed=act(routed(),'employee','signed'),receipt=signed.actions[0];
  const document=automationDocument({id:'document',name:'Letter',templateId:'template',templateVersion:1,blocks:[],fields:[],merge:{},createdAt:at,receipts:[receipt]});
  expect(document.employeeSignature?.by.id).toBe('employee-user');
  expect(document.stepSignatures?.employee?.by.id).toBe('employee-user');
  expect(document.hrSignature).toBeNull();
 });
});
