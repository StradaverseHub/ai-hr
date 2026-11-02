import {describe,expect,it} from 'vitest';
import {acceptContractDocument,actOnContractApproval,confirmContractDecision,contractAlertDue,contractApprovalsComplete,contractDisplayState,contractRenewalDates,DEFAULT_CONTRACT_SETTINGS,finishContractRenewal,issueContractDocument,newContractCase,parseContractAmount,proposeContractDecision,type ContractApprovalStep} from '../lib/contract-management-model';
const at='2026-11-03T03:00:00Z',hash='a'.repeat(64);
function record(){return newContractCase({id:'case',number:'CT-2026-0001',term:{id:'term',employmentId:'employee',companyId:'company',kind:'project',version:1,startOn:'2026-01-01',endOn:'2026-12-31',salaryCents:'500000',allowanceCents:'20000',sourceRevision:'source-v1'},settings:DEFAULT_CONTRACT_SETTINGS,today:'2026-11-03'});}
const steps:ContractApprovalStep[]=[{id:'rewards',name:'Rewards',stage:0,holderIds:['rewards'],quorum:'any',when:'pay_changed',state:'pending',actions:[]},{id:'ceo',name:'CEO',stage:1,holderIds:['ceo'],quorum:'all',when:'always',state:'pending',actions:[]}];
function proposal(){return proposeContractDecision(record(),{kind:'renew',months:6,salaryCents:'500000',allowanceCents:'20000',reason:'Continue project',actorId:'manager',at});}
describe('contract management lifecycle',()=>{
  it('uses exact cents and inclusive month boundaries',()=>{expect(parseContractAmount('5400.05')).toBe('540005');expect(()=>parseContractAmount('5.001')).toThrow();expect(contractRenewalDates('2026-12-31',6)).toEqual({startOn:'2027-01-01',endOn:'2027-06-30'});expect(()=>contractRenewalDates('2026-12-31',2)).toThrow();});
  it('skips Rewards without pay change and preserves an independent CEO decision',()=>{
    let r=confirmContractDecision(proposal(),{actorId:'bp',at,steps});expect(r.approvals[0].state).toBe('skipped');expect(()=>actOnContractApproval(r,{stepId:'ceo',actorId:'manager',action:'approve',comment:'',at,decisionRevision:1})).toThrow('assigned');
    r=actOnContractApproval(r,{stepId:'ceo',actorId:'ceo',action:'approve',comment:'',at,decisionRevision:1});expect(contractApprovalsComplete(r)).toBe(true);
  });
  it('returns rejected decisions with comments and requires fresh approval',()=>{
    let r=confirmContractDecision(proposal(),{actorId:'bp',at,steps});expect(()=>actOnContractApproval(r,{stepId:'ceo',actorId:'ceo',action:'reject',comment:'',at,decisionRevision:1})).toThrow('comment');
    r=actOnContractApproval(r,{stepId:'ceo',actorId:'ceo',action:'reject',comment:'Revise term',at,decisionRevision:1});expect(r.state).toBe('decision_pending');expect(r.approvals[1].actions[0].comment).toBe('Revise term');expect(contractApprovalsComplete(r)).toBe(false);
  });
  it('binds acceptance to approved issued bytes and does not claim failed record updates renewed',()=>{
    let r=confirmContractDecision(proposal(),{actorId:'bp',at,steps});r=actOnContractApproval(r,{stepId:'ceo',actorId:'ceo',action:'approve',comment:'',at,decisionRevision:1});
    r=issueContractDocument(r,{id:'doc',hash,templateId:'template',templateVersion:1,decisionRevision:1,issuedAt:at,acceptedAt:null,declinedAt:null,declineReason:null});
    expect(()=>acceptContractDocument(r,{hash:'b'.repeat(64),decisionRevision:1,action:'accept',reason:'',at})).toThrow('current');
    r=acceptContractDocument(r,{hash,decisionRevision:1,action:'accept',reason:'',at});expect(r.state).toBe('records_pending');expect(()=>finishContractRenewal(r)).toThrow('pending');
    r.effects.personnel='movement';r.effects.verificationTask='task';expect(finishContractRenewal(r).state).toBe('renewed');
  });
  it('flags unsigned expiry for humans without automatic employment ending',()=>{
    const r=record();expect(contractDisplayState(r,'2027-01-01')).toBe('expired_unsigned');expect(contractAlertDue(r,'2027-01-01','2026-11-03')).toBe('expired_unsigned');expect(r.state).toBe('decision_pending');expect(contractAlertDue(r,'2026-11-01','2026-11-03')).toBeNull();
  });
});
