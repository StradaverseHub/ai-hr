import 'server-only';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import type {ContractWorkflowRow,ContractTemplateRow} from './contract-management';
/** Builder-only adapter: bounded definitions and sample identities, never employee contract/pay payloads. */
export async function contractConfigurationWorkflows(ctx:SessionContext){return withScopedLifecycleTenant(ctx,async tx=>{
 const workflows=await tx.execute<ContractWorkflowRow>(sql`select id,company_id as "companyId",revision,draft,published_version as "publishedVersion",enabled,required from contract_workflow where tenant_id=app.current_tenant_id() and app.contract_configure(company_id) order by company_id,draft->>'name',id limit 500`);
 const companies=await tx.execute<{id:string;name:string}>(sql`select id,legal_name as name from company where tenant_id=app.current_tenant_id() and app.contract_configure(id) order by legal_name,id limit 500`);
 const cases=await tx.execute<{id:string;number:string;companyId:string;name:string}>(sql`select c.id,c.number,c.company_id as "companyId",p.full_name as name from contract_case c join employment e on e.id=c.employment_id and e.tenant_id=c.tenant_id join person p on p.id=e.person_id and p.tenant_id=e.tenant_id where c.tenant_id=app.current_tenant_id() and app.contract_configure(c.company_id) order by c.created_at desc,c.id desc limit 20`);
 const businessGroups=await tx.execute<{companyId:string;id:string;name:string}>(sql`select * from app.contract_workflow_business_groups() limit 2000`);
 return{workflows:[...workflows],companies:[...companies],cases:[...cases],businessGroups:[...businessGroups]};
 });}
const directoryInput=z.object({companyId:z.uuid(),query:z.string().max(100),selectedUserIds:z.array(z.uuid()).max(200)}).strict();
/** Search one selected company; existing named reviewers stay hydrated. No company-by-company request fanout. */
export async function contractConfigurationDirectory(ctx:SessionContext,raw:unknown){const input=directoryInput.parse(raw);return withScopedLifecycleTenant(ctx,tx=>tx.execute<{id:string;name:string;employeeId:string|null}>(sql`select id,name,"employeeId" from app.contract_configuration_directory(ARRAY[${input.companyId}::uuid],${input.query},ARRAY[${sql.join(input.selectedUserIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`));}

export async function contractConfigurationTemplates(ctx:SessionContext){return withScopedLifecycleTenant(ctx,async tx=>{
 const templates=await tx.execute<ContractTemplateRow>(sql`select id,company_id as "companyId",app.contract_template_company_name(id) as "companyName",type,revision,draft,live_version as "liveVersion",draft_submitted_at::text as "submittedAt",signatory_name as "signatoryName",signatory_title as "signatoryTitle",app.contract_template_can_approve(id) as "canApprove" from contract_template where tenant_id=app.current_tenant_id() order by company_id,type,id limit 500`);
 const companies=await tx.execute<{id:string;name:string}>(sql`select id,name from app.contract_company_choices() where gbs order by name,id limit 500`);
 return{templates:[...templates],companies:[...companies]};
 });}
