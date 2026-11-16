import {describe,expect,it} from 'vitest';
import {contractAutomationRead,contractAutomationRecipients,type ContractAutomationContext} from '../lib/contract-automation-context';
const context:ContractAutomationContext={caseId:'case',companyId:'company',employeeUserIds:['employee'],superiorUserIds:[],employeeName:'Fictional employee',employeeCode:'E1',jobTitle:'Engineer',company:'Company',businessGroup:'Group',businessGroupId:'bg',businessUnitId:'unit',department:'Engineering',departmentId:'department',managerName:'',startOn:'2026-01-01',endOn:'2026-12-31',contractNumber:4,flow:null,fallbackGroupId:'ops',postingApproverGroupId:'ops',groups:[{id:'ops',name:'People Ops',members:['ops','blocked']}],routings:[{id:'ceo',name:'CEO by group',rows:[{match:{businessGroup:['bg']},assignTo:{kind:'people',userIds:['chief']}}]}],activePeople:['employee','ops','chief'],names:{},pending:null};
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
});
