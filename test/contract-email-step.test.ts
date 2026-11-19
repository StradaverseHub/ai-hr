import {beforeEach,expect,it,vi} from 'vitest';
import type {SqlExecutor} from '../db/sql-executor';
import type {ContractAutomationContext} from '../lib/contract-automation-context';
import type {AutomationEmailTemplate} from '../lib/automation/email';
import type {AutomationStepContext} from '../lib/automation/runtime';
import {newContractFlow} from '../lib/contract-case-flow';
import {contractSharedEmailExecutors} from '../core/contract-shared-email';
const mocks=vi.hoisted(()=>({queue:vi.fn(),fallback:vi.fn()}));
vi.mock('../core/automation-email-delivery',()=>({queueAutomationEmailTx:mocks.queue}));
vi.mock('../core/contract-shared-fallback',()=>({recordContractSharedFallbackTx:mocks.fallback}));
const tx={} as SqlExecutor;
const context:ContractAutomationContext={caseId:'case',companyId:'company',subjectPersonId:'employee-person',userPersonIds:{employee:'employee-person',ops:'ops-person'},employeeUserIds:['employee'],superiorUserIds:[],employeeName:'Fictional employee',employeeCode:'E1',jobTitle:'Engineer',company:'Fictional company',businessGroup:'Group',businessGroupId:'group',businessUnitId:null,department:'Engineering',departmentId:'department',managerName:'',startOn:'2026-01-01',endOn:'2026-12-31',contractNumber:4,flow:null,fallbackGroupId:'ops-group',postingApproverGroupId:'ops-group',groups:[{id:'ops-group',name:'People Ops',members:['ops']}],routings:[],activePeople:['employee','ops'],names:{},pending:null};
const template:AutomationEmailTemplate={id:'email',module:'contract_staff',name:'Original invitation',active:true,subject:'Hello {{employee.name}}',body:'Original words for {{employee.name}}. {{unknown.field}}',cc:[]};
const effect:AutomationStepContext={run:{id:'run',module:'contract_staff',workflowId:'workflow',workflowRevision:1,subjectId:'case',eventKey:'manual|original',trigger:'manual',status:'running',cursor:1,waitingFor:null,remaining:[],log:[],failure:null},step:{id:'email-step',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:'email'}},index:0,read:()=>null};
beforeEach(()=>{vi.clearAllMocks();mocks.queue.mockResolvedValue({queued:1,to:['employee'],cc:[],unreachable:[]});});
it('holds the same frozen email step without queueing any mail until its actual prerequisite is ready',async()=>{
 const prepare=vi.fn().mockResolvedValue({template,reference:{id:'email',revision:1},decisionRevision:0,waitingFor:'actual-pin',waitingReason:'HR review is pending.'});
 const executor=contractSharedEmailExecutors(tx,{context,today:'2026-11-17',templates:[{template,revision:1,retired:false}],prepareTemplate:prepare});
 expect(await executor.sendEmail!(effect)).toEqual({status:'wait',documentId:'actual-pin',retryStep:true,message:'HR review is pending.'});
 expect(mocks.queue).not.toHaveBeenCalled();expect(mocks.fallback).not.toHaveBeenCalled();
});
it('sends the native pinned original version despite later edits or retirement and retains unknown literal fields',async()=>{
 const prepare=vi.fn().mockResolvedValue({template,reference:{id:'email',revision:1},decisionRevision:0,waitingFor:null,waitingReason:null});
 const current={template:{...template,active:false,subject:'Later replacement',body:'Changed words'},revision:2,retired:true};
 const executor=contractSharedEmailExecutors(tx,{context,today:'2026-11-17',templates:[current],prepareTemplate:prepare});
 expect(await executor.sendEmail!(effect)).toMatchObject({status:'done'});
 expect(prepare).toHaveBeenCalledWith(effect,current);
 expect(mocks.queue.mock.calls[0][1]).toMatchObject({key:'run:email-step',subject:'Hello Fictional employee',body:'Original words for Fictional employee. {{unknown.field}}',richBody:{sourceTemplate:{id:'email',revision:1}}});
});
it('records actual unresolved notification routing when the current active fallback receives it',async()=>{
 const executor=contractSharedEmailExecutors(tx,{context,today:'2026-11-17',templates:[],prepareTemplate:vi.fn()});
 const notify={...effect,step:{...effect.step,type:'notify',to:[{kind:'role' as const,role:'directSuperior'}],params:{subject:'Review case',body:'{{employee.name}}'}}};
 expect(await executor.notify!(notify)).toMatchObject({status:'done'});
 expect(mocks.fallback).toHaveBeenCalledWith(tx,notify,[{meantFor:'Their Direct Superior',reason:expect.any(String)}]);
 expect(mocks.queue.mock.calls[0][1]).toMatchObject({to:['ops'],cc:[],subject:'Review case'});
});
it('keeps the original case-open email from acquiring decision fields supplied by a later case decision',async()=>{
 const original={...template,body:'{{contract.salary}} / {{employee.name}}'};
 const executor=contractSharedEmailExecutors(tx,{context,today:'2026-11-17',templates:[],letterValues:{'contract.salary':'9999.00'},prepareTemplate:vi.fn().mockResolvedValue({template:original,reference:{id:'email',revision:1},decisionRevision:0,waitingFor:null,waitingReason:null})});
 expect(await executor.sendEmail!({...effect,run:{...effect.run,trigger:'caseOpened'}})).toMatchObject({status:'done'});
 expect(mocks.queue.mock.calls[0][1].body).toBe('{{contract.salary}} / Fictional employee');
 expect(mocks.queue.mock.calls[0][1].richBody.values).not.toHaveProperty('contract.salary');
});

const oldDecision={kind:'renew' as const,startOn:'2027-01-01',endOn:'2027-06-30',months:6,payChanges:true,salaryCents:'520012',reason:'Original accepted terms',endReason:null,submittedBy:'actual-owner',submittedAt:'2026-11-17T00:00:00Z',revision:1};
const laterContext:ContractAutomationContext={...context,flow:{...newContractFlow({id:'period',startOn:context.startOn,endOn:context.endOn,number:'4',sourceRevision:'original-period'},'2026-11-17T00:00:00Z'),decision:{...oldDecision,revision:2,startOn:'2028-01-01',endOn:'2028-06-30',salaryCents:'990099',reason:'Later different terms'},decisionHistory:[oldDecision]}};
it('keeps a manual email pinned before any decision from acquiring later accepted terms or a Payroll fallback',async()=>{
 const original={...template,body:'{{contract.newStart}} / {{contract.salary}} / {{contract.reason}} / {{employee.name}}'};
 const executor=contractSharedEmailExecutors(tx,{context:laterContext,today:'2026-11-17',templates:[],letterValues:{'contract.salary':'9999.00'},prepareTemplate:vi.fn().mockResolvedValue({template:original,reference:{id:'email',revision:1},decisionRevision:0,waitingFor:null,waitingReason:null})});
 expect(await executor.sendEmail!(effect)).toMatchObject({status:'done'});
 expect(mocks.queue.mock.calls[0][1].body).toBe('{{contract.newStart}} / {{contract.salary}} / {{contract.reason}} / Fictional employee');
 for(const key of ['contract.newStart','contract.salary','contract.reason'])expect(mocks.queue.mock.calls[0][1].richBody.values).not.toHaveProperty(key);
});
it('merges a delayed email from its actual accepted decision revision rather than a later decision on the same case',async()=>{
 const original={...template,body:'{{contract.newStart}} / {{contract.salary}} / {{contract.reason}}'};
 const executor=contractSharedEmailExecutors(tx,{context:laterContext,today:'2026-11-17',templates:[],letterValues:{'contract.salary':'9999.00'},prepareTemplate:vi.fn().mockResolvedValue({template:original,reference:{id:'email',revision:1},decisionRevision:1,waitingFor:null,waitingReason:null})});
 expect(await executor.sendEmail!(effect)).toMatchObject({status:'done'});
 expect(mocks.queue.mock.calls[0][1].body).toBe('2027-01-01 / 5200.12 / Original accepted terms');
});
