/** Explicit handoff §14 defaults. Install missing definitions only; existing people and configuration remain owned by HR. */
import type {Config,Template,EmailTemplate,Block,Group} from './lifecycle-v9-model';
import type {AutomationWorkflow,AutomationStep,AutomationRecipient} from './automation/workflow';
import type {Routing} from './automation/routing';
const id=(n:number)=>`a0710000-0000-4000-8000-${String(n).padStart(12,'0')}`;
/** IDs 1–5 and all existing workflow/step identities are retained. */
export const RESIGNATION_DEFAULT_IDS={bp:id(1),acceptance:id(2),retention:id(3),acceptanceEmail:id(4),retentionEmail:id(5),ceo:id(6),bpGroup:id(7),ceoGroup:id(8),peopleOpsGroup:id(9),receivedEmail:id(10)};
export const RESIGNATION_DEFAULT_ROUTINGS:Routing[]=[
 {id:RESIGNATION_DEFAULT_IDS.bp,name:'BP by business group',rows:[{match:{},assignTo:{kind:'group',groupId:RESIGNATION_DEFAULT_IDS.bpGroup}}]},
 {id:RESIGNATION_DEFAULT_IDS.ceo,name:'BU / BG CEO',rows:[{match:{},assignTo:{kind:'group',groupId:RESIGNATION_DEFAULT_IDS.ceoGroup}}]},
];
const employee:AutomationRecipient={kind:'role',role:'employee'},superior:AutomationRecipient={kind:'role',role:'directSuperior'},bp:AutomationRecipient={kind:'routing',routingId:RESIGNATION_DEFAULT_IDS.bp},pending:AutomationRecipient={kind:'pending'};
/** Pass current routing IDs, including retired definitions, so setup never creates unused groups or replaces a custom route. */
export function resignationDefaults(config:Config,actorName:string,at:string,existingRoutings:readonly Routing[]=[]){
 const peopleOpsGroupId=config.peopleOpsGroup??RESIGNATION_DEFAULT_IDS.peopleOpsGroup,ops:AutomationRecipient={kind:'group',groupId:peopleOpsGroupId};
 const existing=new Set(existingRoutings.map(routing=>routing.id)),routings=RESIGNATION_DEFAULT_ROUTINGS.filter(routing=>!existing.has(routing.id)).map(routing=>structuredClone(routing));
 const needed=new Set(routings.flatMap(routing=>routing.rows.flatMap(row=>row.assignTo.kind==='group'?[row.assignTo.groupId]:[])));
 needed.add(peopleOpsGroupId);
 const groupDefinitions:Group[]=[
  {id:RESIGNATION_DEFAULT_IDS.bpGroup,name:'Resignation People Business Partners',members:[],limit:20},
  {id:RESIGNATION_DEFAULT_IDS.ceoGroup,name:'Resignation BU / BG CEOs',members:[],limit:20},
  {id:RESIGNATION_DEFAULT_IDS.peopleOpsGroup,name:'GBS People Ops',members:[],limit:25},
 ];
 const groups=groupDefinitions.filter(group=>needed.has(group.id)&&!config.groups.some(existing=>existing.id===group.id));
 const body=(kind:'acceptance'|'retention'):Block[]=>[
  {id:'letterhead',type:'letterhead',text:'',section:'main'},
  {id:'heading',type:'heading',text:kind==='retention'?'Offer of revised terms of employment':'Acceptance of resignation',section:'main'},
  {id:'body',type:'text',text:kind==='retention'?'Dear {{employee.name}},\nFollowing our discussion, we offer the revised terms of employment below.':'Dear {{employee.name}},\nWe accept your resignation. Your agreed last working day is {{resignation.lastDay}}. Please complete your handover and clearance.',section:'main'},
  ...(kind==='retention'?[
   {id:'terms',type:'table' as const,text:'',section:'main',columns:'Term | Current | Offered',rows:'Job title | {{employee.position}} | {{retention.title}}\nGrade | {{employee.grade}} | {{retention.grade}}\nBase salary | {{employee.salary}} | {{retention.salary}}'},
   {id:'closing',type:'text' as const,text:'These terms take effect on {{retention.effectiveDate}}. Please review and sign this letter to accept the offer.',section:'main'},
  ]:[]),
  {id:'hr-signature',type:'signature',text:'',section:'main',role:kind==='retention'?'step:ceo':'step:bp',label:kind==='retention'?'BU / BG CEO':'People Business Partner'},
  ...(kind==='retention'?[{id:'employee-signature',type:'signature' as const,text:'',section:'main',role:'step:employee',label:'Employee acceptance'}]:[]),
 ];
 const templates:Template[]=(['acceptance','retention'] as const).map(kind=>({
  id:RESIGNATION_DEFAULT_IDS[kind],name:kind==='retention'?'Retention offer e-letter':'Resignation acceptance letter',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'none',employeeAck:kind==='retention',retired:false,currentVersion:1,
  versions:[{version:1,state:'published',at,by:actorName,blocks:body(kind),fields:[],routing:kind==='retention'?[
   {id:'gbs-review',order:1,action:'review',who:{kind:'group',groupId:peopleOpsGroupId},owner:true},
   {id:'ceo',order:2,action:'sign',who:{kind:'routing',routingId:RESIGNATION_DEFAULT_IDS.ceo},owner:false},
   {id:'employee',order:3,action:'sign',who:{kind:'employee'},owner:false},
  ]:[
   {id:'gbs-review',order:1,action:'review',who:{kind:'group',groupId:peopleOpsGroupId},owner:true},
   {id:'bp',order:2,action:'sign',who:{kind:'routing',routingId:RESIGNATION_DEFAULT_IDS.bp},owner:false},
  ]}],
 }));
 const emails:EmailTemplate[]=(['acceptance','retention'] as const).map(kind=>({id:kind==='retention'?RESIGNATION_DEFAULT_IDS.retentionEmail:RESIGNATION_DEFAULT_IDS.acceptanceEmail,name:kind==='retention'?'Offer accepted':'Resignation accepted',module:'off',active:true,sender:'noreply',subject:kind==='retention'?'Your accepted retention offer':'Your resignation acceptance letter',body:'Dear {{employee.name}},\nPlease find your signed letter attached.\n\nHuman Resources\n{{company.name}}',cc:[],links:[],attachments:[RESIGNATION_DEFAULT_IDS[kind]],slots:[]}));
 emails.push({id:RESIGNATION_DEFAULT_IDS.receivedEmail,name:'Resignation received',module:'off',active:true,sender:'noreply',subject:'Resignation received: {{employee.name}}',body:'{{employee.name}} has submitted a resignation with a last working day of {{resignation.lastDay}}. Please record your decision in Approval Items › Resignations.',cc:[],links:[],attachments:[],slots:[]});
 const step=(stepId:string,type:string,params:Record<string,unknown>={},to:AutomationRecipient[]=[],cc:AutomationRecipient[]=[]):AutomationStep=>({id:stepId,type,params,to,cc,conditions:[]});
 const events=['submitted','retention','accepted','rejected','offerDue','offerAccepted','offerDeclined','withdrawn','signRequest','sentBack','released'];
 const workflow=(name:string,event:string,steps:AutomationStep[]):AutomationWorkflow=>({id:id(1001+events.indexOf(event)),module:'off',name,description:'Installed resignation journey default. Configure the GBS, BP and BU / BG CEO groups and routings, then review before making Live.',status:'paused',required:true,trigger:{event,days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps});
 const decision=(stepId:string,choices:'both'|'accept'='both',watch:AutomationRecipient[]=[bp])=>step(stepId,'requestDecision',{choices,watch,canComment:true,dueDays:3},[superior]);
 const notify=(stepId:string,to:AutomationRecipient[],subject:string,body:string,cc:AutomationRecipient[]=[])=>step(stepId,'notify',{subject,body},to,cc);
 const workflows=[
  workflow('Resignation received','submitted',[
   step('resignation-received-email','sendEmail',{emailTemplateId:RESIGNATION_DEFAULT_IDS.receivedEmail},[superior],[bp]),
   decision('step-11'),
  ]),
  workflow('Retention offer approval','retention',[step('step-12','generateDocument',{letterTemplateId:RESIGNATION_DEFAULT_IDS.retention,replyDays:5,remindDays:2})]),
  workflow('Resignation accepted','accepted',[
   step('step-15','startOffboarding',{exitReason:'Resignation'}),
   step('step-13','generateDocument',{letterTemplateId:RESIGNATION_DEFAULT_IDS.acceptance}),
   step('step-14','sendEmail',{emailTemplateId:RESIGNATION_DEFAULT_IDS.acceptanceEmail},[employee],[superior,bp]),
  ]),
  workflow('Approval rejected','rejected',[
   notify('retention-rejected-notify',[superior],'Retention offer for {{employee.name}} was rejected','The retention offer was rejected or withdrawn. Revise the terms or accept the resignation in Approval Items › Resignations.',[bp,ops]),
   decision('step-16','both',[bp,ops]),
  ]),
  workflow('Offer reply reminder','offerDue',[notify('step-17',[employee],'Your retention offer needs your reply','Please review your retention offer and reply before {{retention.replyBy}}.',[superior])]),
  workflow('Offer accepted','offerAccepted',[
   step('step-19','sendEmail',{emailTemplateId:RESIGNATION_DEFAULT_IDS.retentionEmail},[employee],[superior,bp]),
   step('step-18','createPosting',{eventType:'Promotion',dateFrom:'offerEff',fields:['title','grade','salary'],dueDays:2}),
  ]),
  workflow('Offer declined or lapsed','offerDeclined',[
   notify('offer-declined-notify',[superior],'Please confirm the resignation of {{employee.name}}','The employee did not take up the retention offer. Please accept the resignation in Approval Items › Resignations.',[bp]),
   decision('step-20','accept',[bp,ops]),
  ]),
  workflow('Resignation withdrawn','withdrawn',[notify('step-21',[superior,bp],'Resignation withdrawn: {{employee.name}}','The employee withdrew their resignation.')]),
  workflow('Letter needs action','signRequest',[notify('step-22',[pending],'Action needed: {{letter.name}}','Please {{letter.action}} {{letter.name}} in {{letter.where}}.')]),
  workflow('Letter sent back','sentBack',[notify('step-23',[pending],'Update needed: {{letter.name}}','{{letter.by}} sent this letter back: {{letter.why}}')]),
  workflow('Released resignation acceptance','released',[notify('step-24',[employee],'Letter released: {{letter.name}}','Your signed letter is available in your resignation case.')]),
 ];
 return{groups,peopleOpsGroupId,templates,emails,workflows,routings};
}
