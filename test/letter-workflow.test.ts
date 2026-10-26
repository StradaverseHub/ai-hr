import {describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {validateLetterPolicy,letterReference,letterStageDecision,assertLetterAcknowledgement,type LetterPolicy,type LetterWorkflowHead} from '../lib/letter-workflow';
const creator=randomUUID(),officer=randomUUID(),manager=randomUUID(),signatory=randomUUID();
const policy:LetterPolicy={version:1,stages:[{key:'officer',label:'HR Officer',userIds:[officer],allowDelegation:true},{key:'manager',label:'HR Manager',userIds:[manager],allowDelegation:true},{key:'signatory',label:'Authorised Signatory',userIds:[signatory],allowDelegation:false}],signatoryUserId:signatory,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'acknowledge',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:manager,portalNotifications:true,emailNotifications:false};
const head:LetterWorkflowHead={state:'submitted',revisionId:randomUUID(),lockVersion:1,stageIndex:0,createdBy:creator};
const input=(actorId:string,changes:Record<string,unknown>={})=>({actorId,expectedRevisionId:head.revisionId,expectedLockVersion:1,decision:{action:'approve' as const,comment:'',confirmSignature:false},...changes});
describe('configured letter approval and exact-artifact acknowledgement',()=>{
 it('validates a configured ordered chain and requires an individual final signatory',()=>{
  expect(validateLetterPolicy(policy)).toEqual(policy);expect(()=>validateLetterPolicy({...policy,stages:[...policy.stages.slice(0,2),{...policy.stages[2],allowDelegation:true}]})).toThrow('signatoryStage');expect(()=>validateLetterPolicy({...policy,signingMode:'stamp'})).toThrow('signatureAsset');
 });
 it('advances only the current stage and explicitly signs the final revision',()=>{
  expect(letterStageDecision(head,policy,input(officer))).toEqual({state:'submitted',stageIndex:1,final:false});expect(()=>letterStageDecision(head,policy,input(manager))).toThrow('permission');
  const final={...head,stageIndex:2};expect(()=>letterStageDecision(final,policy,input(signatory))).toThrow('signatureRequired');expect(letterStageDecision(final,policy,input(signatory,{decision:{action:'approve',comment:'Reviewed',confirmSignature:true}}))).toEqual({state:'approved',stageIndex:2,final:true});
 });
 it('refuses self approval, stale content and replay after a decision',()=>{
  expect(()=>letterStageDecision({...head,createdBy:officer},policy,input(officer))).toThrow('selfApproval');expect(()=>letterStageDecision(head,policy,input(officer,{expectedRevisionId:randomUUID()}))).toThrow('stale');expect(()=>letterStageDecision({...head,state:'approved'},policy,input(officer))).toThrow('state');
 });
 it('records return/reject reasons and keeps delegation from bypassing separation or final signing',()=>{
  expect(()=>letterStageDecision(head,policy,input(officer,{decision:{action:'return',comment:' ',confirmSignature:false}}))).toThrow('reasonRequired');expect(letterStageDecision(head,policy,input(officer,{decision:{action:'return',comment:'Correct the effective date',confirmSignature:false}}))).toMatchObject({state:'returned'});
  expect(letterStageDecision(head,policy,input(manager,{delegatedUserId:manager}))).toMatchObject({stageIndex:1});expect(()=>letterStageDecision(head,policy,input(creator,{delegatedUserId:creator}))).toThrow('selfApproval');expect(()=>letterStageDecision({...head,stageIndex:2},policy,input(manager,{delegatedUserId:manager}))).toThrow('permission');
 });
 it('allocates a formatted reference without truncating a longer canonical sequence',()=>{
  expect(letterReference(policy.referenceFormat,{year:'2026',companyCode:'000AC',sequence:'17'})).toBe('HR/2026/000017');expect(letterReference('HR/{COMPANY}/{SEQ:4}',{year:'2026',companyCode:'000AC',sequence:'123456'})).toBe('HR/000AC/123456');expect(()=>validateLetterPolicy({...policy,referenceFormat:'HR/{SQL:salary}'})).toThrow('referenceFormat');
 });
 it('binds employee acknowledgement/signature to exact current issued bytes',()=>{
  const hash='a'.repeat(64);expect(()=>assertLetterAcknowledgement({state:'issued',mode:'acknowledge',action:'acknowledge',artifactHash:hash,expectedArtifactHash:hash})).not.toThrow();expect(()=>assertLetterAcknowledgement({state:'void',mode:'acknowledge',action:'acknowledge',artifactHash:hash,expectedArtifactHash:hash})).toThrow('state');expect(()=>assertLetterAcknowledgement({state:'issued',mode:'signature',action:'signature',artifactHash:hash,expectedArtifactHash:'b'.repeat(64)})).toThrow('stale');expect(()=>assertLetterAcknowledgement({state:'issued',mode:'signature',action:'acknowledge',artifactHash:hash,expectedArtifactHash:hash})).toThrow('state');
 });
});
