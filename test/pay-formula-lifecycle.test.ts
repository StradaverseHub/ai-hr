import {randomUUID} from 'node:crypto';
import {parsePayFormula,type FormulaProgram} from '../lib/pay-formula-language';
/** Immutable evidence and native catalog activation, exercised through the public services. */
import {sql,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {seedPayComponentCatalog,upsertPayComponent,listPayComponents,deletePayComponent,PayComponentInUseError} from '../core/pay-components';
import {savePayFormula,testPayFormula,setPayFormulaActive,getPayFormula,deletePayFormula,loadActiveFormulaProgramTx,payFormulaOptions,saveFormulaAccumulationGroup} from '../core/pay-formula';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import type {PayFormulaContext} from '../lib/pay-formula-model';
let base:Base,ctx:SessionContext,context:PayFormulaContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');ctx=await entitledCtx(base);
 const employee=await hireEmployee(ctx,{person:{fullName:'Fictional Formula Employee',primaryEmail:'formula-lifecycle@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:'2026-01-01'});await seedPayComponentCatalog(ctx);
 const [cycle]=await owner.db.insert(schema.payrollCycle).values({tenantId:base.tenantId,companyId:base.companyId,name:'Formula Monthly',code:'FORMULA',runType:'regular'}).returning();
 context={companyId:base.companyId,employmentId:employee.employmentId,cycleId:cycle.id,period:'2026-10',asOf:'2026-10-30',currentCode:'OVERTIME',input:'2'};
});
const settings={name:'Fictional Formula Item',label:'Formula item',kind:'allowance' as const,includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false};
async function saved(formulaId='SAMPLE',source='Return 1.005'){return savePayFormula(ctx,{formulaId,description:'Fictional lifecycle proof',method:'write',source});}
async function activated(formulaId='SAMPLE',source='Return {#Rounding}(1.005, 2)'){const s=await saved(formulaId,source),t=await testPayFormula(ctx,{...s,context});expect(t.passed,t.error??'successful receipt').toBe(true);await setPayFormulaActive(ctx,{...s,testId:t.id,active:true});return {...s,test:t};}
it('requires an exact successful saved revision and retains the old active revision through draft edits',async()=>{
 const s=await saved();await expect(setPayFormulaActive(ctx,{...s,active:true})).rejects.toThrow(/Test/);
 const t=await testPayFormula(ctx,{...s,context});expect(t.amount).toBe('1.01');await setPayFormulaActive(ctx,{...s,testId:t.id,active:true});
 const newer=await savePayFormula(ctx,{id:s.id,expectedRevisionId:s.revisionId,formulaId:'SAMPLE',description:'New saved version',method:'conditions',source:'Return 2'});
 const view=await getPayFormula(ctx,s.id);expect(view?.activeRevisionId).toBe(s.revisionId);expect(view?.versions).toHaveLength(2);
 await expect(setPayFormulaActive(ctx,{...newer,testId:t.id,active:true})).rejects.toThrow(/successful test/);
 await expect(testPayFormula(ctx,{...s,context})).rejects.toThrow(/Save/);
});
it('only offers tested and active formulas for new Pay Item assignments', async () => {
 const formula = await saved('PICKABLE', 'Return 25');
 const offered = async () => (await payFormulaOptions(ctx)).activeFormulas.map(option => option.formulaId);
 expect(await offered()).not.toContain('PICKABLE');
 const receipt = await testPayFormula(ctx, { ...formula, context });
 expect(receipt.passed).toBe(true);
 expect(await offered()).not.toContain('PICKABLE');
 await setPayFormulaActive(ctx, { ...formula, active: true, testId: receipt.id });
 expect(await offered()).toContain('PICKABLE');
 await upsertPayComponent(ctx, { ...settings, code: 'PICKED', rule: { kind: 'formula_builder', formulaId: 'PICKABLE', dependencies: [] } });
 expect((await listPayComponents(ctx)).find(item => item.code === 'PICKED')?.rule).toMatchObject({ formulaId: 'PICKABLE' });
 await setPayFormulaActive(ctx, { id: formula.id, active: false });
 expect(await offered()).not.toContain('PICKABLE');
 expect((await listPayComponents(ctx)).find(item => item.code === 'PICKED')?.rule).toMatchObject({ formulaId: 'PICKABLE' });
});
it('binds server dependencies and locks a used identity while retaining receipts after deactivation',async()=>{
 const s=await activated('LINKED','Return {#PayItem}("BASIC") / 10');
 await upsertPayComponent(ctx,{...settings,code:'BUILDER',rule:{kind:'formula_builder',formulaId:'LINKED',dependencies:['FORGED']}});
 const row=(await listPayComponents(ctx)).find(p=>p.code==='BUILDER')!;expect(row.rule).toMatchObject({kind:'formula_builder',formulaId:'LINKED',dependencies:['BASIC']});
 await expect(savePayFormula(ctx,{id:s.id,expectedRevisionId:s.revisionId,formulaId:'RENAMED',description:'Cannot rename',method:'write',source:'Return 2'})).rejects.toThrow();
 await expect(deletePayComponent(ctx,row.id)).rejects.toBeInstanceOf(PayComponentInUseError);
 await expect(deletePayFormula(ctx,{id:s.id,reason:'Cannot erase a used formula'})).rejects.toThrow(/retained/);
 await setPayFormulaActive(ctx,{id:s.id,active:false});await expect(withTenant(ctx,tx=>loadActiveFormulaProgramTx(tx,ctx,'LINKED'))).rejects.toThrow(/inactive/);
 await upsertPayComponent(ctx,{...settings,code:'BUILDER',name:'Updated inactive display name',rule:row.rule});
 const view=await getPayFormula(ctx,s.id);expect(view?.status).toBe('inactive');expect(view?.tests.some(t=>t.id===s.test.id)).toBe(true);expect(view?.usage.map(u=>u.id)).toContain(row.id);
});
it('rejects dependency changes after a test and exposes no private receipt after source-category denial',async()=>{
 await saveFormulaAccumulationGroup(ctx,{code:'GROSS',members:['BASIC']});const s=await saved('GROUPED','Return {#Accumulation}("GROSS")');const t=await testPayFormula(ctx,{...s,context});expect(t.passed,t.error??'test').toBe(true);
 await saveFormulaAccumulationGroup(ctx,{code:'GROSS',members:['BASIC','OVERTIME']});await expect(setPayFormulaActive(ctx,{...s,testId:t.id,active:true})).rejects.toThrow(/Dependencies changed/);
 await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:base.tenantId,companyId:base.companyId,permissionKey:'report.read.compensation',role:'hr_admin',allowed:false});
 expect((await getPayFormula(ctx,s.id))?.tests).toEqual([]);
});
it('refuses immutable receipt mutation and tenant-forged evidence through the app role',async()=>{
 const s=await activated();await expect(withTenant(ctx,tx=>tx.execute(sql`update pay_formula_test set amount='999' where id=${s.test.id}::uuid`))).rejects.toThrow();
 await expect(withTenant(ctx,tx=>tx.execute(sql`delete from pay_formula_revision where id=${s.revisionId}::uuid`))).rejects.toThrow();
 const other=await seedBase();await expect(withTenant({...ctx,tenantId:other.tenantId},tx=>tx.execute(sql`insert into pay_formula_event(tenant_id,formula_id,kind,actor_id) values(${other.tenantId}::uuid,${s.id}::uuid,'deactivated',${base.adminUserId}::uuid)`))).rejects.toThrow();
 expect((await owner.db.select().from(schema.payFormulaRevision).where(eq(schema.payFormulaRevision.id,s.revisionId))).length).toBe(1);
});

it('refuses reserved placeholders in native written and visual saves without persisting formula identities',async()=>{
 const sources=['If {#EmployeeProfile}("companyId") = "{#MISSING:Company}" Then\nReturn 9\nElse\nReturn 0\nEnd If',"' {#missing:Company}\nReturn 9",'Dim Text As String = "{#MiSsInG:Company}"\nReturn 9'];
 for(const [index,source] of sources.entries())await expect(saved('UNFINISHED_'+index,source)).rejects.toThrow(/Complete every reserved MISSING/);
 const program:FormulaProgram={version:1,statements:[{kind:'comment',text:'{#MISSING:Company}',loc:{line:1,column:1}},...parsePayFormula('Return 9').statements]};
 await expect(savePayFormula(ctx,{formulaId:'VISUAL_UNFINISHED',description:'Unfinished visual comment',method:'conditions',source:'Return 9',program})).rejects.toThrow(/Complete every reserved MISSING/);
 expect(await owner.db.select().from(schema.payFormula)).toEqual([]);expect(await owner.db.select().from(schema.payFormulaRevision)).toEqual([]);
});
it('refuses an already-retained incomplete source at native test, activation and active payroll loading even with a clean AST and old successful receipt',async()=>{
 const good=await activated('RETAINED_SOURCE','Return 9');
 const [revision]=await owner.db.select().from(schema.payFormulaRevision).where(eq(schema.payFormulaRevision.id,good.revisionId));
 const [receipt]=await owner.db.select().from(schema.payFormulaTest).where(eq(schema.payFormulaTest.id,good.test.id));
 const revisionId=randomUUID(),testId=randomUUID(),source="' Retained unfinished {#MISSING:Company}\nReturn 9";
 // Reconstruct a pre-guard revision through the app fixture transaction, retaining immutable originals.
 // Intentionally clean AST isolates the raw retained-source guard from the independent AST guard.
 await withTenant(ctx,async tx=>{
  await tx.insert(schema.payFormulaRevision).values({...revision,id:revisionId,ordinal:revision.ordinal+1,source});
  await tx.insert(schema.payFormulaTest).values({...receipt,id:testId,revisionId});
  await tx.insert(schema.payFormulaEvent).values({tenantId:base.tenantId,formulaId:good.id,revisionId,testId,kind:'activated',detail:{fixture:'retained pre-guard source'},actorId:ctx.userId!});
 });
 await expect(testPayFormula(ctx,{id:good.id,revisionId,context})).rejects.toThrow(/Complete every reserved MISSING/);
 await expect(setPayFormulaActive(ctx,{id:good.id,revisionId,testId,active:true})).rejects.toThrow(/Complete every reserved MISSING/);
 await expect(withTenant(ctx,tx=>loadActiveFormulaProgramTx(tx,ctx,'RETAINED_SOURCE',base.companyId))).rejects.toThrow(/Complete every reserved MISSING/);
 expect((await owner.db.select().from(schema.payFormulaRevision).where(eq(schema.payFormulaRevision.id,revisionId)))[0].source).toBe(source);expect(await owner.db.select().from(schema.payFormulaTest)).toHaveLength(2);
});
it('saves, tests and activates a completed formula containing ordinary MISSING words',async()=>{
 const good=await activated('COMPLETED_MISSING_WORD','Dim Note As String = "MISSING is an ordinary word"\n\' MISSING documentation\nReturn 9');
 expect(good.test.amount).toBe('9');expect((await withTenant(ctx,tx=>loadActiveFormulaProgramTx(tx,ctx,'COMPLETED_MISSING_WORD',base.companyId))).revisionId).toBe(good.revisionId);
});
