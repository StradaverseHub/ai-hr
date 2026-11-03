import {z} from 'zod';
import {todayInKualaLumpur} from './hr-date';
import {ContractManagementError,type ContractCase,contractPayChanged} from './contract-management-model';
const uuid=z.uuid(),days=z.number().int().min(0).max(366);
export const contractApproverSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('employee_record'),field:z.enum(['manager','pbp','ceo','hod','employee'])}).strict(),
 z.object({type:z.literal('role_group'),role:z.enum(['rewards','gbs','legal'])}).strict(),
 z.object({type:z.literal('named_employee'),userIds:z.array(uuid).min(1).max(50)}).strict(),
]);
const condition=z.object({field:z.enum(['decision','contractType','businessGroup','payChanges','termMonths','daysToEnd']),op:z.enum(['is','isNot','gte','lt']),value:z.string().min(1).max(200)}).strict();
const approval=z.object({id:uuid,type:z.literal('request_approval'),name:z.string().trim().min(1).max(100),approver:contractApproverSchema,quorum:z.enum(['any','all']),reminderDays:days,escalationDays:days,escalationTarget:contractApproverSchema,conditions:z.array(condition).max(10),rejectedWorkflowId:uuid.nullable()}).strict();
export const contractWorkflowSchema=z.object({id:uuid,module:z.literal('contract_staff'),name:z.string().trim().min(1).max(120),required:z.boolean(),enabled:z.boolean(),description:z.string().max(2000),trigger:z.object({event:z.enum(['beforeContractEnd','decisionSubmitted','approvalRejected','signatureDeclined']),days,repeatUntil:z.enum(['none','decision','acceptance'])}).strict(),conditions:z.array(condition).max(10),steps:z.array(z.discriminatedUnion('type',[
 approval,
 z.object({id:uuid,type:z.literal('generate_document'),templateType:z.enum(['renewal','end','declined','retirement']),conditions:z.array(condition).max(10)}).strict(),
 z.object({id:uuid,type:z.literal('wait_signature'),reminderDays:days,escalationDays:days,timingSource:z.enum(['company','workflow']).default('company'),escalationTarget:contractApproverSchema.default({type:'employee_record',field:'pbp'}),conditions:z.array(condition).max(10)}).strict(),
 z.object({id:uuid,type:z.literal('update_record'),conditions:z.array(condition).max(10)}).strict(),
 z.object({id:uuid,type:z.literal('start_offboarding'),conditions:z.array(condition).max(10)}).strict(),
 z.object({id:uuid,type:z.literal('notify'),to:z.array(contractApproverSchema).min(1).max(10),subject:z.string().trim().min(1).max(200),body:z.string().max(5000),conditions:z.array(condition).max(10)}).strict(),
])).min(1).max(40)}).strict();
export type ContractWorkflow=z.infer<typeof contractWorkflowSchema>;
export type ContractApprover=z.infer<typeof contractApproverSchema>;
export type ContractApprovalDefinition=Extract<ContractWorkflow['steps'][number],{type:'request_approval'}>;
export function contractConditionsMatch(conditions:ContractWorkflow['conditions'],record:ContractCase,businessGroup:string,today=todayInKualaLumpur()):boolean{
 return conditions.every(c=>{const value=c.field==='decision'?record.decision?.kind:c.field==='contractType'?record.term.kind:c.field==='businessGroup'?businessGroup:c.field==='payChanges'?String(record.decision?contractPayChanged(record.term,record.decision):false):c.field==='daysToEnd'?String(Math.round((Date.parse(record.term.endOn)-Date.parse(today))/86400000)):String(record.decision?.months??0);
  if(c.op==='is')return value===c.value;if(c.op==='isNot')return value!==c.value;
  if(!['termMonths','daysToEnd'].includes(c.field)||!/^\d+$/.test(c.value))throw new ContractManagementError('invalid','Numeric comparisons are available for term months and days to contract end.');return c.op==='gte'?Number(value)>=Number(c.value):Number(value)<Number(c.value);});
}
export function validateContractWorkflow(raw:unknown):ContractWorkflow{
 const w=contractWorkflowSchema.parse(raw),ids=new Set<string>();
 for(const s of w.steps){if(ids.has(s.id))throw new ContractManagementError('invalid','Workflow step IDs must be unique.');ids.add(s.id);}
 if(w.trigger.event==='decisionSubmitted'&&w.conditions.some(c=>c.field==='decision'&&c.value==='renew'&&c.op==='is')){
  const types=w.steps.map(s=>s.type),generate=types.indexOf('generate_document'),wait=types.indexOf('wait_signature'),update=types.indexOf('update_record');
  if(generate<0||wait<0||update<0||generate>=wait||wait>=update||!w.steps.slice(generate+1,wait).some(s=>s.type==='request_approval'))throw new ContractManagementError('invalid','Renewal requires generation, approval, employee acceptance and then record update in that order.');
 }
 if(w.trigger.event==='signatureDeclined'||w.trigger.event==='decisionSubmitted'&&w.conditions.some(c=>c.field==='decision'&&c.value==='end'&&c.op==='is')){
  const types=w.steps.map(s=>s.type),generate=types.indexOf('generate_document'),handoff=types.indexOf('start_offboarding');
  if(generate<0||handoff<=generate)throw new ContractManagementError('invalid','Ending requires letter generation before the Offboarding handoff.');
 }
 return w;
}
/** IDs supplied by the native settings owner; no random values or account guesses in a seed. */
export function defaultContractWorkflows(ids:readonly string[],nextId:()=>string):ContractWorkflow[]{
 if(ids.length!==5)throw new ContractManagementError('invalid','Five workflow identities are required.');
 const conditions=(decision:string)=>[{field:'decision' as const,op:'is' as const,value:decision}],base=(index:number,name:string,event:ContractWorkflow['trigger']['event']):ContractWorkflow=>({id:ids[index],module:'contract_staff',name,required:true,enabled:true,description:'Review defaults with the named HR policy owners before activation.',trigger:{event,days:index===0?60:0,repeatUntil:index===0?'decision':'none'},conditions:[],steps:[]});
 const alerts=base(0,'Contract staff · 1 Expiry alerts','beforeContractEnd');alerts.steps=[{id:nextId(),type:'notify',to:[{type:'employee_record',field:'manager'},{type:'employee_record',field:'pbp'}],subject:'Contract decision required',body:'Review the expiring contract in Contract Management.',conditions:[{field:'daysToEnd',op:'gte',value:'0'}]},{id:nextId(),type:'notify',to:[{type:'employee_record',field:'hod'}],subject:'Contract decision overdue',body:'Review the overdue contract decision with the assigned manager and PBP.',conditions:[{field:'daysToEnd',op:'lt',value:'36'},{field:'daysToEnd',op:'gte',value:'0'}]},{id:nextId(),type:'notify',to:[{type:'employee_record',field:'pbp'},{type:'role_group',role:'gbs'}],subject:'Contract expired without acceptance',body:'Review the remaining contract action. Expiry does not end employment automatically.',conditions:[{field:'daysToEnd',op:'lt',value:'0'}]}];
 const renew=base(1,'Contract staff · 2 Renewal','decisionSubmitted');renew.conditions=conditions('renew');renew.steps=[{id:nextId(),type:'generate_document',templateType:'renewal',conditions:[]},{id:nextId(),type:'request_approval',name:'Rewards review',approver:{type:'role_group',role:'rewards'},quorum:'any',reminderDays:2,escalationDays:3,escalationTarget:{type:'employee_record',field:'pbp'},conditions:[{field:'payChanges',op:'is',value:'true'}],rejectedWorkflowId:ids[2]},{id:nextId(),type:'request_approval',name:'BU / BG CEO approval',approver:{type:'employee_record',field:'ceo'},quorum:'all',reminderDays:2,escalationDays:3,escalationTarget:{type:'employee_record',field:'pbp'},conditions:[],rejectedWorkflowId:ids[2]},{id:nextId(),type:'wait_signature',reminderDays:2,escalationDays:3,timingSource:'company',escalationTarget:{type:'employee_record',field:'pbp'},conditions:[]},{id:nextId(),type:'update_record',conditions:[]},{id:nextId(),type:'notify',to:[{type:'role_group',role:'gbs'}],subject:'Verify contract renewal records',body:'Review Personnel and pay changes against the accepted contract.',conditions:[]}];
 const rejected=base(2,'Contract staff · 3 Renewal rejected','approvalRejected');rejected.steps=[{id:nextId(),type:'notify',to:[{type:'employee_record',field:'manager'},{type:'employee_record',field:'pbp'}],subject:'Contract renewal returned',body:'Review the rejection comment and resubmit revised terms.',conditions:[]}];
 const declined=base(3,'Contract staff · 4 Employee declined','signatureDeclined');declined.steps=[{id:nextId(),type:'generate_document',templateType:'declined',conditions:[]},{id:nextId(),type:'notify',to:[{type:'employee_record',field:'employee'}],subject:'Your contract letter is ready',body:'Open Contract Management to review the letter released by People Ops.',conditions:[]},{id:nextId(),type:'start_offboarding',conditions:[]}];
 const end=base(4,'Contract staff · 5 End of contract','decisionSubmitted');end.conditions=conditions('end');end.steps=[{id:nextId(),type:'generate_document',templateType:'end',conditions:[]},{id:nextId(),type:'notify',to:[{type:'employee_record',field:'employee'}],subject:'Your contract letter is ready',body:'Open Contract Management to review the letter released by People Ops.',conditions:[]},{id:nextId(),type:'start_offboarding',conditions:[]}];
 return [alerts,renew,rejected,declined,end].map(validateContractWorkflow);
}
