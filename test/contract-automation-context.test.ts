import {describe,expect,it} from 'vitest';
import {contractAutomationRead,contractAutomationRecipients,contractAutomationMergeValues,type ContractAutomationContext} from '../lib/contract-automation-context';
import {newContractFlow} from '../lib/contract-case-flow';
const context:ContractAutomationContext={caseId:'case',companyId:'company',subjectPersonId:'person-employee',userPersonIds:{employee:'person-employee',ops:'person-ops',chief:'person-chief'},employeeUserIds:['employee'],superiorUserIds:[],employeeName:'Fictional employee',employeeCode:'E1',jobTitle:'Engineer',company:'Company',businessGroup:'Group',businessGroupId:'bg',businessUnitId:'unit',department:'Engineering',departmentId:'department',managerName:'',startOn:'2026-01-01',endOn:'2026-12-31',contractNumber:4,flow:null,fallbackGroupId:'ops',postingApproverGroupId:'ops',groups:[{id:'ops',name:'People Ops',members:['ops','blocked']}],routings:[{id:'ceo',name:'CEO by group',rows:[{match:{businessGroup:['bg']},assignTo:{kind:'people',userIds:['chief']}}]}],activePeople:['employee','ops','chief'],names:{},pending:null};
describe('Contract shared resolution',()=>{
 it('uses native hierarchy ids and includes everyone matched for email recipients',()=>{
  expect(contractAutomationRecipients([{kind:'routing',routingId:'ceo'}],context)).toMatchObject({userIds:['chief'],fallbackUsed:false});
  expect(contractAutomationRecipients([{kind:'group',groupId:'ops'}],context).userIds).toEqual(['ops']);
 });
 it('records the unresolved target and uses only active fallback members',()=>{
  const result=contractAutomationRecipients([{kind:'role',role:'directSuperior'}],context);
  expect(result.userIds).toEqual(['ops']);expect(result.fallbackUsed).toBe(true);expect(result.unresolved[0].meantFor).toBe('Their Direct Superior');
 });
 it('excludes the employee from decision approval candidates and can hold without fallback',()=>{
  expect(contractAutomationRecipients([{kind:'person',userId:'employee'}],context,{excludeEmployee:true}).userIds).toEqual(['ops']);
  const self={...context,routings:[{id:'self',name:'Unsafe approval route',rows:[{match:{},assignTo:{kind:'people' as const,userIds:['employee','blocked']}}]}]};
  expect(contractAutomationRecipients([{kind:'routing',routingId:'self'}],self,{excludeEmployee:true}).userIds).toEqual(['ops']);
  expect(contractAutomationRecipients([{kind:'role',role:'employee'}],{...context,activePeople:['ops']},{fallback:false}).userIds).toEqual([]);
 });
 it('does not supply decision-only facts on contract-date triggers',()=>{
  const read=contractAutomationRead(context,'beforeContractEnd','2026-12-01');
  expect(read('daysToEnd')).toBe('30');expect(read('businessGroup')).toBe('bg');expect(read('decision')).toBeUndefined();
 });
 it('keeps admitted event conditions stable across delayed execution and approval resumption',()=>{
  const admitted={businessGroup:'original-group',daysToEnd:'14',decision:null};
  const read=contractAutomationRead({...context,businessGroupId:'later-group'},'beforeContractEnd','2027-01-01',admitted);
  expect(read('businessGroup')).toBe('original-group');expect(read('daysToEnd')).toBe('14');expect(read('decision')).toBeUndefined();
  const decision=contractAutomationRead(context,'decisionSubmitted','2027-01-01',{decision:'Renew',endReason:null,payChanges:'No',daysToEnd:'30'});
  expect(decision('decision')).toBe('Renew');expect(decision('endReason')).toBeNull();expect(decision('termMonths')).toBeNull();
 });
 it('tries the explicit default after an empty matching target, then uses module fallback if the default is empty',()=>{
  const routed={...context,routings:[{id:'ceo',name:'CEO',rows:[
   {match:{businessGroup:['bg']},assignTo:{kind:'people' as const,userIds:['blocked']}},
   {match:{company:['company']},assignTo:{kind:'people' as const,userIds:['employee']}},
   {match:{},assignTo:{kind:'people' as const,userIds:['chief']}},
  ]}]};
  expect(contractAutomationRecipients([{kind:'routing',routingId:'ceo'}],routed)).toMatchObject({userIds:['chief'],fallbackUsed:false});
  expect(contractAutomationRecipients([{kind:'routing',routingId:'ceo'}],{...routed,activePeople:['ops']})).toMatchObject({userIds:['ops'],fallbackUsed:true});
 });
 it('excludes every login for the employee person, including ambiguous accounts and fallback membership',()=>{
  const duplicate={...context,employeeUserIds:[],activePeople:['second-login','ops'],userPersonIds:{'second-login':'person-employee',ops:'person-ops'},groups:[{id:'ops',name:'Ops',members:['second-login','ops']}]};
  expect(contractAutomationRecipients([{kind:'person',userId:'second-login'}],duplicate,{excludeEmployee:true})).toMatchObject({userIds:['ops'],fallbackUsed:true});
  expect(contractAutomationRecipients([{kind:'person',userId:'second-login'}],duplicate).userIds).toEqual(['second-login']);
 });
 it('keeps the case period in later letters and date facts after Personnel advances to the next period',()=>{
  const previous={...context,flow:newContractFlow({id:'old-period',startOn:'2025-01-01',endOn:'2025-12-31',number:'3',sourceRevision:'old-source'},'2026-01-01T00:00:00Z')};
  expect(contractAutomationMergeValues(previous,'2026-01-01')).toMatchObject({'contract.start':'2025-01-01','contract.end':'2025-12-31','contract.number':'3'});
  expect(contractAutomationRead(previous,'afterContractEnd','2026-01-01')('daysToEnd')).toBe('-1');
 });
});
