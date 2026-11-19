import 'server-only';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../../../db/client';
import {withLifecycleTenant} from '../../../core/module-gate';
import {v9EmploymentLabels} from '../../../lib/lifecycle-v9-employment';
import type {TemplateUsage,DefinitionUsage,RuleField,Actor,Config,Group} from '../../../lib/lifecycle-v9-model';

/** Configuration-only builder projection. Never materialises employee cases or salary data. */
export async function v9Configuration(ctx:SessionContext):Promise<{config:Config|null;actor:Actor;editable:boolean;offboardingEditable:boolean;users:{id:string;name:string}[];labels:Partial<Record<RuleField,Record<string,string>>>;previewCases:{id:string;module:'onb';label:string}[];usage:TemplateUsage[];references:DefinitionUsage[]} >{
 return withLifecycleTenant(ctx,async tx=>{
  const[access]=await tx.execute<{allowed:boolean;editable:boolean;offboardingEditable:boolean}>(sql`select app.is_group_admin() or app.is_admin() and (app.onboarding_page_access() or app.lc_v9_off_access()) as allowed,app.is_group_admin() as editable,app.automation_can_configure('off') as "offboardingEditable"`);
  if(!access?.allowed)throw new Error('You cannot open lifecycle configuration.');
  const[row]=await tx.execute<{data:Config}>(sql`select data from lc_v9_config where tenant_id=app.current_tenant_id()`);
  if(row)Reflect.deleteProperty(row.data,'bpRules');
  const[shared]=await tx.execute<{revision:number;groups:Group[]}>(sql`select revision,data->'groups' as groups from lc_onboarding_config where tenant_id=app.current_tenant_id()`);
  const wanted=new Set<string>(ctx.userId?[ctx.userId]:[]);
  for(const group of shared?.groups??[])for(const id of group.members)wanted.add(id);
  for(const template of row?.data.templates??[])for(const version of template.versions)for(const step of version.routing??[])if(step.who.kind==='people')for(const id of step.who.userIds)wanted.add(id);
  const addRole=(role:string)=>{if(role.startsWith('person:'))wanted.add(role.slice(7));};
  for(const email of row?.data.emails??[]){for(const role of email.cc)addRole(role);for(const recipient of [...(email.routingCc??[]),...email.slots.flatMap(slot=>slot.by?[slot.by]:[])])if(recipient.kind==='person')wanted.add(recipient.userId);}
  for(const workflow of row?.data.workflows??[])for(const step of workflow.steps)if('to'in step)for(const role of [...(Array.isArray(step.to)?step.to:[step.to]),...step.cc])addRole(role);
  const selected=[...wanted].filter(id=>/^[0-9a-f-]{36}$/i.test(id)).slice(0,500);
  const users=await tx.execute<{id:string;name:string}>(sql`select u.id,coalesce(p.full_name,'User') as name from app_user u left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.tenant_id=app.current_tenant_id() and u.id=any(${`{${selected.join(',')}}`}::uuid[]) and u.archived_at is null and not app.login_blocked(u.id) order by p.full_name nulls last,u.id limit 500`);
  const masters=await tx.execute<{kind:RuleField;id:string;name:string}>(sql`with masters as (
   (select 'businessGroup' as kind,id,name from business_unit where tenant_id=app.current_tenant_id() order by name,id limit 500)
   union all (select 'company',id,legal_name from company where tenant_id=app.current_tenant_id() and archived_at is null order by legal_name,id limit 500)
   union all (select 'department',id,name from department where tenant_id=app.current_tenant_id() and archived_at is null order by name,id limit 1000)
   union all (select 'grade',id,name from job_grade where tenant_id=app.current_tenant_id() order by name,id limit 500)
   union all (select 'title',id,title from position where tenant_id=app.current_tenant_id() and archived_at is null order by title,id limit 1000)
  ) select kind,id,name from masters`);
  const labels:Partial<Record<RuleField,Record<string,string>>>={employmentType:v9EmploymentLabels,caseType:Object.fromEntries(['Resignation','Termination','Contract end','Retirement','Non-confirmation'].map(value=>[value,value]))};
  for(const master of masters)(labels[master.kind]??={})[master.id]=master.name;
  const previewCases=await tx.execute<{id:string;module:'onb';label:string}>(sql`select id,'onb' as module,coalesce(data->>'number',id::text) as label from lc_onboarding_case where tenant_id=app.current_tenant_id() and app.is_admin_for(company_id) and data->>'state'<>'cancelled' order by created_at desc,id desc limit 20`);
  const usage=access.editable?[...await tx.execute<TemplateUsage>(sql`select template_id as "templateId",version,documents from app.lc_v9_document_usage()`)]:[];
  const references=access.editable?[...await tx.execute<DefinitionUsage>(sql`select kind,definition_id as "definitionId",messages,runs from app.lc_v9_definition_usage()`)]:[];
  if(access.editable&&row){
   const documentIds=row.data.templates.filter(t=>t.module==='off').map(t=>t.id),emailIds=row.data.emails.filter(e=>e.module==='off').map(e=>e.id);
   const textArray=(ids:string[])=>sql`ARRAY[${sql.join(ids.map(id=>sql`${id}`),sql`, `)}]::text[]`;
   const managed=await tx.execute<{kind:'document'|'email';definitionId:string;version:number|null;documents:number;messages:number}>(sql`select kind,definition_id as "definitionId",version,documents::integer,messages::integer from app.resignation_configuration_usage(${textArray(documentIds)},${textArray(emailIds)})`);
   for(const item of managed){if(item.kind==='document'&&item.version!==null){const prior=usage.find(u=>u.templateId===item.definitionId&&u.version===item.version);if(prior)prior.documents+=item.documents;else usage.push({templateId:item.definitionId,version:item.version,documents:item.documents});}const prior=references.find(r=>r.kind===item.kind&&r.definitionId===item.definitionId);if(prior)prior.messages+=item.messages+item.documents;else references.push({kind:item.kind,definitionId:item.definitionId,messages:item.messages+item.documents,runs:0});}
  }
  const actor=users.find(u=>u.id===ctx.userId)??{id:ctx.userId??'',name:'User'};
  return{config:row?{...row.data,groups:shared?.groups??[],groupsRevision:shared?.revision??0}:null,actor,editable:!!access.editable,offboardingEditable:!!access.offboardingEditable,users:[...users],labels,previewCases:[...previewCases],usage,references};
 });
}
