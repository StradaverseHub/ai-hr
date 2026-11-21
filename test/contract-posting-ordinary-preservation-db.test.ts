/** Ordinary native preservation remains independent of any Contract frame/row permit. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {createBatch,generatePayslips,closeBatch} from '../packs/payroll/service';
import {payslipForReview} from '../core/payroll-view';
import {requirePackFor} from '../localization/registry';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {migrateTestDb,closeAll,owner,setModule,entitledCtx} from './harness';
import {contractPostingFixture} from './helpers/contract-posting-fixture';

beforeAll(migrateTestDb);afterAll(closeAll);
it('preserves issued documents through the unchanged public Maintain owner without a Contract job or permit',async()=>{
 const f=await contractPostingFixture();
 await setModule(f.b.tenantId,'payroll','active');
 const admin={...f.admin,entitlements:(await entitledCtx(f.b)).entitlements};
 await requirePackFor('MY').statutory.set(admin,{personId:f.employee.personId,icNumber:'900101010001',taxCategory:1,numChildren:0});
 const period=addCalendarMonths(todayInKualaLumpur().slice(0,7)+'-01',-1).slice(0,7);
 const{batchId}=await createBatch(admin,{companyId:f.b.companyId,payPeriod:period,scope:{employmentIds:[f.employee.employmentId]}});
 await generatePayslips(admin,{batchId});await closeBatch(admin,{batchId});
 const rows=await owner.db.execute<{id:string;row:Record<string,unknown>}>(sql`select id,to_jsonb(p) as row from public.payslip p where tenant_id=${f.b.tenantId}::uuid and batch_id=${batchId}::uuid order by id`);
 expect(rows).toHaveLength(1);expect(Number(rows[0].row.net_pay)).toBeGreaterThan(0);
 const document=await payslipForReview(admin,{companyIds:[f.b.companyId],payslipId:rows[0].id});expect(document).toBeTruthy();
 await withTenant(admin,async tx=>{
  const[scope]=await tx.execute<{job:string|null;maintain:boolean}>(sql`select nullif(current_setting('app.bulk_job',true),'') as job,app.access_workforce_employment(${f.employee.employmentId}::uuid,'workforce.maintain') as maintain`);
  expect(scope).toEqual({job:null,maintain:true});
  const[result]=await tx.execute<{n:number}>(sql`select app.preserve_movement_payroll(${f.employee.employmentId}::uuid) as n`);expect(result.n).toBe(1);
 });
 const snapshots=await owner.db.execute<{id:string;actor:string}>(sql`select payslip_id as id,recorded_by as actor from public.information_payslip_snapshot where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid order by payslip_id`);
 expect(snapshots).toEqual([{id:rows[0].id,actor:admin.userId}]);
 expect(await owner.db.execute(sql`select id,to_jsonb(p) as row from public.payslip p where tenant_id=${f.b.tenantId}::uuid and batch_id=${batchId}::uuid order by id`)).toEqual(rows);
 expect(await payslipForReview(admin,{companyIds:[f.b.companyId],payslipId:rows[0].id})).toEqual(document);
 const[counts]=await owner.db.execute<{permits:number;frames:number}>(sql`select (select count(*)::int from app.contract_posting_snapshot_permit where tenant_id=${f.b.tenantId}::uuid) as permits,(select count(*)::int from app.contract_posting_job_tx where tenant_id=${f.b.tenantId}::uuid) as frames`);
 expect(counts).toEqual({permits:0,frames:0});
},120_000);
