/** Import-safe, SELECT-only setup proof shared by fresh fixture and receipt-bound resume.
 * Never imports the fixture entry, loads environment, opens a pool or reads Auth secrets.
 */
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {createDb} from '../db/client';
export const REPORT_FIXTURE_DATABASE='ai_hr_board18_reports_browser';
export const REPORT_FIXTURE_NAMESPACE='board18reports';
export const REPORT_FIXTURE_PORT=3197;
export const REPORT_FIXTURE_TENANT_NAME='Reports18 fictional primary tenant';
export const REPORT_FIXTURE_FOREIGN_NAME='Reports18 fictional foreign tenant';
const SYSTEM='00000000-0000-0000-0000-000000000000';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REPORT_SETUP_TABLES=[
 'company','position','business_unit','department','cost_center','label_company_assignment',
 'system_label_criteria_epoch','system_label_collision_baseline','job_grade','grade_group','grade_group_member','profile_option','movement_event_type','person','employment','assignment',
 'compensation','reporting_line','role_assignment','app_user','employee_dependent',
 'employee_qualification','employee_statutory_my','payroll_permission_grant','tenant_module',
 'tenant_setting','employee_id_config','employee_draft','employment_tax_selection_my',
 'employment_tax_scheme_my','leave_type','entitlement_template','leave_ledger',
] as const;
// Source changes invalidate setup receipts; candidate SHA is separately bound by coordinator.
export const REPORT_FIXTURE_METADATA_FILES=[
 'db/schema.ts','db/migrations/meta/_journal.json','db/provision.ts','db/seed-guides.ts',
 'lib/personnel-field-registry.ts','lib/personnel-field-label.ts','lib/employee-master-report.ts',
 'lib/employee-master-starters.ts','core/employee-master-access.ts','core/employee-master-reports.ts',
 'core/employee-master-projection.ts','core/payroll-permissions-admin.ts',
 'core/org.ts','core/comp.ts','core/movement.ts','core/dependents.ts','core/qualifications.ts',
 'localization/my/statutory.ts','lib/payroll-permissions.ts','core/employment-company.ts',
 'messages/en.json','messages/ms.json','messages/zh.json','messages/ta.json','messages/th.json','messages/vi.json',
 'scripts/employee-master-fixture-proof.mts','scripts/dev-fixture-employee-master.mts',
 'scripts/report-fixture-connection.mjs',
 'scripts/report-fixture-employee-codes.mjs','lib/employee-code.ts',
] as const;
export function reportFixtureCanonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(reportFixtureCanonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+reportFixtureCanonical(item)).join(',')+'}';
 return JSON.stringify(value)??'null';
}
export const reportFixtureDigest=(value:unknown)=>createHash('sha256').update(reportFixtureCanonical(value)).digest('hex');
export function reportFixtureUrls(env:Record<string,string|undefined>) {
 if(env.NODE_ENV==='production'||env.AUTH_PROVIDER&&env.AUTH_PROVIDER!=='workos'||env.ALLOW_DEMO_SESSION!=='true'||env.DEV_TENANT_ID!==undefined||env.DEV_USER_ID!==undefined||Object.entries(env).some(([key,value])=>/^(WORKOS_|KEYCLOAK_|INTERNAL_AUTH_)/.test(key)&&Boolean(value)))throw new Error('Only explicitly enabled fictional local demo setup without a selected tenant or real provider is allowed.');
 if(env.TEST_DB_NAMESPACE!==REPORT_FIXTURE_NAMESPACE)throw new Error('Wrong Reports fixture namespace.');
 const read=(key:string)=>{let url:URL;try{url=new URL(env[key]??'');}catch{throw new Error('Local fixture database URL required.');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/'+REPORT_FIXTURE_DATABASE||url.search||url.hash||!url.username)throw new Error('Only the exact named local Reports database is allowed.');return url;};
 const app=read('DATABASE_URL'),owner=read('MIGRATION_DATABASE_URL');
 const host=(url:URL)=>url.hostname==='localhost'?'127.0.0.1':url.hostname;
 if(decodeURIComponent(app.username)!=='ai_hr_app'||decodeURIComponent(owner.username)==='ai_hr_app'||host(app)!==host(owner))throw new Error('Require restricted app and distinct owner on the same local endpoint.');
 return {app,owner};
}
export type EmployeeMasterFixtureProof={version:1;metadataDigest:string;stateDigest:string;tables:{table:string;rows:number;digest:string}[]};
export async function readEmployeeMasterFixtureProof(reader:Pick<ReturnType<typeof createDb>,'client'>,declared:{tenantId:string;foreignTenantId:string}):Promise<EmployeeMasterFixtureProof> {
 if(!uuid.test(declared.tenantId)||!uuid.test(declared.foreignTenantId)||declared.tenantId===declared.foreignTenantId||[declared.tenantId,declared.foreignTenantId].includes(SYSTEM))throw new Error('Invalid declared Reports tenants.');
 const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
 const metadata=[];
 for(const relative of REPORT_FIXTURE_METADATA_FILES){const target=path.join(root,relative),stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Fixture metadata is not a regular source file.');metadata.push({path:relative,sha256:createHash('sha256').update(await fs.readFile(target)).digest('hex')});}
 const tables=await reader.client.begin('isolation level repeatable read read only',async tx=>{
  await tx`select set_config('statement_timeout','10000',true)`;
  const [connection]=await tx`select current_database() as database, current_setting('transaction_read_only') as read_only, current_setting('transaction_isolation') as isolation`;
  if(connection?.database!==REPORT_FIXTURE_DATABASE||connection.read_only!=='on'||connection.isolation!=='repeatable read')throw new Error('Reports proof is not a read-only named snapshot.');
  const tenants=await tx`select id::text,name from public.tenant order by id limit 4`;
  if(tenants.length!==3||!tenants.some(row=>row.id===SYSTEM)||!tenants.some(row=>row.id===declared.tenantId&&row.name===REPORT_FIXTURE_TENANT_NAME)||!tenants.some(row=>row.id===declared.foreignTenantId&&row.name===REPORT_FIXTURE_FOREIGN_NAME))throw new Error('Reports tenant inventory differs from the declared fresh setup.');
  const result=[{table:'tenant',rows:tenants.length,digest:reportFixtureDigest(tenants)}];
  for(const table of REPORT_SETUP_TABLES){
   // Names originate solely in the literal closed list above. UUIDs are SQL parameters.
   const projection=table==='app_user'?"to_jsonb(t)-'dashboard_layout'-'list_preferences'-'onboarded_at'":'to_jsonb(t)';
   const rows=await tx.unsafe(`select ${projection} as row from public."${table}" t where tenant_id in ($1::uuid,$2::uuid) order by (${projection})::text limit 10001`,[declared.tenantId,declared.foreignTenantId]);
   if(rows.length>10000)throw new Error('Reports invariant inventory exceeds its safe bound.');
   result.push({table,rows:rows.length,digest:reportFixtureDigest(rows.map(row=>row.row))});
  }
  // Historical Movement reads use these actual source events. Report run/delivery audit is excluded.
  const history=await tx`select to_jsonb(t) as row from public.domain_event t where tenant_id in (${declared.tenantId}::uuid,${declared.foreignTenantId}::uuid) and aggregate_type in ('employment','assignment','compensation','reporting-line','employee-dependent','employee-qualification') order by id limit 10001`;
  if(history.length>10000)throw new Error('Reports history inventory exceeds its safe bound.');
  result.push({table:'domain_event:personnel-source-only',rows:history.length,digest:reportFixtureDigest(history.map(row=>row.row))});
  return result;
 });
 return {version:1,metadataDigest:reportFixtureDigest(metadata),stateDigest:reportFixtureDigest(tables),tables};
}
