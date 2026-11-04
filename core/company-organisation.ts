/** One dated company-to-organisation owner. SQL owns approval, snapshots, staging and publication. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {refreshOrganisationAdmission} from '../lib/internal-auth/organisation-admission';
import {isCalendarDate} from '../lib/calendar-date';
export type OrganisationTagTrigger='hire'|'correction'|'transfer'|'restructure'|'import'|'retag'|'assignment'|'movement';
export type CompanyOrganisationTags={companyId:string;businessUnitId:string|null;parentCompanyId:string|null;businessGroupId:string|null;mappingVersionId:string|null;status:'legacy'|'ready'|'pending';reason:string|null};
export type CompanyOrganisationChange={companyId:string;businessUnitId:string|null;parentCompanyId:string|null};
export type CompanyOrganisationRunInput={kind:'mapping'|'restructure'|'retag';companyIds:string[];effectiveOn:string;changes?:CompanyOrganisationChange[]};
export type CompanyOrganisationRun={id:string;kind:CompanyOrganisationRunInput['kind'];effectiveOn:string;state:'prepared'|'approved'|'staging'|'published'|'stale'|'rejected';digest:string;requestedBy:string;checkedBy:string|null;counts:{total:number;changed:number;unchanged:number;skipped:number;failed:number;staged:number};companyIds:string[];structure?:{companyId:string;company:string;before:CompanyOrganisationTags;after:CompanyOrganisationTags;beforeDisplay:Record<string,string|null>;afterDisplay:Record<string,string|null>}[];failure:string|null;canApprove:boolean;canProcess:boolean};
function day(value:string){if(!isCalendarDate(value))throw Error('Choose a valid organisation effective date.');return value;}
export async function deriveCompanyOrganisationTx(tx:Tx,_ctx:SessionContext,p:{companyId:string;asOf:string}):Promise<CompanyOrganisationTags>{
 const [row]=await tx.execute<{tags:CompanyOrganisationTags}>(sql`select app.company_organisation_tags(${p.companyId}::uuid,${day(p.asOf)}::date) tags`);if(!row?.tags)throw Error('Company organisation is unavailable.');return row.tags;
}
export async function employmentOrganisationTagsTx(tx:Tx,_ctx:SessionContext,p:{employmentId:string;asOf:string}):Promise<CompanyOrganisationTags>{
 const [row]=await tx.execute<{tags:CompanyOrganisationTags}>(sql`select app.employment_organisation_tags(${p.employmentId}::uuid,${day(p.asOf)}::date) tags`);if(!row?.tags)throw Error('Employee organisation is unavailable.');return row.tags;
}
/** Invoke inside the existing native writer transaction after its authoritative company/assignment effect.
 * Legacy mode records nothing; reviewed mode records one idempotent classification, no active interval. */
export async function recordEmploymentOrganisationTagsTx(tx:Tx,_ctx:SessionContext,p:{employmentId:string;companyId:string;asOf:string;trigger:OrganisationTagTrigger}):Promise<CompanyOrganisationTags>{
 const [row]=await tx.execute<{tags:CompanyOrganisationTags}>(sql`select app.record_employment_organisation_tags(${p.employmentId}::uuid,${p.companyId}::uuid,${day(p.asOf)}::date,${p.trigger}) tags`);if(!row?.tags)throw Error('Employee organisation is unavailable.');return row.tags;
}
export async function prepareCompanyOrganisationRun(ctx:SessionContext,input:CompanyOrganisationRunInput){await refreshOrganisationAdmission(ctx);return withTenant(ctx,async tx=>{
 const [row]=await tx.execute<{id:string}>(sql`select app.prepare_company_organisation_run(${JSON.stringify({...input,effectiveOn:day(input.effectiveOn)})}::jsonb) id`);return row.id;
});}
export async function decideCompanyOrganisationRun(ctx:SessionContext,p:{id:string;digest:string;approve:boolean;reason:string}){await refreshOrganisationAdmission(ctx,p.id);return withTenant(ctx,tx=>tx.execute(sql`select app.decide_company_organisation_run(${p.id}::uuid,${p.digest},${p.approve},${p.reason})`));}
/** One bounded checkpoint phase, followed by an atomic publication when every frozen row is staged. */
export async function processCompanyOrganisationRun(ctx:SessionContext,id:string){await refreshOrganisationAdmission(ctx,id);return withTenant(ctx,async tx=>{
 const [row]=await tx.execute<{run:CompanyOrganisationRun}>(sql`select app.process_company_organisation_run(${id}::uuid,200) run`);
 if(row.run.state!=='staging'||row.run.counts.staged<row.run.counts.total)return row.run;
 await tx.execute(sql`select app.begin_company_organisation_publication(${id}::uuid)`);
 const rows=await tx.execute<{employment_id:string;effective_on:string}>(sql`select employment_id,effective_on::text from app.company_organisation_projection_rows(${id}::uuid)`);
 const {projectEmploymentOrganisationAssignmentTx}=await import('./org');
 for(const item of rows)await projectEmploymentOrganisationAssignmentTx(tx,ctx,{employmentId:item.employment_id,effectiveOn:item.effective_on,trigger:'restructure'});
 const [published]=await tx.execute<{run:CompanyOrganisationRun}>(sql`select app.finish_company_organisation_publication(${id}::uuid) run`);return published.run;
});}
export async function companyOrganisationRuns(ctx:SessionContext){await refreshOrganisationAdmission(ctx);
 const ids=await withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select id from company_organisation_run where tenant_id=app.current_tenant_id() order by created_at desc,id limit 30`));
 for(const {id} of ids)await refreshOrganisationAdmission(ctx,id);
 return withTenant(ctx,async tx=>{
 const rows=await tx.execute<{run:CompanyOrganisationRun}>(sql`select app.company_organisation_run_view(id) run from company_organisation_run where tenant_id=app.current_tenant_id() order by created_at desc,id limit 30`);return rows.map(row=>row.run);
});}
export async function companyOrganisationRunReport(ctx:SessionContext,id:string,offset=0){await refreshOrganisationAdmission(ctx,id);return withTenant(ctx,async tx=>{
 const [row]=await tx.execute<{report:{run:CompanyOrganisationRun;rows:{employmentId:string;employee:string;employeeCode:string|null;companyId:string;company:string;projectionOn:string|null;beforeDisplay:Record<string,string|null>;afterDisplay:Record<string,string|null>;status:string;before:CompanyOrganisationTags;after:CompanyOrganisationTags;outcome:string;reason:string|null}[];hasMore:boolean}}>(sql`select app.company_organisation_run_report(${id}::uuid,${Math.max(0,Math.floor(offset))},100) report`);return row.report;
});}

export type CompanyOrganisationOptions={managed:boolean;companies:{id:string;name:string;parentCompanyId:string|null;businessUnitId:string|null;units:{id:string;name:string}[]}[]};
export async function companyOrganisationOptions(ctx:SessionContext){await refreshOrganisationAdmission(ctx);return withTenant(ctx,async tx=>{const [row]=await tx.execute<{options:CompanyOrganisationOptions}>(sql`select app.company_organisation_options() options`);return row.options;});}
