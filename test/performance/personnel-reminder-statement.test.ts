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
 const originals=await owner.client`select c.relname as name,pg_get_triggerdef(t.oid)as ddl from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.oid=any(array['public.person'::regclass,'public.employment'::regclass]) and t.tgname='assessment_reminder_touch' order by c.relname`;
 expect(originals.map(row=>row.name)).toEqual(['employment','person']);
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
 const employmentIds=ids.map(()=>randomUUID()),employmentPeople=ids.map(()=>randomUUID()),companies=ids.map((_,i)=>i%2?b.companyId:foreign.companyId);
 await owner.client`insert into person(id,tenant_id,full_name,primary_email)select p::uuid,t::uuid,'Fictional employment epoch',p||'@example.invalid' from unnest(${employmentPeople}::text[],${tenants}::text[])x(p,t)`;
 const employmentMeasure=async(phase:string)=>{
  const before=await epochs(),started=performance.now();
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,hired_on)select id::uuid,t::uuid,p::uuid,c::uuid,'2020-01-01'::date from unnest(${employmentIds}::text[],${tenants}::text[],${employmentPeople}::text[],${companies}::text[])x(id,t,p,c)`;
  const inserted=performance.now();
  await owner.client`update employment set employee_code='EP'||id::text where id=any(${employmentIds}::uuid[])`;
  const updated=performance.now();
  await owner.client`delete from employment where id=any(${employmentIds}::uuid[])`;
  const deleted=performance.now(),after=await epochs();
  for(const tenant of [b.tenantId,foreign.tenantId])expect(after.get(tenant)!-before.get(tenant)!).toBe(BigInt(7500));
  phases[phase+'.employment']={rows:ids.length,insertMs:inserted-started,updateMs:updated-inserted,deleteMs:deleted-updated,exactTenantEpochIncrements:true};
 };
 await measure('original.person');await employmentMeasure('original');
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
`);
  for(const table of ['person','employment']){
   await owner.client.unsafe('DROP TRIGGER assessment_reminder_touch ON public.'+table);
   for(const event of ['insert','update','delete'])await owner.client.unsafe('CREATE TRIGGER profile_person_reminder_'+event+' AFTER '+event.toUpperCase()+' ON public.'+table+' REFERENCING '+(event==='delete'?'OLD':'NEW')+' TABLE AS reminder_changed_rows FOR EACH STATEMENT EXECUTE FUNCTION '+fn);
  }
  const [flags]=await owner.client`select r.rolsuper,r.rolbypassrls,p.prosecdef,has_function_privilege('ai_hr_app',p.oid,'EXECUTE')as app_execute from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=${fn}::regprocedure`;
  expect(flags).toEqual({rolsuper:false,rolbypassrls:false,prosecdef:true,app_execute:false});
  await measure('statement.person');await employmentMeasure('statement');await measure('statement-warm.person');await employmentMeasure('statement-warm');
  const before=await epochs();
  await expect(owner.client.begin(async tx=>{
   await tx`insert into person(tenant_id,full_name,primary_email)values(${b.tenantId}::uuid,'Fictional rolled back person',${randomUUID()+'@example.invalid'})`;
   throw Error('intentional fixture rollback');
  })).rejects.toThrow('intentional fixture rollback');
  expect(await epochs()).toEqual(before);
  await owner.client`update person set full_name=full_name where false`;
  expect(await epochs()).toEqual(before);
 }finally{
  for(const original of originals){
   for(const event of ['insert','update','delete'])await owner.client.unsafe('DROP TRIGGER IF EXISTS profile_person_reminder_'+event+' ON public.'+original.name);
   await owner.client.unsafe('DROP TRIGGER IF EXISTS assessment_reminder_touch ON public.'+original.name);
   await owner.client.unsafe(original.ddl);
  }
  await owner.client.unsafe(`DROP FUNCTION IF EXISTS ${fn}`);
  await owner.client.unsafe(`ALTER TABLE public.performance_assessment_reminder_epoch OWNER TO "${table.owner}"`);
  await owner.client.unsafe(`DROP OWNED BY "${role}";DROP ROLE "${role}"`);
 }
 const restored=await owner.client`select c.relname as name,pg_get_triggerdef(t.oid)as ddl from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.oid=any(array['public.person'::regclass,'public.employment'::regclass]) and t.tgname='assessment_reminder_touch' order by c.relname`;
 expect(restored).toEqual(originals);await measure('restored.person');await employmentMeasure('restored');
 writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-reminder-statement.json'),JSON.stringify({kind:'COMPONENT_ONLY',phases,restrictedDefiner:true,tenantEpochExact:true,rollbackPreserved:true,triggerAndOwnerRestored:true,limitations:'Person and Employment bulk invalidation only; not canonical import throughput or million-row page acceptance.'},null,2));
},480000);
