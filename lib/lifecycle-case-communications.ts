import {roleLabel} from './lifecycle-v9-recipients';
import {activeDocument,addDays,afterTrigger,dateTrigger,heldEmailDueOn,stepRecipientRoles,validDate,workflowMatches,type Case,type Config,type Document,type Mail,type Role,type Run,type Step,type Workflow} from './lifecycle-v9-model';
export type CommunicationStatus='attention'|'open'|'done';
export type CommunicationStage='submitted'|'before'|'day'|'after';
export type CommunicationRow={id:string;workflow?:Workflow;run?:Run;step?:Step;stepIndex:number;title:string;date:string;until:string|null;stage:CommunicationStage;status:CommunicationStatus;state:'attention'|'notStarted'|'waiting'|'done';reason:string;to:Role[];cc:Role[];overridden:boolean;mail:Mail|null;documents:Document[];availableDocument:Document|null;test:boolean};
export const communicationAnchor=(kind:'schedule'|'document'|'delivery',id:string)=>`communications-${kind}-${encodeURIComponent(id)}`;
const receipts=(c:Case,run:Run|undefined,step:Step)=>run?c.mails.filter(mail=>!mail.test&&(mail.key===`${run.id}:${step.id}`||mail.key.startsWith(`${run.id}:${step.id}:`))).sort((a,b)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id)):[];
function scheduledDate(c:Case,workflow:Workflow,run?:Run):{date:string;until:string|null}{
 const trigger=workflow.trigger,anchor=c.module==='onb'?c.facts.joinDate:c.facts.lastDay;
 if(run?.hold||run?.lateEmail)return{date:heldEmailDueOn(c,run)??run.date,until:trigger.repeat&&validDate(anchor)?anchor:null};
 if(dateTrigger(trigger.event)&&validDate(anchor))return{date:run?.date??addDays(anchor,afterTrigger(trigger.event)?trigger.days:-trigger.days,trigger.workdays),until:trigger.repeat&&!afterTrigger(trigger.event)?anchor:null};
 return{date:run?.date??c.submittedAt?.slice(0,10)??'',until:null};
}
/** A bounded display projection, never a scheduler. Retained runs and their exact step/mail identities own history. */
export function caseCommunications(c:Case,config:Config,today:string){
 const anchor=c.module==='onb'?c.facts.joinDate:c.facts.lastDay,rows:CommunicationRow[]=[],otherWorkflows:Workflow[]=[];
 const definitions=new Map(config.workflows.filter(workflow=>workflow.module===c.module).map(workflow=>[workflow.id,workflow]));
 for(const run of c.runs)if(run.definition?.module===c.module&&!definitions.has(run.workflowId))definitions.set(run.workflowId,run.definition);
 for(const current of definitions.values()){
  const retained=c.runs.filter(run=>run.workflowId===current.id),repeat=current.trigger.repeat&&dateTrigger(current.trigger.event)&&!afterTrigger(current.trigger.event);
  const runs=repeat&&retained.length?[retained.at(-1)!]:retained;
  if(!runs.length&&(current.status!=='published'||!workflowMatches(c,current,today)))continue;
  if(!runs.length&&current.trigger.event==='manual'){otherWorkflows.push(current);continue;}
  for(const run of runs.length?runs:[undefined]){
   const workflow=run?.definition??current,{date,until}=scheduledDate(c,workflow,run);
   const stage:CommunicationStage=workflow.trigger.event==='submitted'?'submitted':date&&validDate(anchor)?date<anchor?'before':date>anchor?'after':'day':'submitted';
   for(const [index,step]of workflow.steps.entries()){
    if(!['email','notify','doc'].includes(step.type))continue;
    const mails=receipts(c,run,step),mail=mails[0]??null,email=step.type==='email'?config.emails.find(email=>email.id===step.template):null;
    const roles=step.type==='email'||step.type==='notify'?stepRecipientRoles(c,workflow.id,step,email):{to:[],cc:[],overridden:false};
    const held=run?.hold?.stepId===step.id||run?.lateEmail?.stepId===step.id,failed=run?.status==='failed'&&index===run.cursor,done=!!run&&(run.status==='done'||run.status==='skipped'||index<run.cursor);
    const status:CommunicationStatus=held||failed?'attention':done?'done':'open';
    const linkedIds=[...new Set(mails.flatMap(mail=>mail.documentIds))],documents=linkedIds.flatMap(id=>{const document=c.documents.find(document=>document.id===id);return document?[document]:[];});
    const title=step.type==='notify'?step.subject:step.type==='email'?email?.name??'Email':config.templates.find(template=>template.id===step.template)?.name??'Document';
    rows.push({id:`${workflow.id}/${run?.id??'planned'}/${step.id}`,workflow,run,step,stepIndex:index,title,date,until,stage,status,state:status==='attention'?'attention':done?'done':run&&index===run.cursor?'waiting':'notStarted',reason:held?run?.hold?.missing.map(missing=>`${missing.label}: ${missing.role==='supervisor'&&c.supervisorDelivery?.problem?c.supervisorDelivery.problem:missing.reason}`).join('; ')||run?.reason||'Review the late email.':failed?run?.reason??'Review the workflow.':'',...roles,mail,documents,availableDocument:step.type==='doc'?activeDocument(c,step.template)??null:null,test:false});
   }
  }
 }
 const tests=c.mails.filter(mail=>mail.test).map(mail=>({id:`test/${mail.id}`,stepIndex:0,title:mail.subject,date:mail.at.slice(0,10),until:null,stage:'submitted' as const,status:mail.status==='failed'||mail.status==='uncertain'?'attention' as const:mail.status==='sent'||mail.status==='cancelled'?'done' as const:'open' as const,state:mail.status==='failed'||mail.status==='uncertain'?'attention' as const:mail.status==='sent'||mail.status==='cancelled'?'done' as const:'waiting' as const,reason:mail.failure??'',to:[],cc:[],overridden:false,mail,documents:c.documents.filter(document=>mail.documentIds.includes(document.id)),availableDocument:null,test:true}));
 const order=(a:CommunicationRow,b:CommunicationRow)=>(a.date||'9999').localeCompare(b.date||'9999')||a.id.localeCompare(b.id);
 return{rows:rows.sort(order),tests:tests.sort(order),otherWorkflows,unscheduledEmails:config.emails.filter(email=>email.module===c.module&&!rows.some(row=>row.step?.type==='email'&&row.step.template===email.id))};
}
export function communicationCounts(rows:readonly CommunicationRow[]){return{all:rows.length,attention:rows.filter(row=>row.status==='attention').length,open:rows.filter(row=>row.status==='open').length,done:rows.filter(row=>row.status==='done').length};}
export function communicationRecipientLabel(role:Role,c:Case,config:Config,users:{id:string;name:string}[]):string{
 const who=(id:string|null)=>users.find(user=>user.id===id)?.name;
 if(role==='employee'||role==='employeeWork'||role==='employeePersonal')return `${c.facts.name} · ${roleLabel(role)}`;
 if(role==='supervisor')return c.supervisorDelivery?.name??who(c.facts.supervisorUserId)??roleLabel(role);
 return roleLabel(role,{group:id=>config.groups.find(group=>group.id===id)?.name,person:id=>who(id)});
}
