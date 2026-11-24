/** 7210 — the nightly movement sweep preserves closed payroll as a SYSTEM actor (no user, recorded_by NULL). On a real
 * installation the storage owner is NOSUPERUSER and information_payslip_snapshot forces row security, so that INSERT needs
 * its own policy. The harness owner is a superuser, which bypasses row security, so the sweep tests elsewhere cannot see
 * this. Here, inside one transaction that is always rolled back, the objects the preservation touches are owned by the
 * restricted ai_hr_owner exactly as on an installation, and the call runs as that role with the sweep's identity. */
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';

const ROLLBACK='rolled back on purpose';
// The tables app.preserve_payroll_metadata_owner and its admission read or write, plus app_user, whose owner defines the
// storage-owner session (app.access_workforce_storage_owner).
const OWNED=['information_payslip_snapshot','app_user','tenant','company','employment','assignment','payslip','payroll_batch','pay_period',
 'job_grade','domain_event','business_unit','department','position','role_assignment'];
const FUNCTIONS=['app.preserve_movement_payroll(uuid)','app.preserve_payroll_metadata(uuid,boolean)','app.preserve_payroll_metadata_owner(uuid,boolean,boolean)'];
let b:Base,id:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 id=(await hireEmployee(adminCtx(b),{person:{fullName:'Fictional System Snapshot',primaryEmail:'system-snapshot@example.test'},companyId:b.companyId,
  departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
});

const slip=async(period:string,status:'closed'|'processed')=>{
 const [p]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:status==='closed'?'closed':'open'}).returning();
 const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:p.id,payPeriod:period,batchDate:`${period}-25`,status}).returning();
 const [row]=await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'3000.00',grossPay:'3000.00',netPay:'3000.00',
  totalDeductions:'0.00',employerCost:'3000.00',statutory:{fixture:'restricted owner preservation'}}).returning();
 return row.id;
};

it('lets the restricted storage owner preserve closed payroll for the system sweep, and nothing wider',async()=>{
 const closed=await slip('2026-09','closed'),laterClosed=await slip('2026-10','closed'),processed=await slip('2026-11','processed');
 const done=owner.client.begin(async tx=>{
  const [role]=await tx`select rolsuper,rolbypassrls from pg_roles where rolname='ai_hr_owner'`;
  expect(role).toEqual({rolsuper:false,rolbypassrls:false});
  for(const t of OWNED)await tx.unsafe(`alter table public."${t}" owner to ai_hr_owner`);
  for(const f of FUNCTIONS)await tx.unsafe(`alter function ${f} owner to ai_hr_owner`);
  await tx`grant usage on schema app, public to ai_hr_owner`;
  await tx`grant execute on all functions in schema app to ai_hr_owner`;
  await tx`grant select on all tables in schema public, app to ai_hr_owner`;
  const [forced]=await tx`select relrowsecurity,relforcerowsecurity from pg_class where oid='public.information_payslip_snapshot'::regclass`;
  expect(forced).toEqual({relrowsecurity:true,relforcerowsecurity:true});
  const as=async(userId:string)=>{
   await tx.unsafe('set local role ai_hr_owner');
   await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${userId},true),set_config('app.roles','hr_admin',true),
    set_config('app.grants',${JSON.stringify([{role:'hr_admin',companyId:null}])},true)`;
  };
  const direct=(payslipId:string)=>tx.savepoint(sp=>sp`insert into information_payslip_snapshot(payslip_id,tenant_id,employment_id,company_id,hired_on,document_metadata,recorded_by)
   values (${payslipId}::uuid,${b.tenantId}::uuid,${id}::uuid,${b.companyId}::uuid,'2026-01-01',${JSON.stringify({preservationActor:'system'})}::jsonb,null)`);
  // A signed-in user never writes an unattributed snapshot, even of a closed payslip.
  await as(b.adminUserId);
  await expect(direct(closed)).rejects.toThrow(/row-level security/);
  await tx`reset role`;
  // The application role holds no INSERT on the table and is not a role the system policy applies to.
  await tx.unsafe('set local role ai_hr_app');
  await expect(direct(closed)).rejects.toThrow(/permission denied|row-level security/);
  await tx`reset role`;
  // The sweep's identity: the storage owner, no user, the legacy hr_admin engine grant (scripts/review-sweep.ts).
  // Before 7210 this call failed exactly as staging's 03:00 sweep did on 24 November 2026.
  await as('');
  // Each part of the 7210 admission for the closed payslip, as the restricted owner with the sweep's identity.
  const [admission]=await tx`select app.current_tenant_id()=${b.tenantId}::uuid as tenant,app.current_user_id() is null as no_user,
   app.access_workforce_storage_owner() as storage_owner,app.access_workforce_employment(${id}::uuid,'workforce.maintain') as maintain,
   app.is_admin_for(${b.companyId}::uuid) as admin,
   exists(select 1 from public.payslip p join public.payroll_batch b on b.id=p.batch_id where p.id=${closed}::uuid and p.employment_id=${id}::uuid
    and b.company_id=${b.companyId}::uuid and b.status='closed') as closed_slip`;
  expect(admission).toEqual({tenant:true,no_user:true,storage_owner:true,maintain:true,admin:true,closed_slip:true});
  expect((await tx`select policyname::text,roles::text,cmd::text from pg_policies where schemaname='public' and tablename='information_payslip_snapshot'
   and policyname='information_snapshot_system_preserve_insert'`)).toEqual([{policyname:'information_snapshot_system_preserve_insert',roles:'{ai_hr_owner}',cmd:'INSERT'}]);
  // The policy admits the system row directly (rolled back to keep the function's own count below honest).
  const DIRECT='direct insert admitted';
  await expect(tx.savepoint(async sp=>{await sp`insert into information_payslip_snapshot(payslip_id,tenant_id,employment_id,company_id,hired_on,document_metadata,recorded_by)
   values (${closed}::uuid,${b.tenantId}::uuid,${id}::uuid,${b.companyId}::uuid,'2026-01-01',${JSON.stringify({preservationActor:'system'})}::jsonb,null)`;throw new Error(DIRECT);}))
   .rejects.toThrow(DIRECT);
  const [{count}]=await tx<{count:number}[]>`select app.preserve_movement_payroll(${id}::uuid) as count`;
  expect(Number(count)).toBe(2);
  // Not closed: the system path preserves issued (closed) payroll only.
  await expect(direct(processed)).rejects.toThrow(/row-level security/);
  await tx`reset role`;
  const rows=await tx<{payslip_id:string;recorded_by:string|null;actor:string}[]>`select payslip_id::text,recorded_by::text,document_metadata->>'preservationActor' as actor
   from information_payslip_snapshot where employment_id=${id}::uuid order by payslip_id`;
  expect(rows).toEqual([closed,laterClosed].sort().map(payslip_id=>({payslip_id,recorded_by:null,actor:'system'})));
  throw new Error(ROLLBACK);
 });
 await expect(done).rejects.toThrow(ROLLBACK);
 // Nothing survives the rolled-back proof.
 expect(await owner.db.select().from(s.informationPayslipSnapshot)).toEqual([]);
});
