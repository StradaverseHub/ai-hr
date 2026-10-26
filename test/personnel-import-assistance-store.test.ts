/** Authored UNRUN: real owner/app-role custody and rollback; fictional headings, no provider API. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,expect,it,vi} from 'vitest';
import {withTenant} from '../db/client';
import {preparePersonnelImportAssistanceTx,claimPersonnelImportAssistanceTx,completePersonnelImportAssistanceTx,failPersonnelImportAssistanceTx,type PersonnelImportAssistanceBinding} from '../core/personnel-import-assistance-store';
import {personnelImportHeaderDigests} from '../lib/personnel-import-assistance.server';
import type {PersonnelImportHeaderProposal} from '../lib/personnel-import-assistance';
import {runAiRetentionTick} from '../scripts/ai-retention-runner';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-header-custody-secret-0123456789');await migrateTestDb();});
beforeEach(async()=>{await resetDb();base=await seedBase();});afterAll(async()=>{await closeAll();vi.unstubAllEnvs();});
const ctx=()=>adminCtx(base);
const headers=[{columnIndex:240,heading:'Full name'}];
function input(mode:'deterministic'|'ai'='deterministic'){
 return {companyId:base.companyId,operationNonce:randomUUID(),...personnelImportHeaderDigests(headers),inputDigest:'a'.repeat(64),headerIndexes:[240],mode,consent:{headersReviewed:true as const,sendHeadingsOnly:mode==='ai'}};
}
async function prepare(mode:'deterministic'|'ai'='deterministic'){
 const value=input(mode),prepared=await withTenant(ctx(),tx=>preparePersonnelImportAssistanceTx(tx,ctx(),value));
 return {value,binding:{attemptId:prepared.attemptId,attemptVersion:prepared.attemptVersion,companyId:value.companyId,sourceRevision:value.sourceRevision,registryDigest:value.registryDigest,inputDigest:value.inputDigest} satisfies PersonnelImportAssistanceBinding};
}
const result=(binding:PersonnelImportAssistanceBinding):PersonnelImportHeaderProposal=>({version:1,sourceRevision:binding.sourceRevision,registryDigest:binding.registryDigest,mappings:[{columnIndex:240,status:'mapped',field:'full_name'}]});
const rows=()=>owner.db.execute(sql`select * from public.personnel_import_assistance_attempt order by id`);
it('completes local deterministic proposals without any AI run and reopens only the same owner/revision, with no raw headings retained',async()=>{
 const {value,binding}=await prepare();await withTenant(ctx(),tx=>completePersonnelImportAssistanceTx(tx,ctx(),binding,result(binding)));
 const again=await withTenant(ctx(),tx=>preparePersonnelImportAssistanceTx(tx,ctx(),value));expect(again).toMatchObject({attemptId:binding.attemptId,state:'completed',proposal:result(binding)});
 expect(await owner.db.execute(sql`select id from public.ai_model_run`)).toHaveLength(0);const stored=await rows();expect(stored).toHaveLength(1);expect(JSON.stringify(stored)).not.toContain('Full name');expect(JSON.stringify(stored)).not.toContain('full_name');
 await expect(withTenant(ctx(),tx=>preparePersonnelImportAssistanceTx(tx,ctx(),{...value,inputDigest:'b'.repeat(64)}))).rejects.toThrow();expect(await rows()).toEqual(stored);
});
it('joins the actual own pending admission in its transaction, refuses a duplicate send, and leaves dispatch unknown after rollback of completion',async()=>{
 const {value,binding}=await prepare('ai');let runId='';await withTenant(ctx(),async tx=>{
  const [admitted]=await tx.execute<{run_id:string;allowed:boolean}>(sql`select * from app.ai_admit('personnel_import_mapping','draft','openai','fictional/header-model',100,false)`);expect(admitted.allowed).toBe(true);runId=admitted.run_id;await claimPersonnelImportAssistanceTx(tx,ctx(),binding,runId);
 });
 await expect(withTenant(ctx(),tx=>preparePersonnelImportAssistanceTx(tx,ctx(),value))).rejects.toThrow();
 const dispatched=await rows();expect(dispatched[0]).toMatchObject({state:'dispatched',ai_run_id:runId,receipt:null});
 await expect(withTenant(ctx(),tx=>completePersonnelImportAssistanceTx(tx,ctx(),binding,result(binding)))).rejects.toThrow();
 await withTenant(ctx(),tx=>tx.execute(sql`select app.ai_settle_observed(${runId}::uuid,true,10,'missing',null,null,null,null,null)`));
 await expect(withTenant(ctx(),async tx=>{await completePersonnelImportAssistanceTx(tx,ctx(),binding,result(binding));throw Error('fictional completion rollback');})).rejects.toThrow('fictional completion rollback');expect(await rows()).toEqual(dispatched);
 await withTenant(ctx(),tx=>failPersonnelImportAssistanceTx(tx,ctx(),binding));await expect(withTenant(ctx(),tx=>preparePersonnelImportAssistanceTx(tx,ctx(),value))).rejects.toThrow();expect((await rows())[0].state).toBe('failed');
});
it('refuses invented run IDs and rolls the real admission back when its durable claim fails',async()=>{
 const {binding}=await prepare('ai'),before=await rows();await expect(withTenant(ctx(),tx=>claimPersonnelImportAssistanceTx(tx,ctx(),binding,randomUUID()))).rejects.toThrow();expect(await rows()).toEqual(before);
 await expect(withTenant(ctx(),async tx=>{const [admitted]=await tx.execute<{run_id:string}>(sql`select * from app.ai_admit('personnel_import_mapping','draft','openai','fictional/header-model',100,false)`);await claimPersonnelImportAssistanceTx(tx,ctx(),{...binding,inputDigest:'b'.repeat(64)},admitted.run_id);})).rejects.toThrow();
 expect(await owner.db.execute(sql`select id from public.ai_model_run`)).toHaveLength(0);expect(await rows()).toEqual(before);
});
it('keeps source and expiry immutable to the app role, refuses expired and cross-tenant reopening, but permits own erasure',async()=>{
 const {value,binding}=await prepare(),before=await rows();await expect(withTenant(ctx(),tx=>tx.execute(sql`update public.personnel_import_assistance_attempt set expires_at=now()+interval '1 year' where id=${binding.attemptId}::uuid`))).rejects.toThrow();expect(await rows()).toEqual(before);
 const foreign=await seedBase();await expect(withTenant(adminCtx(foreign),tx=>preparePersonnelImportAssistanceTx(tx,adminCtx(foreign),value))).rejects.toThrow();expect(await rows()).toEqual(before);
 await owner.db.execute(sql`update public.personnel_import_assistance_attempt set created_at=now()-interval '20 minutes',expires_at=now()-interval '5 minutes' where id=${binding.attemptId}::uuid`);
 await expect(withTenant(ctx(),tx=>preparePersonnelImportAssistanceTx(tx,ctx(),value))).rejects.toThrow();await withTenant(ctx(),tx=>tx.execute(sql`delete from public.personnel_import_assistance_attempt where id=${binding.attemptId}::uuid`));expect(await rows()).toHaveLength(0);
});
it('refuses a held attempt immediately and leaves its state unchanged until the holder releases',async()=>{
 const {value,binding}=await prepare(),before=await rows();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
 const held=withTenant(ctx(),async tx=>{await tx.execute(sql`select id from public.personnel_import_assistance_attempt where id=${binding.attemptId}::uuid for update`);entered();await resume;});
 try{await ready;await expect(withTenant(ctx(),tx=>preparePersonnelImportAssistanceTx(tx,ctx(),value))).rejects.toThrow();expect(await rows()).toEqual(before);}finally{release();await held;}
 await withTenant(ctx(),tx=>completePersonnelImportAssistanceTx(tx,ctx(),binding,result(binding)));expect((await rows())[0].state).toBe('completed');
});
it('physically retires expired header custody without touching active custody or canonical people/events',async()=>{
 const expired=await prepare(),active=await prepare();await withTenant(ctx(),tx=>completePersonnelImportAssistanceTx(tx,ctx(),expired.binding,result(expired.binding)));
 await owner.db.execute(sql`update public.personnel_import_assistance_attempt set created_at=now()-interval '20 minutes',expires_at=now()-interval '5 minutes' where id=${expired.binding.attemptId}::uuid`);
 const before=(await rows()).find(row=>row.id===active.binding.attemptId);
 const facts=()=>owner.db.execute(sql`select (select count(*) from public.person) as people,(select count(*) from public.employment) as employments,(select count(*) from public.domain_event) as events`);
 const canonical=await facts();expect(await runAiRetentionTick(owner)).toMatchObject({importAssistance:1,backlog:false});
 expect(await rows()).toEqual([before]);expect(await facts()).toEqual(canonical);expect(await runAiRetentionTick(owner)).toMatchObject({tenants:0,importAssistance:0,backlog:false});
});
