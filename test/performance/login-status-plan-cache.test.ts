/** Reversible hosted native experiment; never installs SQL on staging. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
import {withTenant} from '../../db/client';
import {sql} from 'drizzle-orm';
beforeAll(migrateTestDb);afterAll(closeAll);

it('reuses dated login plans while preserving live employment, archive, date and private-call boundaries',async()=>{
 await resetDb();const b=await seedBase();
 const users=Array.from({length:500},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),i}));
 await owner.client`insert into person(id,tenant_id,full_name) select p::uuid,${b.tenantId}::uuid,'Fictional login plan subject' from unnest(${users.map(u=>u.personId)}::text[])p`;
 await owner.client`insert into employment(id,tenant_id,person_id,company_id,hired_on,terminated_on)
  select e::uuid,${b.tenantId}::uuid,p::uuid,${b.companyId}::uuid,'2020-01-01'::date,
   case when n%5=0 then '2025-01-01'::date else null end
  from unnest(${users.map(u=>u.employmentId)}::text[],${users.map(u=>u.personId)}::text[])with ordinality x(e,p,n)`;
 await owner.client`insert into app_user(id,tenant_id,person_id,workos_user_id)
  select u::uuid,${b.tenantId}::uuid,p::uuid,'login_plan_'||u
  from unnest(${users.map(u=>u.id)}::text[],${users.map(u=>u.personId)}::text[])x(u,p)`;
 for(const name of ['person','employment','app_user'])await owner.client.unsafe('analyze '+name);
 const signature='app.login_blocked_on(uuid,date)';
 const definition=async()=>{
  const [row]=await owner.client`select pg_get_functiondef(oid)as ddl,prosrc as body,to_jsonb(pg_proc)-'prosrc'-'prolang' as attributes
   from pg_proc where oid=${signature}::regprocedure`;
  return row;
 };
 const original=await definition();expect(original.ddl).toContain('LANGUAGE sql');
 const candidate=original.ddl.replace('LANGUAGE sql','LANGUAGE plpgsql')
  .replace(original.body,'\nBEGIN\n RETURN (\n'+original.body.trim().replace(/;\s*$/,'')+'\n );\nEND;\n');
 expect(candidate).toContain('BEGIN\n RETURN (');
 const ids=users.map(u=>u.id),phases:Record<string,unknown>={};
 const read=async(user:string|null,day:string|null)=>{
  const [row]=await owner.client`select app.login_blocked_on(${user}::uuid,${day}::date)as blocked`;
  return row.blocked;
 };
 const controls=async()=>{
  const user=users[0],terminated=users[4];
  expect(await read(user.id,null)).toBe(true);
  expect(await read(null,'2026-01-01')).toBe(false);
  expect(await read(randomUUID(),'2026-01-01')).toBe(false);
  expect(await read(terminated.id,'2025-01-01')).toBe(false);
  expect(await read(terminated.id,'2025-01-02')).toBe(true);
  expect(await read(user.id,'2026-01-01')).toBe(false);
  try{
   await owner.client`update app_user set archived_at=now() where id=${user.id}::uuid`;
   expect(await read(user.id,'2026-01-01')).toBe(true);
  }finally{await owner.client`update app_user set archived_at=null where id=${user.id}::uuid`;}
  expect(await read(user.id,'2026-01-01')).toBe(false);
  try{
   await owner.client`update employment set blacklisted_at=now() where id=${user.employmentId}::uuid`;
   expect(await read(user.id,'2026-01-01')).toBe(true);
  }finally{await owner.client`update employment set blacklisted_at=null where id=${user.employmentId}::uuid`;}
  expect(await read(user.id,'2026-01-01')).toBe(false);
  await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.login_blocked_on(${user.id}::uuid,'2026-01-01'::date)`)))
   .rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
 };
 try{
  for(const phase of ['original','candidate','candidate-warm','restored']){
   if(phase==='candidate')await owner.client.unsafe(candidate);
   if(phase==='restored')await owner.client.unsafe(original.ddl);
   expect((await definition()).attributes).toEqual(original.attributes);
   await controls();
   const started=performance.now();
   const [row]=await owner.client`select count(*)filter(where app.login_blocked_on(u.id,'2026-01-01'::date))::int as blocked
    from app_user u cross join generate_series(1,100)repeated where u.id=any(${ids}::uuid[])`;
   const elapsedMs=performance.now()-started;expect(row.blocked).toBe(10000);
   phases[phase]={calls:50000,elapsedMs,blocked:row.blocked,liveBoundaryChecks:true};
  }
 }finally{
  await owner.client.unsafe(original.ddl);expect(await definition()).toEqual(original);
 }
 writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'login-plan-cache.json'),JSON.stringify({kind:'COMPONENT_ONLY',principals:500,phases,onlyDeliberateAttributeChange:'prolang/prosrc; same SQL expression and owner/ACL/configuration',originalDefinitionRestored:true},null,2));
},480000);
