import {afterAll,beforeAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {migrateTestDb,closeAll} from './harness';
import {contractPostingFixture,releaseContractPosting} from './helpers/contract-posting-fixture';
import {contractSharedPostingWorkPage,listContractSharedPostings} from '../packs/contracts/service';

beforeAll(migrateTestDb);afterAll(closeAll);
it('counts native posting work with bounded output and rejects explicit NULL paging at both native queue signatures',async()=>{
 const f=await contractPostingFixture(),p=await releaseContractPosting(f);
 expect(await contractSharedPostingWorkPage(f.approver,{limit:1})).toMatchObject({total:1,items:[{kind:'contractPosting'}]});
 expect(await contractSharedPostingWorkPage(f.approver,{companyIds:[]})).toEqual({total:0,items:[]});
 expect(await contractSharedPostingWorkPage(f.employeeActor)).toEqual({total:0,items:[]});
 expect((await listContractSharedPostings(f.employeeActor,{postingId:p.id})).rows).toEqual([]);
 const statements=[
  sql`select app.contract_shared_postings_page(NULL::text,NULL::uuid,0,20)`,
  sql`select app.contract_shared_postings_page('pending',NULL::uuid,NULL::integer,20)`,
  sql`select app.contract_shared_postings_page('pending',NULL::uuid,0,NULL::integer)`,
  sql`select app.contract_shared_postings_page('pending',NULL::uuid,0,NULL::integer,${p.id}::uuid)`,
  sql`select app.contract_shared_posting_work_page(NULL::uuid[],0,NULL::integer)`,
  sql`select app.contract_shared_posting_work_page(NULL::uuid[],NULL::integer,20)`,
  sql`select app.contract_shared_posting_work_page(ARRAY[NULL::uuid],0,20)`,
 ];
 for(const statement of statements)await expect(withTenant(f.approver,tx=>tx.execute(statement))).rejects.toThrow();
 await expect(withTenant(f.approver,tx=>tx.execute(sql`select * from app.contract_shared_posting_tasks(NULL::uuid[])`))).rejects.toThrow();
});
it('the conversion intent cannot grant general System Label cache writes',async()=>{
 const f=await contractPostingFixture({kind:'convert'}),p=await releaseContractPosting(f);
 const[before]=await withTenant(f.approver,tx=>tx.execute<{held:boolean}>(sql`select app.contract_shared_posting_criteria_held(${f.b.tenantId}::uuid,'department') held`));expect(before.held).toBe(false);
 await expect(withTenant(f.approver,tx=>tx.execute(sql`select app.lock_system_label_criteria(${f.b.tenantId}::uuid,'department')`))).rejects.toThrow();
 await expect(withTenant(f.approver,tx=>tx.execute(sql`select app.contract_shared_posting_intent(${p.id}::uuid)`))).rejects.toThrow();
 const[after]=await withTenant(f.approver,tx=>tx.execute<{held:boolean}>(sql`select app.contract_shared_posting_criteria_held(${f.b.tenantId}::uuid,'department') held`));expect(after.held).toBe(false);
});
