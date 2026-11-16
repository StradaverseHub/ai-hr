/** Explicit, idempotent defaults. No people, companies, dates or live workflow activation are fabricated. */
import type {Config,Template,EmailTemplate,Block} from './lifecycle-v9-model';
import type {AutomationWorkflow,AutomationStep,AutomationRecipient} from './automation/workflow';
import type {Routing} from './automation/routing';
const id=(n:number)=>`a0710000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const RESIGNATION_DEFAULT_IDS={bp:id(1),acceptance:id(2),retention:id(3),acceptanceEmail:id(4),retentionEmail:id(5)};
export const RESIGNATION_DEFAULT_ROUTINGS:Routing[]=[{id:id(1),name:'Resignation BP by business group and department',rows:[]}];
const employee:AutomationRecipient={kind:'role',role:'employee'},superior:AutomationRecipient={kind:'role',role:'directSuperior'},bp:AutomationRecipient={kind:'routing',routingId:id(1)},pending:AutomationRecipient={kind:'pending'};
export function resignationDefaults(config:Config,actorName:string,at:string){
 const ops:AutomationRecipient=config.peopleOpsGroup?{kind:'group',groupId:config.peopleOpsGroup}:bp;
 const body=(kind:'acceptance'|'retention'):Block[]=>[{id:'heading',type:'heading',text:kind==='retention'?'Retention offer':'Acceptance of resignation',section:''},{id:'body',type:'text',text:kind==='retention'?'Dear {{employee.name}},\nWe offer you the position of {{retention.title}}, grade {{retention.grade}}, with basic salary {{retention.salary}}, effective {{retention.effectiveDate}}. Please review and sign to accept this offer.':'Dear {{employee.name}},\nWe accept your resignation. Your agreed last working day is {{resignation.lastDay}}. Please complete your handover and clearance.',section:''}];
 const templates:Template[]=(['acceptance','retention'] as const).map(kind=>({id:RESIGNATION_DEFAULT_IDS[kind],name:kind==='retention'?'Resignation retention offer':'Resignation acceptance letter',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'before',employeeAck:kind==='retention',retired:false,currentVersion:1,versions:[{version:1,state:'published',at,by:actorName,blocks:body(kind),fields:[],routing:kind==='retention'?[{id:'hr',order:1,action:'sign',who:ops.kind==='group'?{kind:'group',groupId:ops.groupId}:{kind:'routing',routingId:id(1)},owner:true},{id:'employee',order:2,action:'sign',who:{kind:'employee'},owner:false}]:[{id:'bp',order:1,action:'sign',who:{kind:'routing',routingId:id(1)},owner:true}]}]}));
 const emails:EmailTemplate[]=(['acceptance','retention'] as const).map(kind=>({id:kind==='retention'?id(5):id(4),name:kind==='retention'?'Released retention offer':'Released resignation acceptance',module:'off',active:true,sender:'',subject:kind==='retention'?'Your accepted retention offer':'Your resignation acceptance letter',body:'Dear {{employee.name}},\nPlease find your signed letter attached.\n\nHuman Resources\n{{company.name}}',cc:[],links:[],attachments:[RESIGNATION_DEFAULT_IDS[kind]],slots:[]}));
 let n=10;const step=(type:string,params:Record<string,unknown>={},to:AutomationRecipient[]=[]):AutomationStep=>({id:`step-${++n}`,type,params,to,cc:[],conditions:[]});
 const workflow=(name:string,event:string,steps:AutomationStep[]):AutomationWorkflow=>({id:id(++n),module:'off',name,description:'Installed resignation journey default. Review recipients and make Live when ready.',status:'paused',required:true,trigger:{event,days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps});
 const decision=()=>step('requestDecision',{choices:'both',watch:[bp],canComment:true,dueDays:3},[superior]);
 const notify=(to:AutomationRecipient[],subject:string,body:string)=>step('notify',{subject,body},to);
 const workflows=[
 workflow('Employee resignation submitted','submitted',[decision()]),
 workflow('Prepare retention offer','retention',[step('generateDocument',{letterTemplateId:id(3),replyDays:5,remindDays:2})]),
 workflow('Accept resignation and start clearance','accepted',[step('generateDocument',{letterTemplateId:id(2)}),step('sendEmail',{emailTemplateId:id(4)},[employee]),step('startOffboarding')]),
 workflow('Retention offer withdrawn: return to decision','rejected',[decision()]),
 workflow('Retention offer reminder','offerDue',[notify([employee],'Your retention offer needs your reply','Please review your retention offer and reply before {{retention.replyBy}}.')]),
 workflow('Record accepted retention offer','offerAccepted',[step('createPosting',{eventType:'Promotion',dateFrom:'offerEff',fields:['title','grade','salary'],dueDays:3}),step('sendEmail',{emailTemplateId:id(5)},[employee])]),
 workflow('Retention declined or lapsed: accept resignation','offerDeclined',[step('requestDecision',{choices:'accept',watch:[bp],canComment:true,dueDays:3},[superior])]),
 workflow('Resignation withdrawn','withdrawn',[notify([superior,bp],'Resignation withdrawn: {{employee.name}}','The employee withdrew their resignation.')]),
 workflow('Letter action needed','signRequest',[notify([pending],'Action needed: {{letter.name}}','Please {{letter.action}} {{letter.name}} in {{letter.where}}.')]),
 workflow('Letter sent back','sentBack',[notify([pending],'Update needed: {{letter.name}}','{{letter.by}} sent this letter back: {{letter.why}}')]),
 workflow('Released resignation acceptance','released',[notify([employee],'Letter released: {{letter.name}}','Your signed letter is available in your resignation case.')]),
 ];return{templates,emails,workflows,routings:RESIGNATION_DEFAULT_ROUTINGS};
}
