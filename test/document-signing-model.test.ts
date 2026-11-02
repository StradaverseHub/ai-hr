import {describe,expect,it} from 'vitest';
import {pendingSigningSteps,recordSigningAction,replacePendingSigner,reviseSigningDocument,signingComplete,validateSigningRoute,type SigningDocument} from '../lib/document-signing-model';
const hash='a'.repeat(64),rules={requiredRoles:['lm','employee'],independentApprovalFromRole:'lm'};
function document():SigningDocument{return{tenantId:'tenant',companyId:'company',subjectId:'case',subjectType:'probation',contentRevision:1,contentHash:hash,route:{version:1,steps:[{id:'lm',role:'lm',kind:'sign',stage:0,holderId:'manager',required:true},{id:'employee',role:'employee',kind:'acknowledge',stage:1,holderId:'staff',required:true},{id:'hod',role:'hod',kind:'approve',stage:2,holderId:'head',required:true}]},actions:[]};}
function sign(doc:SigningDocument,stepId:string,actorId:string){return recordSigningAction(doc,rules,{id:'action-'+stepId,actorId,actorName:actorId,stepId,revision:doc.contentRevision,hash:doc.contentHash,action:'signed',method:'typed',value:actorId,consent:true,at:'2026-11-03T03:00:00Z'});}
describe('content-bound signing guardrails',()=>{
  it('keeps every required step and requires a distinct approving person',()=>{
    const doc=document();doc.route.steps[2].holderId='manager';expect(()=>validateSigningRoute(doc.route,rules)).toThrow('different');
    expect(()=>validateSigningRoute({version:1,steps:document().route.steps.slice(0,2)},rules)).toThrow('independent');
    expect(()=>validateSigningRoute({version:1,steps:document().route.steps.filter(s=>s.role!=='employee')},rules)).toThrow('employee');
  });
  it('enforces sequence, current signer, consent and complete independent approvals',()=>{
    let doc=document();expect(()=>sign(doc,'employee','staff')).toThrow('assigned');expect(()=>sign(doc,'lm','attacker')).toThrow('assigned');
    expect(()=>recordSigningAction(doc,rules,{id:'x',actorId:'manager',actorName:'Manager',stepId:'lm',revision:1,hash,action:'signed',method:'typed',value:'Manager',consent:false,at:'2026-11-03T03:00:00Z'})).toThrow('consent');
    doc=sign(doc,'lm','manager');expect(signingComplete(doc,rules)).toBe(false);doc=sign(doc,'employee','staff');doc=sign(doc,'hod','head');expect(signingComplete(doc,rules)).toBe(true);
  });
  it('retains old signatures but does not reuse them on revised content',()=>{
    const doc=sign(document(),'lm','manager'),next=reviseSigningDocument(doc,'b'.repeat(64));expect(next.actions).toHaveLength(1);expect(pendingSigningSteps(next).map(s=>s.id)).toEqual(['lm']);
    expect(()=>recordSigningAction(next,rules,{id:'stale',actorId:'staff',actorName:'Staff',stepId:'employee',revision:1,hash,action:'signed',method:'typed',value:'Staff',consent:true,at:'2026-11-03T03:00:00Z'})).toThrow('changed');
  });
  it('holds a missing role and records delegation representation',()=>{
    const doc=document();doc.route.steps[0].holderId=null;expect(()=>sign(doc,'lm','manager')).toThrow('assigned');
    const next=replacePendingSigner(document(),rules,{stepId:'lm',holderId:'delegate',reason:'Manager away',kind:'delegation'});expect(sign(next,'lm','delegate').actions[0].representedId).toBe('manager');
    expect(()=>replacePendingSigner(document(),rules,{stepId:'hod',holderId:'manager',reason:'Same person',kind:'delegation'})).toThrow('different');
  });
  it('replays identical operation identities without a duplicate signature',()=>{const doc=sign(document(),'lm','manager');expect(sign(doc,'lm','manager').actions).toHaveLength(1);expect(()=>sign(doc,'employee','manager')).toThrow();});
});
