/** Authored UNRUN SQL-boundary proofs; no TypeScript call-stack attestation is assumed. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {withTenant,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import * as s from '../db/schema';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {cancelCaseTx,cancelCase,reopenCase} from '../packs/lifecycle/service';
import {pgSqlState} from '../lib/db-error';
import {closeAll,migrateTestDb,owner} from './harness';
import {caseCancelFixture,caseCancelSnapshot,type CaseCancelFixture} from './helpers/offboarding-case-cancel-db-fixture';
let f:CaseCancelFixture,id:string;const digest='b'.repeat(64);
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{f=await caseCancelFixture();id=randomUUID();});
const source=(tx:Tx)=>tx.execute(sql`select app.assistant_offboarding_case_cancel_source(${f.caseId}::uuid)`);
async function prepare(reason=f.human.reason){await withTenant(f.ctx,tx=>tx.execute(sql`select app.assistant_offboarding_case_cancel_review_prepare(${id}::uuid,null::uuid,${f.caseId}::uuid,null::uuid,null::uuid,${f.b.companyId}::uuid,${reason},${'a'.repeat(64)},${digest},'0123456789abcdef','fictional-wrapped','fictional-cipher')`));}
const complete=(tx:Tx,eventId:string|null)=>tx.execute(sql`select app.assistant_offboarding_case_cancel_review_complete(${id}::uuid,${digest},${f.caseId}::uuid,${eventId}::uuid)`);
async function assertRefused(work:Promise<unknown>){let error:unknown;try{await work;}catch(cause){error=cause;}expect(pgSqlState(error)).toBe('42501');}
async function native(tx:Tx){const r=await cancelCaseTx(tx,f.ctx,'offboarding',f.number,f.human.reason);if(!r.eventId)throw Error('expected new event');return r;}
it('accepts exactly the real top-transaction native effect and records actual physical case/event/history versions',async()=>{
 await prepare();const before=await caseCancelSnapshot(f);await withTenant(f.ctx,async tx=>{await lockAccessConfigurationTx(tx,f.b.tenantId);await source(tx);const r=await native(tx);await complete(tx,r.eventId);});const after=await caseCancelSnapshot(f);expect(after.c).toEqual({...before.c,status:'cancelled',cancelReason:f.human.reason});expect(after.related).toEqual(before.related);
 const [r]=await owner.db.execute(sql`select r.offboarding_cancel_case_version v,c.xmin::text cv,d.xmin::text ev,h.xmin::text hv,r.offboarding_cancel_effect_commitment commitment from app.assistant_own_leave_review r join lc_case c on c.id=r.lifecycle_case_id join domain_event d on d.id=r.lifecycle_submitted_event_id join lc_history h on h.ref_id=c.id and h.action='case.cancelled' where r.id=${id}::uuid`);expect(r).toMatchObject({v:expect.any(String),commitment:null});expect(r.v).toBe(r.cv);expect(r.v).toBe(r.ev);expect(r.v).toBe(r.hv);
});
it.each(['case_field','reason','step_edit','step_identical_update','step_extra','return_edit','return_extra','item_edit','item_extra','asset_edit','asset_extra','comment_extra'] as const)('refuses unsupported whole-effect delta %s and rolls back the native cancellation',async attack=>{
 await prepare();const before=await caseCancelSnapshot(f);await assertRefused(withTenant(f.ctx,async tx=>{await lockAccessConfigurationTx(tx,f.b.tenantId);await source(tx);const r=await native(tx);
  if(attack==='case_field')await tx.update(s.lcCase).set({workLocation:'Unreviewed location'}).where(eq(s.lcCase.id,f.caseId));
  else if(attack==='reason')await tx.update(s.lcCase).set({cancelReason:'Unreviewed reason'}).where(eq(s.lcCase.id,f.caseId));
  else if(attack==='step_edit')await tx.update(s.lcCaseStep).set({notes:'Unreviewed step'}).where(eq(s.lcCaseStep.caseId,f.caseId));
  else if(attack==='step_identical_update')await tx.execute(sql`update lc_case_step set notes=notes where case_id=${f.caseId}::uuid`);
  else if(attack==='step_extra')await tx.insert(s.lcCaseStep).values({tenantId:f.b.tenantId,caseId:f.caseId,stepKey:'unexpected-step',done:false});
  else if(attack==='return_edit')await tx.update(s.itRequisition).set({status:'cancelled'}).where(eq(s.itRequisition.id,f.reqId));
  else if(attack==='return_extra')await tx.insert(s.itRequisition).values({tenantId:f.b.tenantId,caseId:f.caseId,companyId:f.b.companyId,number:'FIC-'+randomUUID(),kind:'return',fullName:'Unexpected return',employeeNo:'UNEXPECTED'});
  else if(attack==='item_edit')await tx.update(s.itRequisitionItem).set({note:'Unreviewed item'}).where(eq(s.itRequisitionItem.requisitionId,f.reqId));
  else if(attack==='item_extra')await tx.insert(s.itRequisitionItem).values({tenantId:f.b.tenantId,requisitionId:f.reqId,itemKey:'unexpected-item',name:'Unexpected item'});
  else if(attack==='asset_edit')await tx.update(s.itAsset).set({location:'Unreviewed hardware move'}).where(eq(s.itAsset.id,f.assetId));
  else if(attack==='asset_extra')await tx.insert(s.itAsset).values({tenantId:f.b.tenantId,companyId:f.b.companyId,requisitionId:f.reqId,code:'FIC-'+randomUUID(),assetType:'laptop'});
  else await tx.insert(s.lcComment).values({tenantId:f.b.tenantId,caseId:f.caseId,authorUserId:f.ctx.userId,body:'Unreviewed extra comment'});
  await complete(tx,r.eventId);
 }));expect(await caseCancelSnapshot(f)).toEqual(before);
});
it.each(['event_duplicate','history_duplicate'] as const)('refuses %s instead of selecting a minimum candidate',async attack=>{
 await prepare();const before=await caseCancelSnapshot(f);await assertRefused(withTenant(f.ctx,async tx=>{await lockAccessConfigurationTx(tx,f.b.tenantId);await source(tx);const r=await native(tx);
  if(attack==='event_duplicate')await appendEvent(tx,{tenantId:f.b.tenantId,aggregateType:'lifecycle-case',aggregateId:f.caseId,eventType:'lifecycle-case.cancelled',actor:actorOf(f.ctx),subjectEmploymentId:null,payload:{action:'case.cancelled',number:f.number}});
  else await tx.insert(s.lcHistory).values({tenantId:f.b.tenantId,refType:'case',refId:f.caseId,action:'case.cancelled',actorUserId:f.ctx.userId,detail:{reason:f.human.reason}});
  await complete(tx,r.eventId);
 }));expect(await caseCancelSnapshot(f)).toEqual(before);
});
it.each(['extra_payload','wrong_number','wrong_history_reason'] as const)('refuses forged semantic evidence %s even when final case fields match',async attack=>{
 await prepare();const before=await caseCancelSnapshot(f);await assertRefused(withTenant(f.ctx,async tx=>{await lockAccessConfigurationTx(tx,f.b.tenantId);await source(tx);
  await tx.update(s.lcCase).set({status:'cancelled',cancelReason:f.human.reason}).where(eq(s.lcCase.id,f.caseId));await tx.insert(s.lcHistory).values({tenantId:f.b.tenantId,refType:'case',refId:f.caseId,action:'case.cancelled',actorUserId:f.ctx.userId,detail:{reason:attack==='wrong_history_reason'?'Different reason':f.human.reason}});
  const eventId=randomUUID();await appendEvent(tx,{id:eventId,tenantId:f.b.tenantId,aggregateType:'lifecycle-case',aggregateId:f.caseId,eventType:'lifecycle-case.cancelled',actor:actorOf(f.ctx),subjectEmploymentId:null,payload:{action:'case.cancelled',number:attack==='wrong_number'?'OFB-WRONG':f.number,...(attack==='extra_payload'?{unreviewed:true}:{})}});await complete(tx,eventId);
 }));expect(await caseCancelSnapshot(f)).toEqual(before);
});
it('refuses committed historical event substitution and released-child-SAVEPOINT adoption',async()=>{
 await cancelCase(f.ctx,'offboarding',f.number,f.human.reason);const [old]=await owner.db.select({id:s.domainEvent.id}).from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,f.caseId),eq(s.domainEvent.eventType,'lifecycle-case.cancelled')));await reopenCase(f.ctx,'offboarding',f.number);await prepare();const before=await caseCancelSnapshot(f);
 await assertRefused(withTenant(f.ctx,async tx=>{await lockAccessConfigurationTx(tx,f.b.tenantId);await source(tx);await native(tx);await complete(tx,old.id);}));expect(await caseCancelSnapshot(f)).toEqual(before);
 await assertRefused(withTenant(f.ctx,async tx=>{await lockAccessConfigurationTx(tx,f.b.tenantId);await source(tx);await tx.execute(sql`savepoint case_cancel_child`);const r=await native(tx);await tx.execute(sql`release savepoint case_cancel_child`);await complete(tx,r.eventId);}));expect(await caseCancelSnapshot(f)).toEqual(before);
});
it.each(['step','return','item','asset','comment'] as const)('fences actual concurrent %s membership through immediate parent FKs and releases it at commit',async member=>{
 await withTenant(f.ctx,async tx=>{await lockAccessConfigurationTx(tx,f.b.tenantId);await source(tx);let error:unknown;try{await withTenant(f.ctx,async other=>{await other.execute(sql`set local lock_timeout='100ms'`);
  if(member==='step')await other.insert(s.lcCaseStep).values({tenantId:f.b.tenantId,caseId:f.caseId,stepKey:'race-step',done:false});
  else if(member==='return')await other.insert(s.itRequisition).values({tenantId:f.b.tenantId,caseId:f.caseId,companyId:f.b.companyId,number:'RACE-'+randomUUID(),kind:'return',fullName:'Concurrent return',employeeNo:'RACE'});
  else if(member==='item')await other.insert(s.itRequisitionItem).values({tenantId:f.b.tenantId,requisitionId:f.reqId,itemKey:'race-item',name:'Concurrent item'});
  else if(member==='asset')await other.insert(s.itAsset).values({tenantId:f.b.tenantId,companyId:f.b.companyId,requisitionId:f.reqId,code:'RACE-'+randomUUID(),assetType:'laptop'});
  else await other.insert(s.lcComment).values({tenantId:f.b.tenantId,caseId:f.caseId,authorUserId:f.ctx.userId,body:'Concurrent comment'});
 });}catch(e){error=e;}expect(pgSqlState(error)).toBe('55P03');});
 await withTenant(f.ctx,tx=>tx.insert(s.lcCaseStep).values({tenantId:f.b.tenantId,caseId:f.caseId,stepKey:'after-interval',done:false}));
});
it('refuses actual row-writer/review contention NOWAIT and releases its case/related interval on failure',async()=>{
 await prepare();await owner.db.transaction(async held=>{await held.select({id:s.itRequisition.id}).from(s.itRequisition).where(eq(s.itRequisition.id,f.reqId)).for('update');let error:unknown;try{await withTenant(f.ctx,source);}catch(e){error=e;}expect(pgSqlState(error)).toBe('55P03');});
 await owner.db.transaction(async held=>{await held.execute(sql`select id from app.assistant_own_leave_review where id=${id}::uuid for update`);let error:unknown;try{await withTenant(f.ctx,tx=>tx.execute(sql`select app.assistant_offboarding_case_cancel_review_read(${id}::uuid)`));}catch(e){error=e;}expect(pgSqlState(error)).toBe('55P03');});
 expect(await owner.db.transaction(tx=>tx.select({id:s.lcCase.id}).from(s.lcCase).where(eq(s.lcCase.id,f.caseId)).for('update',{noWait:true}))).toHaveLength(1);
});
it('enforces native normalized UTF-16 reason bounds in the definer owner too',async()=>{for(const bad of ['','\t\n','\u00a0','🙂'.repeat(251)]){await assertRefused(prepare(bad));}await prepare('🙂'.repeat(250));});
