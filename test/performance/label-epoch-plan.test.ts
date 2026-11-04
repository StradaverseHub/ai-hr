/** Reversible native counter query experiment; no application migration or cached decision. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {pgErrorChain,pgSqlState} from '../../lib/db-error';
import {withTenant} from '../../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('preserves native criteria revisions and foreign-tenant refusals with one atomic upsert',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),count=5000;
 const [original]=await owner.client`select pg_get_functiondef(oid)as ddl,to_jsonb(p)-'prosrc' as attributes from pg_proc p where oid='app.lock_system_label_criteria(uuid,text)'::regprocedure`;
 const old=`INSERT INTO public.system_label_criteria_epoch(tenant_id,label_kind) VALUES(p_tenant,p_kind) ON CONFLICT DO NOTHING;
  UPDATE public.system_label_criteria_epoch SET revision=revision+1 WHERE tenant_id=p_tenant AND label_kind=p_kind;`;
 expect(original.ddl).toContain(old);
 const candidate=original.ddl.replace(old,`INSERT INTO public.system_label_criteria_epoch(tenant_id,label_kind,revision) VALUES(p_tenant,p_kind,1)
  ON CONFLICT(tenant_id,label_kind) DO UPDATE SET revision=system_label_criteria_epoch.revision+1;`);
 const measurements:unknown[]=[];
 const refused=async(query:Promise<unknown>,code:string,message:string)=>{
  let failure:unknown;try{await query;}catch(error){failure=error;}
  expect(pgSqlState(failure)).toBe(code);
  expect(pgErrorChain(failure).some(error=>error.code===code&&error.message===message)).toBe(true);
 };
 const revision=async()=>{const [row]=await owner.client`select revision::int from system_label_criteria_epoch where tenant_id=${b.tenantId}::uuid and label_kind='department'`;return row?.revision??0;};
 const measure=async(phase:string)=>{
  const before=await revision(),started=performance.now();
  await withTenant(adminCtx(b),tx=>tx.execute(sql`select app.lock_system_label_criteria(${b.tenantId}::uuid,'department') from generate_series(1,${count}::int)`));
  const elapsedMs=performance.now()-started;
  expect(await revision()).toBe(before+count);measurements.push({phase,elapsedMs,calls:count,exactRevisions:true});
 };
 try{
  await measure('original');await owner.client.unsafe(candidate);await measure('candidate');await measure('candidate-warm');
  const [attributes]=await owner.client`select to_jsonb(p)-'prosrc' as value from pg_proc p where oid='app.lock_system_label_criteria(uuid,text)'::regprocedure`;
  expect(attributes.value).toEqual(original.attributes);
  await refused(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.lock_system_label_criteria(${foreign.tenantId}::uuid,'department')`)),'42501','Label tenant mismatch');
  await refused(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.lock_system_label_criteria(${b.tenantId}::uuid,'invalid')`)),'23514','Invalid label criteria identity');
  await owner.client.unsafe(original.ddl);await measure('restored');
 }finally{
  await owner.client.unsafe(original.ddl);
  const [restored]=await owner.client`select pg_get_functiondef('app.lock_system_label_criteria(uuid,text)'::regprocedure)as ddl`;
  expect(restored.ddl).toBe(original.ddl);
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'label-epoch-plan.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_COUNTER_EXPERIMENT_ONLY',measurements,restored:restored.ddl===original.ddl},null,2));
 }
},180000);
