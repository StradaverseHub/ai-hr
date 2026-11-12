/** Real native page preflight only; audited readers and commands remain separate owners. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {appUser,person,roleAssignment} from '../db/schema';
import {rewardLibraries,rewardLibraryPageAccess} from '../packs/rewards/libraries';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.restoreAllMocks());afterAll(closeAll);
async function actor(b:Base,role:'gr'|'ctro',companyId:string|null=null){
 const [p]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Fictional library '+role,primaryEmail:randomUUID()+'@example.invalid'}).returning({id:person.id});
 if(!p)throw Error('Missing fictional library person');
 const userId=await createAppUser(b.tenantId,p.id,'employee');
 const [grant]=await owner.client<{id:string}[]>`insert into reward_setup_grant(tenant_id,user_id,company_id,role,valid_from,created_by,reason)
  values(${b.tenantId}::uuid,${userId}::uuid,${companyId}::uuid,${role},'2000-01-01',${b.adminUserId}::uuid,'Fictional explicit library setup authority') returning id`;
 if(!grant)throw Error('Missing native setup grant');
 const ctx:SessionContext={...adminCtx(b),userId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return {ctx,userId,grantId:grant.id};
}
async function fixture(){const b=await seedBase();await setModule(b.tenantId,'rewards','active');return{b,gr:await actor(b,'gr'),ctro:await actor(b,'ctro')};}
function budgets(modes:{isolation:string;readonly:string;role:string}[]=[]){
 const native=database.withTenant;
 return vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,fn:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(ctx,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
  const [mode]=await tx.execute<{isolation:string;readonly:string;role:string}>(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as readonly,current_user as role`);if(!mode)throw Error('Missing native transaction mode');modes.push(mode);
  return fn(tx);
 },options));
}
async function audit(tenantId:string){return [...await owner.client`select id,event_type,payload,chain_seq,hash from domain_event where tenant_id=${tenantId}::uuid order by id`];}
async function held(tenantId:string,kind:'access'|'history',signal:AbortSignal,read:(pid:number)=>Promise<void>){
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),done=new Promise<void>(resolve=>{release=resolve;});let pid=0;
 const writer=owner.client.begin(async tx=>{
  if(kind==='access')await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+tenantId},0))`;
  else await tx`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+tenantId}))`;
  const [identity]=await tx`select pg_backend_pid() as pid`;if(!identity)throw Error('Missing held-writer identity');pid=identity.pid;entered();await done;
 });
 const abort=()=>release();signal.addEventListener('abort',abort,{once:true});
 try{await Promise.race([ready,writer.then(()=>{throw Error('Writer ended before acquiring its barrier');})]);signal.throwIfAborted();await read(pid);}
 finally{release();signal.removeEventListener('abort',abort);await writer;}
}

it('describes actual GR and CTRO (both configuration editors, board 60f1fdcd) access in RR/RO without an event or financial disclosure',async()=>{
 const f=await fixture(),before=await audit(f.b.tenantId),modes:{isolation:string;readonly:string;role:string}[]=[];budgets(modes);
 expect(await rewardLibraryPageAccess(f.gr.ctx)).toEqual({canManage:true});
 expect(await rewardLibraryPageAccess(f.ctro.ctx)).toEqual({canManage:true});
 await expect(rewardLibraryPageAccess(adminCtx(f.b))).rejects.toThrow(/not available/);
 expect(modes).toHaveLength(3);expect(modes.every(mode=>mode.isolation==='repeatable read'&&mode.readonly==='on'&&mode.role==='ai_hr_app')).toBe(true);
 expect(await audit(f.b.tenantId)).toEqual(before);
},30000);

it('finishes preflight while real Access and audit-chain writers remain held; the audited read still refuses and rolls back',async context=>{
 const f=await fixture(),before=await audit(f.b.tenantId);budgets();
 for(const kind of ['access','history'] as const)await held(f.b.tenantId,kind,context.signal,async pid=>{
  expect(await rewardLibraryPageAccess(f.gr.ctx)).toEqual({canManage:true});expect(await rewardLibraryPageAccess(f.ctro.ctx)).toEqual({canManage:true});
  const [proof]=await owner.client`select exists(select 1 from pg_locks where pid=${pid} and locktype='advisory' and granted) as held`;if(!proof)throw Error('Missing actual held-lock proof');expect(proof.held).toBe(true);
  // Behind the audit-chain key the refusal now comes from the commit-time seal, not the insert.
  expect(pgSqlState(await rewardLibraries(f.gr.ctx,'salary').then(()=>undefined,(error:unknown)=>error))).toBe('55P03');
 });
 expect(await audit(f.b.tenantId)).toEqual(before);
 expect(await rewardLibraries(f.gr.ctx,'salary')).toEqual([]);
 const after=await audit(f.b.tenantId),added=after.filter(row=>!before.some(old=>old.id===row.id));
 expect(added).toHaveLength(1);expect(added[0]).toMatchObject({event_type:'rewards-setup.libraries.viewed',payload:{kind:'salary',year:null}});
},30000);

it('re-admits native setup/login identity and refuses company-only or foreign-tenant grants with retained contexts',async()=>{
 const f=await fixture(),scoped=await actor(f.b,'gr',f.b.companyId),foreign=await seedBase();await setModule(foreign.tenantId,'rewards','active');budgets();
 await expect(rewardLibraryPageAccess(scoped.ctx)).rejects.toThrow(/not available/);
 await expect(rewardLibraryPageAccess({...adminCtx(foreign),userId:f.gr.userId,roles:['employee'],grants:[{role:'employee',companyId:null}]})).rejects.toThrow(/not available/);
 await owner.client`update reward_setup_grant set active=false where id=${f.gr.grantId}::uuid`;
 await expect(rewardLibraryPageAccess(f.gr.ctx)).rejects.toThrow(/not available/);
 await owner.client`update reward_setup_grant set active=true where id=${f.gr.grantId}::uuid`;
 expect(await rewardLibraryPageAccess(f.gr.ctx)).toEqual({canManage:true});
 await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,f.gr.userId));
 await expect(rewardLibraryPageAccess(f.gr.ctx)).rejects.toThrow(/not available/);
 await owner.db.update(appUser).set({archivedAt:null}).where(eq(appUser.id,f.gr.userId));
 expect(await rewardLibraryPageAccess(f.gr.ctx)).toEqual({canManage:true});
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,f.gr.userId));
 await expect(rewardLibraryPageAccess(f.gr.ctx)).rejects.toThrow(/not available/);
},30000);
