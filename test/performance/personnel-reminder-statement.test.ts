/** Disposable native experiment for the epoch-upsert hotspot seen in retained fixture setup. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('groups reminder invalidation per statement with exact per-tenant row revisions and restricted owner authority',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const role='epoch_profile_'+randomUUID().replaceAll('-',''),fn='app.performance_profile_person_reminder()';
 const [initial]=await owner.client`select pg_get_triggerdef(oid)as ddl from pg_trigger where tgrelid='public.person'::regclass and tgname='assessment_reminder_touch'`;
 const [table]=await owner.client`select pg_get_userbyid(relowner)as owner from pg_class where oid='public.performance_assessment_reminder_epoch'::regclass`;
 expect(table.owner).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
 const phases:Record<string,unknown>={},ids=Array.from({length:5000},()=>randomUUID()),tenants=ids.map((_,i)=>i%2?b.tenantId:foreign.tenantId);
 const epochs=async()=>{
  const rows=await owner.client`select tenant_id,revision::text from performance_assessment_reminder_epoch where tenant_id=any(${[b.tenantId,foreign.tenantId]}::uuid[]) and scope_id='00000000-0000-0000-0000-000000000000' order by tenant_id`;
  return new Map(rows.map(row=>[row.tenant_id,BigInt(row.revision)]));
 };
 const measure=async(phase:string)=>{
  const before=await epochs(),started=performance.now();
  await owner.client`insert into person(id,tenant_id,full_name,primary_email)select id::uuid,t::uuid,'Fictional epoch profile',id||'@example.invalid' from unnest(${ids}::text[],${tenants}::text[])x(id,t)`;
  const inserted=performance.now();
  await owner.client`update person set full_name='Fictional epoch profile edited' where id=any(${ids}::uuid[])`;
  const updated=performance.now();
  await owner.client`delete from person where id=any(${ids}::uuid[])`;
  const deleted=performance.now(),after=await epochs();
  for(const tenant of [b.tenantId,foreign.tenantId])expect(after.get(tenant)!-before.get(tenant)!).toBe(BigInt(7500));
  phases[phase]={rows:ids.length,insertMs:inserted-started,updateMs:updated-inserted,deleteMs:deleted-updated,exactTenantEpochIncrements:true};
 };
 await measure('original');
 await owner.client.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
 try{
  await owner.client.unsafe(`GRANT USAGE,CREATE ON SCHEMA public,app TO "${role}"`);
  await owner.client.unsafe(`ALTER TABLE public.performance_assessment_reminder_epoch OWNER TO "${role}"`);
  await owner.client.unsafe(`CREATE FUNCTION ${fn} RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
   BEGIN
    INSERT INTO public.performance_assessment_reminder_epoch(tenant_id,scope_id,revision)
    SELECT tenant_id,'00000000-0000-0000-0000-000000000000'::uuid,count(*) FROM reminder_changed_rows WHERE tenant_id IS NOT NULL GROUP BY tenant_id ORDER BY tenant_id
    ON CONFLICT(tenant_id,scope_id)DO UPDATE SET revision=performance_assessment_reminder_epoch.revision+EXCLUDED.revision;
    RETURN NULL;
   END;$body$;
   REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC,ai_hr_app;
   ALTER FUNCTION ${fn} OWNER TO "${role}";
   DROP TRIGGER assessment_reminder_touch ON public.person;
   CREATE TRIGGER profile_person_reminder_insert AFTER INSERT ON public.person REFERENCING NEW TABLE AS reminder_changed_rows FOR EACH STATEMENT EXECUTE FUNCTION ${fn};
   CREATE TRIGGER profile_person_reminder_update AFTER UPDATE ON public.person REFERENCING NEW TABLE AS reminder_changed_rows FOR EACH STATEMENT EXECUTE FUNCTION ${fn};
   CREATE TRIGGER profile_person_reminder_delete AFTER DELETE ON public.person REFERENCING OLD TABLE AS reminder_changed_rows FOR EACH STATEMENT EXECUTE FUNCTION ${fn};`);
  const [flags]=await owner.client`select r.rolsuper,r.rolbypassrls,p.prosecdef,has_function_privilege('ai_hr_app',p.oid,'EXECUTE')as app_execute from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=${fn}::regprocedure`;
  expect(flags).toEqual({rolsuper:false,rolbypassrls:false,prosecdef:true,app_execute:false});
  await measure('statement');await measure('statement-warm');
  const before=await epochs();
  await expect(owner.client.begin(async tx=>{
   await tx`insert into person(tenant_id,full_name,primary_email)values(${b.tenantId}::uuid,'Fictional rolled back person',${randomUUID()+'@example.invalid'})`;
   throw Error('intentional fixture rollback');
  })).rejects.toThrow('intentional fixture rollback');
  expect(await epochs()).toEqual(before);
  await owner.client`update person set full_name=full_name where false`;
  expect(await epochs()).toEqual(before);
 }finally{
  for(const event of ['insert','update','delete'])await owner.client.unsafe('DROP TRIGGER IF EXISTS profile_person_reminder_'+event+' ON public.person');
  await owner.client.unsafe('DROP TRIGGER IF EXISTS assessment_reminder_touch ON public.person');
  await owner.client.unsafe(initial.ddl);
  await owner.client.unsafe(`DROP FUNCTION IF EXISTS ${fn}`);
  await owner.client.unsafe(`ALTER TABLE public.performance_assessment_reminder_epoch OWNER TO "${table.owner}"`);
  await owner.client.unsafe(`DROP OWNED BY "${role}";DROP ROLE "${role}"`);
 }
 const [restored]=await owner.client`select pg_get_triggerdef(oid)as ddl from pg_trigger where tgrelid='public.person'::regclass and tgname='assessment_reminder_touch'`;
 expect(restored.ddl).toBe(initial.ddl);await measure('restored');
 writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-reminder-statement.json'),JSON.stringify({kind:'COMPONENT_ONLY',phases,restrictedDefiner:true,tenantEpochExact:true,rollbackPreserved:true,triggerAndOwnerRestored:true,limitations:'Person bulk invalidation only; not employment/import or million-row query acceptance.'},null,2));
},480000);
