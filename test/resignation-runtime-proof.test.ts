import {createHmac} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {resignationRuntimeKey,signResignationRuntime} from '../lib/resignation-runtime-proof';
import {organisationAdmissionKey} from '../lib/internal-auth/organisation-admission-proof';
const master='7'.repeat(64),principal={tenantId:'11111111-1111-1111-1111-111111111111',userId:'22222222-2222-2222-2222-222222222222',personId:'33333333-3333-3333-3333-333333333333',transactionId:'12345'};
describe('resignation runtime custody proof',()=>{
 it('uses a separate purpose key and binds exact state, actor, transaction and expiry',()=>{
  const args={id:'case',data:{letters:[{history:[{signature:'Fictional signer'}]}]},participants:['actor']};
  const signed=signResignationRuntime({operation:'save',caseId:'case',revision:9,command:{type:'letterAction'},args},principal,master,1000);
  expect(resignationRuntimeKey(master)).not.toEqual(organisationAdmissionKey(master));
  expect(signed.signature).toBe(createHmac('sha256',resignationRuntimeKey(master)).update(signed.payload).digest('hex'));
  expect(JSON.parse(signed.payload)).toEqual({...principal,v:1,purpose:'aihr-resignation-runtime-v1',runner:'resignation-journey',operation:'save',caseId:'case',revision:9,command:{type:'letterAction'},args,issuedAt:1000,expiresAt:61000});
  for(const changed of [{...args,data:{letters:[]}},{...args,participants:['attacker']}])expect(signResignationRuntime({operation:'save',caseId:'case',args:changed},principal,master,1000).signature).not.toBe(signed.signature);
  expect(signResignationRuntime({operation:'save',caseId:'case',args},{...principal,transactionId:'12346'},master,1000).signature).not.toBe(signed.signature);
 });
 it('refuses malformed key material',()=>{for(const key of ['',master.slice(1),'z'.repeat(64)])expect(()=>resignationRuntimeKey(key)).toThrow();});
});
