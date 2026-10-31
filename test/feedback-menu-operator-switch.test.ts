import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,asc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {operatorCustomerFeedbackMenu,setOperatorCustomerFeedbackMenu} from '../core/operator-customers';
import {feedbackBoardOpen} from '../app/(app)/feedback/board';
const FEEDBACK_MENU_SETTING='feedback.menu_enabled';
import {setTenantSetting} from '../core/tenant-settings';
import type {EntitledContext} from '../core/entitlements';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let base:Base,customer:Base,operator:SessionContext;
beforeAll(migrateTestDb);
beforeEach(async()=>{
  await resetDb();base=await seedBase();customer=await seedBase();
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:randomUUID()}).returning();
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:u.id,role:'operator',companyId:null});
  operator={tenantId:base.tenantId,userId:u.id,roles:['operator'],grants:[{role:'operator',companyId:null}]};
});
afterAll(closeAll);
const stored=()=>owner.db.select().from(schema.tenantSetting)
  .where(and(eq(schema.tenantSetting.tenantId,customer.tenantId),eq(schema.tenantSetting.key,FEEDBACK_MENU_SETTING)));
const board=async(b:Base)=>feedbackBoardOpen(await entitledCtx(b) as EntitledContext);

describe('operator Feedback menu switch',()=>{
  it('is on for an existing customer with no setting row',async()=>{
    expect(await stored()).toHaveLength(0);
    expect(await operatorCustomerFeedbackMenu(operator,customer.tenantId)).toBe(true);
    expect(await board(customer)).toBe(true);
  });

  it('an operator turns it off and on for one customer only, as a platform write with an audit event',async()=>{
    await setOperatorCustomerFeedbackMenu(operator,customer.tenantId,false);
    expect(await operatorCustomerFeedbackMenu(operator,customer.tenantId)).toBe(false);
    const [row]=await stored();
    expect(row.value).toBe(false);expect(row.source).toBe('platform');expect(row.updatedBy).toBe(operator.userId);
    expect(await board(customer)).toBe(false);
    expect(await board(base)).toBe(true);
    // Repeating the same choice records nothing new.
    await setOperatorCustomerFeedbackMenu(operator,customer.tenantId,false);
    await setOperatorCustomerFeedbackMenu(operator,customer.tenantId,true);
    expect(await board(customer)).toBe(true);
    const events=(await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,customer.tenantId),eq(schema.domainEvent.eventType,'tenant-setting.changed'))).orderBy(asc(schema.domainEvent.occurredAt)))
      .filter(e=>(e.payload as {key?:string}).key===FEEDBACK_MENU_SETTING);
    expect(events.map(e=>(e.payload as {after:boolean}).after)).toEqual([false,true]);
    expect(events.every(e=>e.actorId===operator.userId)).toBe(true);
  });

  it('customer administrators cannot read or change it, through the service or direct SQL',async()=>{
    await setOperatorCustomerFeedbackMenu(operator,customer.tenantId,false);
    await expect(setOperatorCustomerFeedbackMenu(adminCtx(customer),customer.tenantId,true)).rejects.toThrow(/operator/);
    await expect(operatorCustomerFeedbackMenu(adminCtx(customer),customer.tenantId)).rejects.toThrow(/operator/);
    await expect(setTenantSetting(await entitledCtx(customer),{key:FEEDBACK_MENU_SETTING,value:true})).rejects.toThrow();
    for(const query of [
      sql`select app.operator_set_customer_feedback_menu(${customer.tenantId}::uuid,true)`,
      sql`select app.operator_customer_feedback_menu(${customer.tenantId}::uuid)`,
    ])await expect(withTenant(adminCtx(customer),tx=>tx.execute(query))).rejects.toThrow();
    // The platform scope means the RLS write policy filters a customer's own direct write to nothing.
    await withTenant(adminCtx(customer),tx=>tx.update(schema.tenantSetting).set({value:true,source:'customer'})
      .where(and(eq(schema.tenantSetting.tenantId,customer.tenantId),eq(schema.tenantSetting.key,FEEDBACK_MENU_SETTING)))).catch(()=>undefined);
    expect((await stored())[0].value).toBe(false);
    expect(await board(customer)).toBe(false);
  });

  it('refuses a missing customer',async()=>{
    await expect(setOperatorCustomerFeedbackMenu(operator,randomUUID(),false)).rejects.toThrow(/found/);
    await expect(operatorCustomerFeedbackMenu(operator,randomUUID())).rejects.toThrow(/found/);
  });
});
