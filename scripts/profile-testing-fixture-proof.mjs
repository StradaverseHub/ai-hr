/** Closed local fixture facts, never an application acceptance or manual-pass receipt. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {stableTestingJson} from '../lib/system-testing/hash.ts';
export const profileTestingDigest=value=>createHash('sha256').update(stableTestingJson(value)).digest('hex');
export function profileTestingDates(today){
 if(typeof today!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(today)||!Number.isFinite(Date.parse(today+'T00:00:00Z'))||new Date(today+'T00:00:00Z').toISOString().slice(0,10)!==today)throw new Error('Canonical local date required.');
 const year=Number(today.slice(0,4)),month=Number(today.slice(5,7));
 const payPeriod=new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7);
 return {today,payPeriod,hiredOn:`${Number(payPeriod.slice(0,4))-1}-01-01`,concurrentOn:today.slice(0,7)+'-01',oldHiredOn:`${year-3}-01-01`,oldEndedOn:`${year-2}-12-31`,birthDate:`${year-35}-03-02`,children:[`${year-10}-02-03`,`${year-8}-04-05`],qualificationFrom:`${year-15}-03`,qualificationTo:`${year-12}-08`,graduationDate:`${year-12}-09-01`};
}
/** Exact full applied prefix; extra, missing, reordered or edited migrations are all refusals. */
export function assertProfileTestingJournal(expected,applied){
 if(!Array.isArray(expected)||!expected.length||!Array.isArray(applied)||expected.length!==applied.length||expected.some((row,i)=>!Number.isSafeInteger(row.when)||!(/^[a-f0-9]{64}$/).test(row.sha256)||row.sha256!==applied[i]?.hash||String(row.when)!==String(applied[i]?.created_at)))throw new Error('Exact applied source migration journal required; continuation cannot migrate.');
}
export async function profileTestingInvariant(client,fixture){
 const tenantIds=fixture.fixtureTenants.map(t=>t.id),users=[...new Set(Object.values(fixture.people).map(p=>p.userId))];
 const versions=[...new Set(Object.values(fixture.cases).flatMap(c=>[c.versionId,c.priorVersionId].filter(Boolean)))];
 const assignments=Object.values(fixture.cases).flatMap(c=>Object.values(c.assignments).map(a=>a.assignmentId));
 return client.begin('isolation level repeatable read read only',async tx=>{
  await tx`set local statement_timeout='20s'`;
  const [connection]=await tx`select current_database() database,host(inet_server_addr()) address,inet_server_port() port,(select oid::text from pg_database where datname=current_database()) oid`;
  const [visibility]=await tx`select rolsuper or rolbypassrls full_visibility from pg_roles where rolname=current_user`;
  if(connection.database!=='ai_hr_board19_profile_testing_browser'||!['127.0.0.1','::1'].includes(connection.address)||connection.port!==5433)throw new Error('Exact local Profile/Testing database required.');
  if(visibility?.full_visibility!==true)throw new Error('Complete owner visibility required for fixture invariants.');
  const queries={
   tenants:await tx`select id,name,workos_org_id,status from tenant where id=any(${tenantIds}::uuid[]) order by id`,
   companies:await tx`select id,tenant_id,country,currency,company_label,legal_name,archived_at from company where tenant_id=any(${tenantIds}::uuid[]) order by id`,
   users:await tx`select id,tenant_id,person_id,workos_user_id,archived_at from app_user where id=any(${users}::uuid[]) order by id`,
   grants:await tx`select id,tenant_id,app_user_id,role,company_id from role_assignment where app_user_id=any(${users}::uuid[]) order by id`,
   // Drizzle configures DATE as text; raw postgres parses Date. Pin SQL text before hashing.
   employments:await tx`select id,tenant_id,person_id,company_id,employee_code,hired_on::text as hired_on,terminated_on::text as terminated_on from employment where tenant_id=any(${tenantIds}::uuid[]) order by id`,
   versions:(await tx`select to_jsonb(v) row from test_case_version v where id=any(${versions}::uuid[]) order by id`).map(r=>r.row),
   assignments:await tx`select id,tenant_id,test_case_id,tester_user_id from test_assignment where id=any(${assignments}::uuid[]) order by id`,
   released:(await tx`select jsonb_build_object('batch',to_jsonb(b),'payslip',to_jsonb(p)) row from payroll_batch b join payslip p on p.batch_id=b.id where b.id=${fixture.releasedPayroll.batchId}::uuid and p.id=${fixture.releasedPayroll.payslipId}::uuid and p.employment_id=${fixture.releasedPayroll.employmentId}::uuid and b.status='closed' and b.released_at<=now()`).map(r=>r.row),
  };
  if(queries.tenants.length!==tenantIds.length||queries.users.length!==users.length||queries.users.some(u=>u.archived_at)||queries.versions.length!==versions.length||queries.assignments.length!==assignments.length||queries.released.length!==1)throw new Error('Initial fixture identities/history/released Payroll are missing.');
  // SQL JSON normalizes dates before hashing; no raw salary, identity or attachment data is exported.
  const normalized=JSON.parse(JSON.stringify(queries));
  return {connection,digest:profileTestingDigest(normalized),sections:Object.fromEntries(Object.entries(normalized).map(([key,rows])=>[key,{count:rows.length,digest:profileTestingDigest(rows)}]))};
 });
}
export function assertProfileTestingInvariant(expected,actual){
 if(!expected||!actual||expected.connection?.oid!==actual.connection?.oid||expected.connection?.database!==actual.connection?.database||expected.digest!==actual.digest)throw new Error('Initial fixture identities, immutable versions or released Payroll changed; preserve all observations.');
}
function privateFile(file,max){
 const st=fs.lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||st.nlink!==1||(st.mode&0o077)||st.size<1||st.size>max||fs.realpathSync(file)!==file)throw new Error('Owned private bounded fixture evidence required.');
 const bytes=fs.readFileSync(file);if(bytes.length!==st.size)throw new Error('Fixture evidence changed while reading.');return bytes;
}
/** Parent records a real Download UI outcome here; this helper never creates PDF bytes or a claim. */
export function verifyOptionalProfileTestingPdf(directory,fixture){
 const pdf=path.join(directory,'released-payslip.pdf'),observation=path.join(directory,'released-pdf-observation.json');
 const present=[fs.existsSync(pdf),fs.existsSync(observation)];
 if(!present.some(Boolean))return {status:'not_yet_observed'};
 if(!present.every(Boolean))throw new Error('Preserve the incomplete real PDF observation; do not invent its pair.');
 const bytes=privateFile(pdf,10*1024*1024),receiptBytes=privateFile(observation,16384),record=JSON.parse(receiptBytes.toString());
 const sha256=createHash('sha256').update(bytes).digest('hex');
 if(bytes.length<100||bytes.subarray(0,5).toString()!=='%PDF-'||record.actualBrowserDownload!==true||!/^([a-f0-9]{40})$/.test(record.sourceRef)||record.payslipId!==fixture.releasedPayroll.payslipId||record.employmentId!==fixture.releasedPayroll.employmentId||record.downloadedFrom!==fixture.releasedPayroll.pdfRoute||record.sha256!==sha256)throw new Error('Actual released PDF observation binding differs.');
 return {status:'parent_observed_download_retained',sha256,bytes:bytes.length,observationSha256:createHash('sha256').update(receiptBytes).digest('hex'),sourceRef:record.sourceRef};
}
