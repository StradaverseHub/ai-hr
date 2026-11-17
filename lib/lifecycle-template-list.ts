/** Presentation-only relationships between authorized template/workflow snapshots. No case reads or storage writes. */
import {currentVersion,type Config,type Template} from './lifecycle-v9-model';
import {sortedDocumentRouting,type DocumentRouting} from './document-signing-routing';
import type {AutomationWorkflow} from './automation/workflow';
export type TemplateListChoices={routings:{id:string;name:string;retired?:boolean}[];groups:{id:string;name:string}[];people:{id:string;name:string}[]};
export type LifecycleTemplateListMetadata={documents:Record<string,{signing:string;uses:string[]}>;emails:Record<string,{uses:string[]}>};
type Label=(key:string,values?:Record<string,string|number>)=>string;
/** IDs and module ownership, never names, determine use. Step numbers retain the saved workflow's actual order. */
export function lifecycleTemplateListMetadata(config:Config,shared:readonly AutomationWorkflow[],choices:TemplateListChoices,t:Label):LifecycleTemplateListMetadata{
 const documents=new Map(config.templates.map(template=>[template.id,template])),emails=new Map(config.emails.map(email=>[email.id,email]));
 const result:LifecycleTemplateListMetadata={documents:{},emails:{}};
 const uses=new Map<string,string[]>(),add=(kind:'document'|'email',id:string,module:string,text:string)=>{
  if((kind==='document'?documents.get(id):emails.get(id))?.module!==module)return;
  const key=kind+':'+id;uses.set(key,[...(uses.get(key)??[]),text]);
 };
 const usage=(name:string,source:'shared'|'legacy',status:string,step:number,email?:string)=>t('templates.listSummary.usedIn',{workflow:name+' · '+t('templates.listSummary.'+source)+' · '+t((source==='shared'?'status.':'templates.state.')+status)+(email?' · '+t('templates.emails')+': '+email:''),step});
 const emailUse=(id:string,module:string,name:string,source:'shared'|'legacy',status:string,step:number)=>{
  const email=emails.get(id);if(!email||email.module!==module)return;
  add('email',id,module,usage(name,source,status,step));
  for(const templateId of new Set([...email.links,...email.attachments]))add('document',templateId,module,usage(name,source,status,step,email.name));
 };
 for(const workflow of config.workflows)workflow.steps.forEach((step,index)=>{
  if(step.type==='doc'||step.type==='waitSign')add('document',step.template,workflow.module,usage(workflow.name,'legacy',workflow.status,index+1));
  if(step.type==='email')emailUse(step.template,workflow.module,workflow.name,'legacy',workflow.status,index+1);
 });
 for(const workflow of shared){if(workflow.module!=='off')continue;workflow.steps.forEach((step,index)=>{
  if(step.type==='generateDocument'&&typeof step.params.letterTemplateId==='string')add('document',step.params.letterTemplateId,workflow.module,usage(workflow.name,'shared',workflow.status,index+1));
  if(step.type==='sendEmail'&&typeof step.params.emailTemplateId==='string')emailUse(step.params.emailTemplateId,workflow.module,workflow.name,'shared',workflow.status,index+1);
 });}
 const routingNames=new Map(choices.routings.map(r=>[r.id,r])),groupNames=new Map(choices.groups.map(g=>[g.id,g.name])),peopleNames=new Map(choices.people.map(p=>[p.id,p.name]));
 const who=(step:DocumentRouting[number])=>{
  const who=step.who;
  if(who.kind==='employee'||who.kind==='directSuperior')return t('templates.signing.'+who.kind);
  if(who.kind==='routing'){const found=routingNames.get(who.routingId);return found?found.name+(found.retired?' · '+t('status.retired'):''):t('templates.signing.missing');}
  if(who.kind==='group')return groupNames.get(who.groupId)??t('templates.signing.missing');
  const names=who.userIds.flatMap(id=>peopleNames.has(id)?[peopleNames.get(id)!]:[]),missing=who.userIds.length-names.length;
  return [...names,...(missing?[t('templates.signing.people',{count:missing})]:[])].join(', ');
 };
 const signing=(template:Template)=>{
  const current=currentVersion(template),draft=current?null:template.versions.find(v=>v.state==='draft'),routing=current?.routing??draft?.routing??[];
  if(routing.length){
   const orders=new Map<number,string[]>();for(const step of sortedDocumentRouting(routing))orders.set(step.order,[...(orders.get(step.order)??[]),t('templates.signing.action.'+step.action)+' '+who(step)]);
   const chain=[...orders.values()].map(rows=>rows.length>1?t('templates.listSummary.parallel',{steps:rows.join(' + ')}):rows[0]).join(' → ');
   return draft?t('templates.listSummary.draftRoute',{chain}):t('templates.signing.chain',{chain});
  }
  // Offboarding's shared journey resolves the configured HR fallback at generation.
  // Do not present native-case employee signing defaults as that resolved route.
  if(template.module==='off')return t('templates.signing.existing');
  if(template.type==='Attachment')return t('templates.listSummary.legacyNoSigning');
  if(template.hrStep==='before')return t('templates.listSummary.legacyBefore');
  if(template.hrStep==='after')return t('templates.listSummary.legacyAfter');
  return template.employeeAck?t('templates.listSummary.employeeAck'):t('templates.signing.chain',{chain:t('templates.signing.action.sign')+' '+t('templates.signing.employee')});
 };
 for(const template of config.templates)result.documents[template.id]={signing:signing(template),uses:uses.get('document:'+template.id)??[t('templates.listSummary.notUsed')]};
 for(const email of config.emails)result.emails[email.id]={uses:uses.get('email:'+email.id)??[t('templates.listSummary.notUsed')]};
 return result;
}
