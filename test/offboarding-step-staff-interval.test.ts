/** PRIVATE UNRUN real service/interval fixture. Adopt only after independent source review.
 * The module wrapper applies existing non-increasing caller bounds solely to competing native
 * writers so the test observes 55P03 rather than hanging. No permission/effect owner is mocked. */
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {boundNativeOutcomeTransactionTx} from '../core/module-native-outcome-bounds';
const mode=vi.hoisted(()=>({boundWriter:false}));
vi.mock('../core/module-gate',async()=>{const real=await vi.importActual<typeof import('../core/module-gate')>('../core/module-gate');return{...real,withLifecycleTenant:async<T>(ctx:SessionContext,work:(tx:Tx)=>Promise<T>)=>real.withLifecycleTenant(ctx,async tx=>{if(mode.boundWriter)await boundNativeOutcomeTransactionTx(tx);return work(tx);})};});
import {withOffboardingStepIntervalTx} from '../core/assistant-actions/offboarding-step-completion-source';
import {setStaff,saveStepDefs,resetStepDefs,loadHandoverDefaults,listStepDefs,undoStep} from '../packs/lifecycle/service';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner} from './harness';
import {caseCancelFixture,type CaseCancelFixture} from './helpers/offboarding-case-cancel-db-fixture';
let f:CaseCancelFixture;beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{mode.boundWriter=false;});beforeEach(async()=>{f=await caseCancelFixture();await undoStep(f.ctx,'offboarding',f.number,'resign_submit');});
async function busyWriter(work:()=>Promise<unknown>){mode.boundWriter=true;let error:unknown;try{await work();}catch(e){error=e;}finally{mode.boundWriter=false;}expect(pgSqlState(error)).toBe('55P03');}
it.each(['remove','change'] as const)('fences actual native setStaff %s during the REAL confirmation source interval, then releases it on commit',async operation=>{
 const before=await owner.db.select().from(s.lcStaff).where(eq(s.lcStaff.userId,f.ctx.userId!));
 await withTenant(f.ctx,tx=>withOffboardingStepIntervalTx(tx,f.ctx,f.caseId,'resign_submit',async()=>{await busyWriter(()=>setStaff(adminCtx(f.b),{userId:f.ctx.userId!,companyId:f.b.companyId,level:operation==='remove'?null:'agent'}));expect(await owner.db.select().from(s.lcStaff).where(eq(s.lcStaff.userId,f.ctx.userId!))).toEqual(before);}));
 await setStaff(adminCtx(f.b),{userId:f.ctx.userId!,companyId:f.b.companyId,level:null});expect(await owner.db.select().from(s.lcStaff).where(eq(s.lcStaff.userId,f.ctx.userId!))).toEqual([]);await expect(withTenant(f.ctx,tx=>withOffboardingStepIntervalTx(tx,f.ctx,f.caseId,'resign_submit',async()=>true))).rejects.toThrow();
});
it.each(['save','reset','load_defaults'] as const)('refuses competing real %s checklist configuration writes and rolls them back completely while the interval is held',async writer=>{
 const definitions=await listStepDefs(adminCtx(f.b),'offboarding'),before=await owner.db.select().from(s.lcStepDef).where(eq(s.lcStepDef.tenantId,f.b.tenantId));
 await withTenant(f.ctx,tx=>withOffboardingStepIntervalTx(tx,f.ctx,f.caseId,'resign_submit',async()=>{await busyWriter(()=>writer==='save'?saveStepDefs(adminCtx(f.b),'offboarding',definitions.map(d=>({key:d.key,phase:d.phase,label:d.label,ownerTeam:d.ownerTeam,hrms:d.hrms,rule:d.rule}))):writer==='reset'?resetStepDefs(adminCtx(f.b),'offboarding'):loadHandoverDefaults(adminCtx(f.b)));expect(await owner.db.select().from(s.lcStepDef).where(eq(s.lcStepDef.tenantId,f.b.tenantId))).toEqual(before);}));
});
it('refuses NOWAIT when a real staff writer is already holding its table and releases all partial interval locks on rollback',async()=>{
 await owner.db.transaction(async writer=>{await writer.update(s.lcStaff).set({level:'agent'}).where(eq(s.lcStaff.userId,f.ctx.userId!));let error:unknown;try{await withTenant(f.ctx,tx=>withOffboardingStepIntervalTx(tx,f.ctx,f.caseId,'resign_submit',async()=>true));}catch(e){error=e;}expect(pgSqlState(error)).toBe('55P03');});
 expect(await owner.db.transaction(tx=>tx.select({id:s.lcCase.id}).from(s.lcCase).where(eq(s.lcCase.id,f.caseId)).for('update',{noWait:true}))).toHaveLength(1);
});
