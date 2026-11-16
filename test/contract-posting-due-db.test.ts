import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {migrateTestDb,closeAll,owner} from './harness';
import {contractPostingFixture,releaseContractPosting} from './helpers/contract-posting-fixture';
import {applyDueMovementsTx} from '../core/movement';

beforeAll(migrateTestDb);afterAll(closeAll);
it('applies a previously admitted due Contract schedule once through the canonical native owner',async()=>{
 const f=await contractPostingFixture(),p=await releaseContractPosting(f),eventId=randomUUID(),groupId=randomUUID();
 const remarks='Personnel posting PP-'+p.number;
 // Persist a previously admitted schedule due today. Real future admission is covered separately; this
 // fixture tests the actual due consumer without replacing the database clock or weakening its date guard.
 const input={employmentId:f.employee.employmentId,kind:'contractRenewal',typeCode:'contractRenewal',effectiveDate:f.newStart,endDate:f.newEnd,contractStartDate:f.newStart,contractNumber:'5',contractPostingId:p.id,remarks};
 const payload={type:'contractRenewal',effectiveDate:f.newStart,endDate:f.newEnd,remarks,fields:['contractStartDate','contractEndDate','contractNumber'],input,movement:{type:'contractRenewal',groupId,remarks,endDate:f.newEnd,contractPostingId:p.id}};
 await owner.db.transaction(async tx=>{
  await tx.execute(sql`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) values(${eventId}::uuid,${f.b.tenantId}::uuid,'employment',${f.employee.employmentId}::uuid,'employment.movement.scheduled','user',${f.approver.userId}::uuid,${f.employee.employmentId}::uuid,${JSON.stringify(payload)}::jsonb)`);
  await tx.execute(sql`update personnel_posting set status='approved',revision=revision+1,approved_by=${f.approver.userId}::uuid,approved_at=now()-interval '1 day',applied=proposed,movement_id=${eventId} where tenant_id=${f.b.tenantId}::uuid and id=${p.id}::uuid`);
  await tx.execute(sql`update contract_shared_posting set movement_group_id=${groupId}::uuid where tenant_id=${f.b.tenantId}::uuid and posting_id=${p.id}::uuid`);
 });
 const result=await withTenant(f.admin,tx=>applyDueMovementsTx(tx,f.admin,f.employee.employmentId,f.today));expect(result.applied).toBe(1);
 const[actual]=await owner.db.execute<{start:string;end:string;number:number;salary:string;group:string;applied:Date|null}>(sql`select e.contract_start_date::text start,e.contract_end_date::text "end",e.contract_number number,c.basic_salary::text salary,r.movement_group_id::text "group",r.applied_at applied from employment e join compensation c on c.tenant_id=e.tenant_id and c.employment_id=e.id and c.valid_to is null and c.superseded_at is null join contract_shared_posting r on r.tenant_id=e.tenant_id and r.posting_id=${p.id}::uuid where e.tenant_id=${f.b.tenantId}::uuid and e.id=${f.employee.employmentId}::uuid`);
 expect(actual).toMatchObject({start:f.newStart,end:f.newEnd,number:5,salary:'4976.21',group:groupId});expect(actual.applied).not.toBeNull();
 expect(await withTenant(f.admin,tx=>applyDueMovementsTx(tx,f.admin,f.employee.employmentId,f.today))).toMatchObject({applied:0,noop:0});
 const[count]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and payload->'movement'->>'type'='contractTermination'`);expect(count.n).toBe(1);
});
