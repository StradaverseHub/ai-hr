import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {createPayComponent,createPayComponentTx,seedPayComponentCatalog,type PayComponentInput} from '../core/pay-components';
import {planResolutionOrder} from '../core/pay-rule';
import {savePayFormula,testPayFormula,setPayFormulaActive} from '../core/pay-formula';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {pgSqlState} from '../lib/db-error';
import * as s from '../db/schema';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const input=(code:string):PayComponentInput=>({code,name:code,label:code,kind:'allowance',includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false,orpOvertime:true});
async function retainedAggregate(){const [row]=await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'RANK_SUM',name:'Retained aggregate',label:'Retained aggregate',kind:'allowance',includedInPcb:false,prorates:false,orpOvertime:false,rule:{kind:'formula',start:{ref:'fixed_allowances'},terms:[]},resolutionOrder:0}).returning();return row;}
it('derives the actual aggregate rank after native Add while preserving every retained source fact',async()=>{
 const retained=await retainedAggregate();
 const made=await createPayComponent(adminCtx(b),input('RANK_FIXED'));
 const [after]=await owner.db.select().from(s.payComponent).where(eq(s.payComponent.id,retained.id));
 expect(after).toEqual({...retained,resolutionOrder:1});
 const [added]=await owner.db.select().from(s.payComponent).where(eq(s.payComponent.id,made.id));expect(added.resolutionOrder).toBe(0);
 const [audit]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${made.id}::uuid and event_type='pay-component.created'`);expect(audit.n).toBe(1);
});
it('does not turn the finite recompute port or a write-and-restore into an arbitrary rank writer',async()=>{
 const retained=await retainedAggregate(),ctx=adminCtx(b);
 let orphan:unknown;try{await withTenant(ctx,tx=>tx.execute(sql`select app.financial_catalog_recompute_order()`));}catch(error){orphan=error;}expect(pgSqlState(orphan)).toBe('42501');
 let forged:unknown;try{await withTenant(ctx,async tx=>{await tx.transaction(async nested=>{
  await nested.execute(sql`update pay_component set resolution_order=99 where id=${retained.id}::uuid`);
  await nested.execute(sql`update pay_component set resolution_order=0 where id=${retained.id}::uuid`);
 });});}catch(error){forged=error;}expect(pgSqlState(forged)).toBe('42501');
 const [after]=await owner.db.select().from(s.payComponent).where(eq(s.payComponent.id,retained.id));expect(after).toEqual(retained);
 await expect(withTenant(ctx,tx=>tx.execute(sql`insert into app.financial_catalog_rank_open values(pg_current_xact_id(),${b.tenantId}::uuid,${ctx.userId}::uuid,gen_random_uuid())`))).rejects.toThrow();
});
it('binds native rank and audit effects to the top-level transaction through an actual savepoint',async()=>{
 const retained=await retainedAggregate(),ctx=adminCtx(b);
 const made=await withTenant(ctx,tx=>tx.transaction(nested=>createPayComponentTx(nested,ctx,input('RANK_SAVEPOINT'))));
 const [after]=await owner.db.select().from(s.payComponent).where(eq(s.payComponent.id,retained.id));expect(after.resolutionOrder).toBe(1);
 expect((await owner.db.select({id:s.payComponent.id}).from(s.payComponent).where(eq(s.payComponent.id,made.id)))).toHaveLength(1);
 const [open]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from app.financial_catalog_rank_open where tenant_id=${b.tenantId}::uuid`);expect(open.n).toBe(0);
});
it('matches the independent typed planner for explicit, builder and aggregate dependencies',async()=>{
 await setModule(b.tenantId,'typed_pay_components','active');const ctx=await entitledCtx(b);
 const employee=await hireEmployee(ctx,{person:{fullName:'Fictional Rank Formula Subject',primaryEmail:'rank-formula@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:'2026-01-01'});
 await seedPayComponentCatalog(ctx);
 const [cycle]=await owner.db.insert(s.payrollCycle).values({tenantId:b.tenantId,companyId:b.companyId,name:'Rank Monthly',code:'RANK_MONTHLY',runType:'regular'}).returning();
 const formula=await savePayFormula(ctx,{formulaId:'RANK_FORMULA',description:'Actual tested rank source',method:'write',source:'Return {#PayItem}("BASIC") / 10'});
 const tested=await testPayFormula(ctx,{...formula,context:{companyId:b.companyId,employmentId:employee.employmentId,cycleId:cycle.id,period:'2026-10',asOf:'2026-10-30',currentCode:'RANK_BUILDER',input:'1'}});
 expect(tested.passed,tested.error??'real formula activation receipt').toBe(true);expect(tested.amount).toBe('500.00');
 await setPayFormulaActive(ctx,{...formula,testId:tested.id,active:true});
 await owner.db.insert(s.payComponent).values([
  {tenantId:b.tenantId,code:'RANK_BASE',name:'base',kind:'allowance',orpOvertime:true},
  {tenantId:b.tenantId,code:'RANK_PERCENT',name:'percent',kind:'allowance',rule:{kind:'percent_of',base:'component',componentCode:' rank_base ',pct:10}},
  {tenantId:b.tenantId,code:'RANK_AST',name:'AST',kind:'allowance',rule:{kind:'formula',start:{ref:'component',code:'RANK_PERCENT'},terms:[{op:'+',operand:{ref:'fixed_allowances'}}]}},
  {tenantId:b.tenantId,code:'RANK_DEDUCTION',name:'excluded deduction',kind:'deduction',orpOvertime:true},
  {tenantId:b.tenantId,code:'RANK_ARCHIVED',name:'excluded archived',kind:'allowance',orpOvertime:true,archivedAt:new Date('2026-01-01T00:00:00Z')},
 ]);
 await createPayComponent(ctx,{...input('RANK_BUILDER'),orpOvertime:false,rule:{kind:'formula_builder',formulaId:'RANK_FORMULA',dependencies:[]}});
 const nodes=await owner.db.select().from(s.payComponent).where(eq(s.payComponent.tenantId,b.tenantId));
 const expected=planResolutionOrder(nodes.map(node=>({code:node.code,rule:node.rule,kind:node.kind,orpOvertime:node.orpOvertime,archived:node.archivedAt!==null})));expect(expected.ok).toBe(true);if(!expected.ok)throw Error('Independent graph fixture is cyclic');
 const [stored]=await owner.withTenant(adminCtx(b),tx=>tx.execute<{ranks:Record<string,number>}>(sql`select app.financial_catalog_expected_ranks() ranks`));expect(stored.ranks).toEqual(Object.fromEntries(expected.order));
});
