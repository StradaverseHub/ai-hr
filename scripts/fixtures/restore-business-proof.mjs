/** Fictional hosted restore witness. No production credentials or target selection. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
assert.equal(process.env.GITHUB_ACTIONS,'true');
const url=new URL(process.env.DATABASE_URL);
assert(url.hostname==='127.0.0.1'||url.hostname==='localhost');
assert(/^\/ai_hr_rehearsal_arch_[a-f0-9]+$/.test(url.pathname));
const fixture=JSON.parse(readFileSync(process.argv[2],'utf8'));
const {client,withTenant}=await import('../../db/client.ts');
const {listWorkforcePickOptions}=await import('../../core/read.ts');
const {hireEmployee}=await import('../../core/org.ts');
try{
 const before=await listWorkforcePickOptions(fixture.context,[fixture.companyId]);
 assert(before.some(row=>row.employmentId===fixture.ownEmploymentId));
 assert(!before.some(row=>row.employmentId===fixture.foreignEmploymentId));
 assert.deepEqual(await listWorkforcePickOptions(fixture.context,[fixture.foreignCompanyId]),[]);
 const created=await hireEmployee(fixture.context,{companyId:fixture.companyId,departmentId:fixture.departmentId,
  person:{fullName:'Restored command witness',primaryEmail:'restored-command@example.test'},employmentType:'full_time',hiredOn:'2026-01-01',employeeCode:'RESTORE-COMMAND'});
 const after=await listWorkforcePickOptions(fixture.context,[fixture.companyId]);
 assert(after.some(row=>row.employmentId===created.employmentId));
 const [receipt]=await withTenant(fixture.context,tx=>tx.execute(sql`select count(*)::int as count from domain_event where aggregate_id=${created.employmentId}::uuid and tenant_id=${fixture.context.tenantId}::uuid`));
 assert(receipt.count>0,'restored command has no durable audit');
 console.log(JSON.stringify({restoredAuthorizedRead:true,crossTenantDenied:true,commandPersisted:true,auditPersisted:true}));
}finally{await client.end({timeout:5});}
