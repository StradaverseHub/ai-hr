/** Reversible fictional-data experiment. This supplies no installation or release receipt. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);

it('compares capability statement planning while keeping live native permission outcomes',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const companies=await owner.db.insert(s.company).values(Array.from({length:10},(_,i)=>({tenantId:b.tenantId,country:'MY',legalName:'Fictional capability company '+i}))).returning();
 const users=Array.from({length:500},(_,index)=>({id:randomUUID(),index,companyId:companies[Math.floor(index/50)].id}));
 await owner.db.insert(s.appUser).values(users.map(user=>({id:user.id,tenantId:b.tenantId,workosUserId:'capability_plan_'+user.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(user=>({tenantId:b.tenantId,appUserId:user.id,role:'employee' as const,companyId:user.companyId})));
 const [group]=await owner.db.insert(s.accessGroup).values({tenantId:b.tenantId,name:'Fictional capability plan readers'}).returning();
 await owner.db.insert(s.accessGroupGrant).values({tenantId:b.tenantId,groupId:group.id,capabilityId:'workforce.view'});
 await owner.db.insert(s.accessMembership).values(users.map(user=>({tenantId:b.tenantId,groupId:group.id,userId:user.id,companyId:user.companyId})));
 const [capability]=await owner.db.select().from(s.accessCapability).where(eq(s.accessCapability.id,'workforce.view'));
 await owner.db.update(s.accessCapability).set({supported:true,bindings:[{owner:'fictional-plan-probe',operation:'read'}]}).where(eq(s.accessCapability.id,'workforce.view'));
 for(const table of ['company','app_user','role_assignment','access_group','access_group_grant','access_membership'])await owner.client.unsafe('analyze '+table);
 const signature='app.access_allowed_for_tenant(uuid,uuid,text,uuid)';
 const [original]=await owner.client<{ddl:string;body:string;attributes:Record<string,unknown>}[]>`select pg_get_functiondef(oid) as ddl,prosrc as body,to_jsonb(pg_proc)-'prosrc'-'prolang' as attributes from pg_proc where oid=${signature}::regprocedure`;
 const canonical=readFileSync(new URL('../../db/migrations/0579_configurable_access.sql',import.meta.url),'utf8');
 const functionStart=canonical.indexOf('CREATE FUNCTION app.access_allowed_for_tenant(');
 const body=canonical.slice(canonical.indexOf('AS $$',functionStart)+5,canonical.indexOf('$$;',functionStart)).trim().replace(/;$/,'');
 const plannedBody='BEGIN\n RETURN (\n '+body+'\n );\nEND;';
 expect([body,plannedBody].map(value=>value.trim().replace(/;$/,''))).toContain(original.body.trim().replace(/;$/,''));
 const start=original.ddl.indexOf('AS $function$');expect(start).toBeGreaterThan(0);
 const header=original.ddl.slice(0,start).replace('LANGUAGE plpgsql','LANGUAGE sql');
 const baseline=header+'AS $function$'+body+'$function$;';
 const candidate=header.replace('LANGUAGE sql','LANGUAGE plpgsql')+'AS $function$'+plannedBody+'$function$;';
 const context=(user:typeof users[number]):SessionContext=>({...adminCtx(b),userId:user.id,roles:['employee'],grants:[{role:'employee',companyId:user.companyId}]});
 const read=(ctx:SessionContext,companyId:string)=>withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_capability_allowed('workforce.view',${companyId}::uuid) as allowed`);return row.allowed;
 });
 const phases:Record<string,unknown>={};
 try{
  for(const phase of ['baseline','plan-reuse','baseline-after']){
   await owner.client.unsafe(phase==='plan-reuse'?candidate:baseline);
   const [attributes]=await owner.client`select to_jsonb(pg_proc)-'prosrc'-'prolang' as value from pg_proc where oid=${signature}::regprocedure`;
   expect(attributes.value).toEqual(original.attributes);
   const probes=users.filter(user=>user.index%5===0),times:number[]=[],started=performance.now();
   await Promise.all(probes.map(async user=>{
    const before=performance.now();
    for(let repeat=0;repeat<10;repeat++)expect(await read(context(user),user.companyId)).toBe(true);
    times.push(performance.now()-before);
   }));
   const elapsedMs=performance.now()-started;times.sort((a,b)=>a-b);
   const user=users[0],ctx=context(user);
   expect(await read(ctx,companies[1].id)).toBe(false);
   expect(await read(ctx,foreign.companyId)).toBe(false);
   expect(await read(adminCtx(foreign),user.companyId)).toBe(false);
   const [deny]=await owner.db.insert(s.accessUserOverride).values({tenantId:b.tenantId,userId:user.id,capabilityId:'workforce.view',companyId:user.companyId,effect:'deny'}).returning();
   try{expect(await read(ctx,user.companyId)).toBe(false);}finally{await owner.db.delete(s.accessUserOverride).where(eq(s.accessUserOverride.id,deny.id));}
   expect(await read(ctx,user.companyId)).toBe(true);
   try{await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,user.id));expect(await read(ctx,user.companyId)).toBe(false);}
   finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,user.id));}
   try{await owner.db.update(s.accessGroup).set({retiredAt:new Date()}).where(eq(s.accessGroup.id,group.id));expect(await read(ctx,user.companyId)).toBe(false);}
   finally{await owner.db.update(s.accessGroup).set({retiredAt:null}).where(eq(s.accessGroup.id,group.id));}
   try{await owner.db.update(s.accessCapability).set({supported:false}).where(eq(s.accessCapability.id,'workforce.view'));expect(await read(ctx,user.companyId)).toBe(false);}
   finally{await owner.db.update(s.accessCapability).set({supported:true}).where(eq(s.accessCapability.id,'workforce.view'));}
   await expect(withTenant(ctx,tx=>tx.execute(sql`select app.access_allowed_for_tenant(${b.tenantId}::uuid,${b.adminUserId}::uuid,'access.configure',NULL)`))).rejects.toThrow();
   phases[phase]={principalInventory:500,concurrentProbes:100,checks:1000,elapsedMs,p50ProbeMs:times[49],p95ProbeMs:times[94],maxProbeMs:times.at(-1),liveBoundaryChecks:true};
   const evidence=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
   if(evidence)writeFileSync(join(evidence,'access-capability-plan.json'),JSON.stringify({kind:'REVERSIBLE_CAPABILITY_PLAN_EXPERIMENT',releaseEligible:false,phases},null,2));
  }
 }finally{
  await owner.client.unsafe(original.ddl);
  await owner.db.update(s.accessCapability).set({supported:capability.supported,bindings:capability.bindings}).where(eq(s.accessCapability.id,'workforce.view'));
 }
},480000);
