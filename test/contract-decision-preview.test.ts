import {describe,expect,it} from 'vitest';
import {buildContractDecisionPlan,contractStepKey,type ContractPreviewDefinitions} from '../lib/contract-decision-preview';
import {newContractFlow,validateContractFlowDecision} from '../lib/contract-case-flow';
import type {ContractAutomationContext} from '../lib/contract-automation-context';
const id=(n:number)=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const flow=newContractFlow({id:id(1),startOn:'2026-01-01',endOn:'2026-12-31',number:'4',sourceRevision:'period'},'2026-11-17T00:00:00Z');
const decision=validateContractFlowDecision(flow,{kind:'renew',months:6,payChanges:false,reason:'Continue the role'});
const context:ContractAutomationContext={caseId:id(2),companyId:id(3),subjectPersonId:id(4),userPersonIds:{[id(5)]:id(6),[id(7)]:id(8),[id(9)]:id(4)},employeeUserIds:[],superiorUserIds:[],employeeName:'Subject',employeeCode:'S1',jobTitle:'Engineer',company:'Employer',businessGroup:'Group',businessGroupId:'bg',businessUnitId:null,department:'Engineering',departmentId:'dept',managerName:'',startOn:flow.period.startOn,endOn:flow.period.endOn,contractNumber:4,flow,fallbackGroupId:'ops',postingApproverGroupId:'ops',groups:[{id:'ops',name:'People Ops',members:[id(5)]},{id:'chiefs',name:'Chiefs',members:[id(7)]},{id:'empty',name:'Empty',members:[]}],routings:[{id:id(10),name:'BP by business group',rows:[{match:{businessGroup:['bg']},assignTo:{kind:'group',groupId:'empty'}},{match:{},assignTo:{kind:'group',groupId:'chiefs'}}]}],activePeople:[id(5),id(7),id(9)],names:{[id(5)]:'People Ops owner',[id(7)]:'Chief',[id(9)]:'Subject'},pending:null};
function definitions():ContractPreviewDefinitions{return {lastAssigned:{},emails:[],documents:[{version:3,template:{id:id(11),module:'contract_staff',name:'Renewal letter',description:'',rules:{decision:['Renew']},blocks:[{id:'intro',type:'text',text:'Dear {employee.name}',section:''}],fields:[],routing:[{id:id(12),order:1,action:'review',owner:true,who:{kind:'routing',routingId:id(10)}},{id:id(13),order:2,action:'sign',owner:false,who:{kind:'employee'}}]}}],workflows:[{revision:2,workflow:{id:id(14),module:'contract_staff',name:'Renew the contract',description:'',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[{field:'decision',op:'is',values:['Renew']}],steps:[
 {id:id(15),type:'requestApproval',conditions:[],to:[],cc:[],params:{layers:[{id:id(16),name:'CEO',pick:'any',approver:{kind:'routing',routingId:id(10)}}]}},
 {id:id(17),type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:id(11)}},
 {id:id(18),type:'createPosting',conditions:[],to:[],cc:[],params:{eventType:'Renewal'}},
]}}]};}
describe('Contract consequence preflight',()=>{
 it('describes the actual ordered chain, tries the explicit default, and holds a missing employee without substitution',()=>{
  const plan=buildContractDecisionPlan({context,decision,definitions:definitions(),today:'2026-11-17'});
  expect(plan.blockers).toEqual([]);expect(plan.workflowVersions).toEqual([{workflowId:id(14),revision:2}]);
  expect(plan.approvalAssignments[contractStepKey(id(14),id(15))][0]).toMatchObject({groupId:'chiefs',candidateUserIds:[id(7)],fallbackUsed:false});
  const letter=plan.letterAssignments[contractStepKey(id(14),id(17))];
  expect(letter.route.steps.map(step=>step.holderId)).toEqual([id(7),null]);
  expect(letter.unresolved).toEqual([expect.objectContaining({stepId:id(13),fallbackGroupId:null,holderId:null})]);
  expect(plan.warnings.join(' ')).toContain('nobody signs for them');expect(plan.workflows[0].steps[1].letter?.version).toBe(3);
 });
 it('blocks an empty approval/fallback chain and never lets an employee approve through another login',()=>{
  const unsafe={...context,groups:context.groups.map(group=>({...group,members:group.id==='chiefs'?[id(9)]:[]}))};
  const plan=buildContractDecisionPlan({context:unsafe,decision,definitions:definitions(),today:'2026-11-17'});
  expect(plan.approvalAssignments[contractStepKey(id(14),id(15))][0].candidateUserIds).toEqual([]);
  expect(plan.blockers.join(' ')).toContain('no eligible approver');
 });
 it('blocks a mismatched or prematurely placed posting and a letter that does not match the case',()=>{
  const defs=definitions(),steps=defs.workflows[0].workflow.steps;
  defs.workflows[0].workflow.steps=[{...steps[2],params:{eventType:'Conversion to permanent'}},steps[1],steps[0]];
  defs.documents[0].template.rules={company:[id(99)]};
  const plan=buildContractDecisionPlan({context,decision,definitions:defs,today:'2026-11-17'});
  expect(plan.blockers.join(' ')).toContain('before creating a Personnel posting');
  expect(plan.blockers.join(' ')).toContain('does not match this decision');
  expect(plan.blockers.join(' ')).toContain('does not match this decision and organisation');
 });
});
