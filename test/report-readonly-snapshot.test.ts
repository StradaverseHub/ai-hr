import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type Tx } from '../db/client';
import { company } from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let base:Base;
beforeAll(async()=>{await migrateTestDb();});
beforeEach(async()=>{await resetDb();base=await seedBase();});
afterAll(closeAll);
async function rootError(promise:Promise<unknown>){try{await promise;return '';}catch(error){const messages:string[]=[];let e:unknown=error;while(e instanceof Error){messages.push(e.message);e=(e as Error&{cause?:unknown}).cause;}return messages.join(' | ');}}
describe('explicit report read-only snapshot',()=>{
  it('starts repeatable read and read only before any owner read or GUC statement',async()=>{
    const [state]=await withTenant(adminCtx(base),tx=>tx.execute(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as readonly,app.current_tenant_id() as tenant,app.current_user_id() as actor`),{readOnlySnapshot:true}) as unknown as {isolation:string;readonly:string;tenant:string;actor:string}[];
    expect(state).toEqual({isolation:'repeatable read',readonly:'on',tenant:base.tenantId,actor:base.adminUserId});
  });
  it('retains the same source values while a separate transaction commits an edit',async()=>{
    const ctx=adminCtx(base);
    const read=(tx:Tx)=>tx.select({name:company.legalName}).from(company).where(eq(company.id,base.companyId));
    const result=await withTenant(ctx,async tx=>{
      const before=await read(tx);
      await owner.db.update(company).set({legalName:'Changed concurrently'}).where(eq(company.id,base.companyId));
      const after=await read(tx);
      return {before,after};
    },{readOnlySnapshot:true});
    expect(result.after).toEqual(result.before);
    expect(await withTenant(ctx,read)).toEqual([{name:'Changed concurrently'}]);
  });
  it('database rejects actual persisted writes inside the snapshot',async()=>{
    const message=await rootError(withTenant(adminCtx(base),tx=>tx.update(company).set({legalName:'Must not persist'}).where(eq(company.id,base.companyId)),{readOnlySnapshot:true}));
    expect(message).toMatch(/read-only transaction/i);
    const rows=await owner.db.select().from(company).where(eq(company.id,base.companyId));
    expect(rows[0].legalName).not.toBe('Must not persist');
  });
  it('retains RLS tenant isolation under the snapshot and leaves default transactions writable',async()=>{
    const other=await seedBase();
    const rows=await withTenant(adminCtx(base),tx=>tx.select({id:company.id}).from(company).where(and(eq(company.id,other.companyId))),{readOnlySnapshot:true});
    expect(rows).toEqual([]);
    const changed=await withTenant(adminCtx(base),tx=>tx.update(company).set({legalName:'Ordinary write'}).where(eq(company.id,base.companyId)).returning({name:company.legalName}));
    expect(changed).toEqual([{name:'Ordinary write'}]);
  });
});
