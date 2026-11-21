import {describe,expect,it} from 'vitest';
import {actOnContractApproval,contractApprovalCanAct,newContractApprovalRequest,pendingContractApproval,type ContractApprovalAssignment} from '../lib/contract-approval-flow';
const at='2026-11-16T15:00:00Z';
const assignments:ContractApprovalAssignment[]=[
 {layer:{id:'chief',name:'CEO',pick:'any',approver:{kind:'group',groupId:'chiefs'}},groupId:'chiefs',candidateUserIds:['chief-a'],candidatePersonIds:{'chief-a':'person-a'},selectedUserId:null,fallbackUsed:false,missingReason:null},
 {layer:{id:'ops',name:'People Ops',pick:'roundRobin',approver:{kind:'group',groupId:'ops'}},groupId:'ops',candidateUserIds:['ops-a','ops-b'],candidatePersonIds:{'ops-a':'person-ops-a','ops-b':'person-ops-b'},selectedUserId:'ops-b',fallbackUsed:false,missingReason:null},
];
const request=()=>newContractApprovalRequest({id:'approval',caseId:'case',tenantId:'tenant',companyId:'company',decisionRevision:1,subjectPersonId:'employee-person',fingerprint:'a'.repeat(64),assignments});
const action=(userId:string,personId:string,layerId:string,groups:Record<string,string[]>={})=>({id:layerId+':'+userId,layerId,userId,personId,name:userId,action:'approve' as const,reason:'',at,activeUserIds:[userId],currentGroupMembers:groups});
describe('Contract decision approval layers',()=>{
 it('rejects a forged frozen assignment and keeps separate approval requests distinct from their case',()=>{
  expect(request().document.subjectId).toBe('approval');
  const patches:Partial<ContractApprovalAssignment>[]=[{selectedUserId:'outsider'},{candidatePersonIds:{'ops-b':'employee-person'}},{candidatePersonIds:{}}];
  for(const patch of patches){
   expect(()=>newContractApprovalRequest({id:'approval',caseId:'case',tenantId:'tenant',companyId:'company',decisionRevision:1,subjectPersonId:'employee-person',fingerprint:'a'.repeat(64),assignments:[{...assignments[1],...patch}]})).toThrow('eligible');
  }
 });
 it('runs layers in order, lets a current group member claim Any, and freezes the Round-robin holder',()=>{
  let record=request();
  expect(pendingContractApproval(record)?.layer.name).toBe('CEO');
  expect(contractApprovalCanAct(record,action('ops-b','person-ops-b','ops',{ops:['ops-b']}))).toBe(false);
  expect(contractApprovalCanAct(record,action('ops-b','person-ops-b','chief',{ops:['ops-b']}))).toBe(false);
  record=actOnContractApproval(record,action('new-chief','new-chief-person','chief',{chiefs:['new-chief']}));
  expect(record.document.actions[0].signature).toBeNull();expect(record.document.actions[0].actorId).toBe('new-chief');
  expect(pendingContractApproval(record)?.layer.name).toBe('People Ops');
  expect(contractApprovalCanAct(record,action('ops-a','person-ops-a','ops',{ops:['ops-a','ops-b']}))).toBe(false);
  record=actOnContractApproval(record,action('ops-b','person-ops-b','ops'));
  expect(record.status).toBe('approved');expect(pendingContractApproval(record)).toBeNull();
  expect(actOnContractApproval(record,action('ops-b','person-ops-b','ops'))).toEqual(record);
 });
 it('never accepts the subject employee, an inactive member or a relinked Round-robin account',()=>{
  const record=request();
  expect(contractApprovalCanAct(record,action('chief-a','employee-person','chief',{chiefs:['chief-a']}))).toBe(false);
  expect(contractApprovalCanAct(record,{...action('chief-a','person-a','chief',{chiefs:['chief-a']}),activeUserIds:[]})).toBe(false);
  const advanced=actOnContractApproval(record,action('chief-a','person-a','chief',{chiefs:['chief-a']}));
  expect(contractApprovalCanAct(advanced,action('ops-b','another-person','ops'))).toBe(false);
 });
 it('requires a reason for rejection and preserves the completed earlier layer as evidence',()=>{
  const advanced=actOnContractApproval(request(),action('chief-a','person-a','chief',{chiefs:['chief-a']}));
  expect(()=>actOnContractApproval(advanced,{...action('ops-b','person-ops-b','ops'),action:'reject'})).toThrow('reason');
  const rejected=actOnContractApproval(advanced,{...action('ops-b','person-ops-b','ops'),action:'reject',reason:'Review the proposed dates'});
  expect(rejected.status).toBe('rejected');expect(rejected.document.actions).toHaveLength(2);
  expect(rejected.document.actions[0]).toEqual(advanced.document.actions[0]);
 });
});
