/**
 * Read paths that run on ordinary page renders never take the tenant's exclusive Access lock (staging, 11 November 2026).
 *
 * The shell bell runs on every authenticated render. For an administrator with pending profile-change requests its
 * profile owner (core/profile.ts actionableProfileChangeIds) took the exclusive Access lock and the profile-policy
 * write lock and then re-checked decision authority request by request, with FOR UPDATE row locks, all under that
 * exclusive hold. After the deploy restart every open tab re-rendered at once on a CPU-starved box.
 *
 * After the deploy restart the Rewards Libraries page refused with 55P03 on the per-tenant Access lock while other
 * pages of the same tenant timed out in shared mode. The Rewards setup views (Salary structures, Bonus matrices,
 * PAT inputs, the plan choosers and their exports) ran inside setupTenant, the setup COMMAND wrapper, so every view
 * held the exclusive Access lock for its whole N+1 read: one authority check, version row, plan usage and lock state
 * per library version, per company for PAT. On a CPU-starved two-core box that read takes many seconds, every other
 * caller in the tenant waits behind it, and each later view queues one more exclusive request that also stops every
 * new shared caller (DESIGN E1) until it is granted or gives up.
 *
 * Real PostgreSQL through the repository harness. The starved box is modelled by delaying every statement of the
 * Rewards viewer's own transactions; nothing else is mocked. Ordinary callers run the public shared-lock API in
 * short transactions with a 1 s lock wait, the way an employee page or clock-in meets the Access lock.
 */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {person,profileChangeRequest} from '../db/schema';
import {hireEmployee} from '../core/org';
import {pendingProfileTaskMetadata} from '../core/profile';
import * as profilePolicy from '../core/profile-edit-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {pgSqlState} from '../lib/db-error';
import {confirmRewardLibrary,rewardLibraries,rewardLibraryForExport,rewardPlanLibraryChoices,saveRewardLibrary,submitRewardLibrary} from '../packs/rewards/libraries';
import {rewardPatExport,rewardPatInputs,rewardPlanCompanyChoices} from '../packs/rewards/pat-inputs';
import {setupGrades} from './rewards-setup-fixture';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const YEAR=2026,LIBRARIES=16,STATEMENT_DELAY_MS=30,MAX_EXCLUSIVE_HOLD_MS=1000;
let raw:postgres.Sql;
beforeAll(async()=>{await migrateTestDb();raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:4,onnotice:()=>{}});});
beforeEach(resetDb);afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{await raw.end({timeout:5});await closeAll();});

/** A person-backed login holding the explicit tenant-wide Group Rewards setup grant. */
async function groupRewardsLogin(b:Base,label:string):Promise<SessionContext>{
 const [p]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Fictional Group Rewards '+label,primaryEmail:randomUUID()+'@example.invalid'}).returning({id:person.id});
 if(!p)throw Error('Missing fictional Rewards person');
 const userId=await createAppUser(b.tenantId,p.id,'employee');
 await owner.client`insert into reward_setup_grant(tenant_id,user_id,company_id,role,valid_from,created_by,reason)
  values(${b.tenantId}::uuid,${userId}::uuid,null,'gr','2000-01-01',${b.adminUserId}::uuid,'Fictional explicit Rewards setup authority')`;
 return {...adminCtx(b),userId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
}

/** A populated library list: LIBRARIES salary structures, the first independently confirmed. */
async function populatedRewards(){
 const b=await seedBase();await setModule(b.tenantId,'rewards','active');
 const ctx=await groupRewardsLogin(b,'viewer'),checker=await groupRewardsLogin(b,'checker'),grades=await setupGrades(ctx);
 const ids:string[]=[];
 for(let n=0;n<LIBRARIES;n++)ids.push(await saveRewardLibrary(ctx,{libraryId:null,versionId:null,expectedLock:0,name:`Fictional salary structure ${String(n+1).padStart(2,'0')}`,year:YEAR,tags:[],groupDefault:false,previousLibraryId:null,
  data:{kind:'salary',rows:grades.map(g=>({...g,minimumCents:g.grade==='23'?null:100000,midpointCents:g.grade==='23'?null:500000,maximumCents:g.grade==='23'?null:1000000}))},reason:'Fictional reviewed salary structure'}));
 const confirmed=ids[0];
 if(!confirmed)throw Error('Missing fictional library');
 await submitRewardLibrary(ctx,confirmed,1);await confirmRewardLibrary(checker,confirmed,2);
 return {b,ctx,confirmed};
}

/** The viewer's own transactions on a starved box: every statement, the Access lock request included, waits first
 * (the transaction's own drizzle session, which db/workload.ts also instruments to cancel statements).
 * Each transaction also records the Access lock mode it ended with. */
function starvedViewer(userId:string,modes:string[]){
 const native=database.withTenant;
 return vi.spyOn(database,'withTenant').mockImplementation(<T,>(ctx:SessionContext,fn:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(ctx,ctx.userId!==userId?fn:async tx=>{
  // Every statement of this transaction, raw SQL and query builders alike, goes through its session's prepared queries.
  type Prepared={execute:(...args:unknown[])=>Promise<unknown>};
  const session=(tx as unknown as {session:{prepareQuery:(...args:unknown[])=>Prepared}}).session,prepare=session.prepareQuery.bind(session);
  session.prepareQuery=(...args)=>{const prepared=prepare(...args),execute=prepared.execute.bind(prepared);
   prepared.execute=async(...values)=>{await pause(STATEMENT_DELAY_MS);return execute(...values);};return prepared;};
  const result=await fn(tx);
  const [mode]=await tx.execute<{mode:string|null}>(sql`select app.access_lock_mode_held(${ctx.tenantId}::uuid) as mode`);
  modes.push(mode?.mode??'none');
  return result;
 },options));
}

/** Independent observer: every granted hold of the tenant's Access key, by backend transaction and mode. */
function accessLockSampler(tenantId:string){
 const holds=new Map<string,{mode:string;first:number;last:number}>();let sampling=true;
 const loop=(async()=>{
  while(sampling){
   const rows=await raw<{pid:number;xact:string;mode:string}[]>`select l.pid,a.xact_start::text as xact,l.mode
    from pg_catalog.pg_locks l join pg_catalog.pg_stat_activity a on a.pid=l.pid
    cross join (select hashtextextended(${'access-configuration:'+tenantId},0) as k) target
    where l.locktype='advisory' and l.granted and l.objsubid=1 and a.xact_start is not null
     and l.database=(select oid from pg_catalog.pg_database where datname=current_database())
     and l.classid::bigint=((target.k>>32)&4294967295) and l.objid::bigint=(target.k&4294967295)`;
   const now=performance.now();
   for(const r of rows){const id=`${r.pid}|${r.xact}|${r.mode}`;const h=holds.get(id)??{mode:r.mode,first:now,last:now};h.last=now;holds.set(id,h);}
   await pause(10);
  }
 })();
 return async()=>{
  sampling=false;await loop;
  const all=[...holds.values()].map(h=>({mode:h.mode,ms:Math.round(h.last-h.first)}));
  const exclusive=all.filter(h=>h.mode==='ExclusiveLock'),shared=all.filter(h=>h.mode==='ShareLock');
  return {exclusiveHolds:exclusive.length,maxExclusiveMs:Math.max(0,...exclusive.map(h=>h.ms)),sharedHolds:shared.length,maxSharedMs:Math.max(0,...shared.map(h=>h.ms))};
 };
}

/** Ordinary tenant work meeting the Access lock in shared mode with a 1 s wait, as an employee page or clock-in does. */
async function ordinaryCaller(b:Base){
 const started=performance.now();
 try{
  await database.withTenant(adminCtx(b),async tx=>{await tx.execute(sql`set local lock_timeout='1000ms'`);await lockAccessConfigurationTx(tx,b.tenantId);});
  return {ok:true as const,ms:performance.now()-started};
 }catch(error){return {ok:false as const,code:pgSqlState(error)??'unknown',ms:performance.now()-started};}
}

it('holds no exclusive Access lock while two starved Libraries views run beside ordinary shared callers',async()=>{
 const {b,ctx}=await populatedRewards(),modes:string[]=[];
 const [{count:eventsBefore}]=await raw<{count:number}[]>`select count(*)::int as count from domain_event where tenant_id=${b.tenantId}::uuid and event_type='rewards-setup.libraries.viewed'`;
 starvedViewer(ctx.userId!,modes);
 const stop=accessLockSampler(b.tenantId);
 // The owner opens Salary structures and, while it is slow, opens it again (a reload or the Bonus matrices tab).
 const views=Promise.all([rewardLibraries(ctx,'salary'),pause(150).then(()=>rewardLibraries(ctx,'salary'))]);
 let viewing=true;void views.finally(()=>{viewing=false;});
 const callers:ReturnType<typeof ordinaryCaller>[]=[];
 await pause(100);
 while(viewing){callers.push(ordinaryCaller(b));await pause(100);}
 const [first,second]=await views,outcomes=await Promise.all(callers),locks=await stop();
 const refused=outcomes.filter(o=>!o.ok);
 console.log('[access-lock-rewards-view]',JSON.stringify({...locks,callers:outcomes.length,refused:refused.length,
  refusedCodes:[...new Set(refused.map(o=>o.code))],slowestCallerMs:Math.round(Math.max(0,...outcomes.map(o=>o.ms))),viewModes:modes}));
 // No exclusive hold beyond the bound, and no ordinary caller refused while the views run.
 expect(locks.maxExclusiveMs).toBeLessThanOrEqual(MAX_EXCLUSIVE_HOLD_MS);
 expect(outcomes.length).toBeGreaterThan(3);
 expect(refused).toEqual([]);
 expect(modes).toEqual(['S','S']);
 expect(locks.sharedHolds).toBeGreaterThan(0);
 // The views still return the same rows and still write their History event, under the shared lock.
 expect(first).toHaveLength(LIBRARIES);expect(second.map(v=>v.id)).toEqual(first.map(v=>v.id));
 expect(first.every(v=>v.kind==='salary'&&v.year===YEAR)).toBe(true);
 expect(first.filter(v=>v.state==='confirmed')).toHaveLength(1);
 const [{count:eventsAfter}]=await raw<{count:number}[]>`select count(*)::int as count from domain_event where tenant_id=${b.tenantId}::uuid and event_type='rewards-setup.libraries.viewed'`;
 expect(eventsAfter-eventsBefore).toBe(2);
},120_000);

async function setupEventCounts(tenantId:string){
 const rows=await raw<{event_type:string;count:number}[]>`select event_type,count(*)::int as count from domain_event
  where tenant_id=${tenantId}::uuid and event_type like 'rewards-setup.%' group by event_type`;
 return Object.fromEntries(rows.map(r=>[r.event_type,r.count])) as Record<string,number>;
}

it('runs every audited Rewards setup view and export under the shared Access lock with its History event',async()=>{
 const {b,ctx,confirmed}=await populatedRewards(),modes:string[]=[];
 const before=await setupEventCounts(b.tenantId);
 starvedViewer(ctx.userId!,modes);
 const stop=accessLockSampler(b.tenantId);
 expect((await rewardPlanLibraryChoices(ctx,YEAR)).map(choice=>choice.id)).toEqual([confirmed]);
 expect((await rewardLibraryForExport(ctx,confirmed)).state).toBe('confirmed');
 expect((await rewardPatInputs(ctx,YEAR)).map(row=>row.company.id)).toContain(b.companyId);
 expect((await rewardPlanCompanyChoices(ctx,YEAR)).length).toBeGreaterThan(0);
 expect((await rewardPatExport(ctx,YEAR)).map(row=>row.company.id)).toContain(b.companyId);
 const locks=await stop(),after=await setupEventCounts(b.tenantId);
 expect(locks.exclusiveHolds).toBe(0);
 expect(modes).toEqual(['S','S','S','S','S']);
 const added=(type:string)=>(after['rewards-setup.'+type]??0)-(before['rewards-setup.'+type]??0);
 expect({libraries:added('libraries.viewed'),export:added('library.exported'),pat:added('pat.viewed'),patExport:added('pat.exported')})
  .toEqual({libraries:1,export:1,pat:2,patExport:1});
},120_000);

it('keeps the shell bell profile owner on the shared Access lock while starved tabs re-render beside ordinary callers',async()=>{
 const b=await seedBase(),subjects=[];
 for(let n=0;n<6;n++)subjects.push(await hireEmployee(adminCtx(b),{person:{fullName:`Fictional profile subject ${n+1}`,primaryEmail:randomUUID()+'@example.invalid'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}));
 const requests=await owner.db.insert(profileChangeRequest).values(subjects.flatMap(subject=>Array.from({length:8},()=>({tenantId:b.tenantId,
  employmentId:subject.employmentId,personId:subject.personId,proposed:{preferredName:'Fictional pending preferred name'}})))).returning({id:profileChangeRequest.id});
 // A second HR administrator with no person link: the owner after the restart, with the bell open in two tabs.
 const viewerId=await createAppUser(b.tenantId,null,'hr_admin'),viewer:SessionContext={...adminCtx(b),userId:viewerId},modes:string[]=[];
 starvedViewer(viewerId,modes);
 const stop=accessLockSampler(b.tenantId);
 const bells=Promise.all([pendingProfileTaskMetadata(viewer),pause(150).then(()=>pendingProfileTaskMetadata(viewer))]);
 let rendering=true;void bells.finally(()=>{rendering=false;});
 const callers:ReturnType<typeof ordinaryCaller>[]=[];
 await pause(100);
 while(rendering){callers.push(ordinaryCaller(b));await pause(100);}
 const [first,second]=await bells,outcomes=await Promise.all(callers),locks=await stop();
 const refused=outcomes.filter(o=>!o.ok);
 console.log('[access-lock-shell-bell]',JSON.stringify({...locks,requests:requests.length,callers:outcomes.length,refused:refused.length,
  refusedCodes:[...new Set(refused.map(o=>o.code))],slowestCallerMs:Math.round(Math.max(0,...outcomes.map(o=>o.ms))),bellModes:modes}));
 expect(locks.maxExclusiveMs).toBeLessThanOrEqual(MAX_EXCLUSIVE_HOLD_MS);
 expect(outcomes.length).toBeGreaterThan(3);
 expect(refused).toEqual([]);
 // Each bell: the candidate transaction (no Access lock), then the decision-authority check under the shared lock.
 expect(modes.filter(mode=>mode!=='none')).toEqual(['S','S']);
 // The same actionable tasks as before, for both renders.
 expect(new Set(first.map(row=>row.id))).toEqual(new Set(requests.map(row=>row.id)));
 expect(second.map(row=>row.id)).toEqual(first.map(row=>row.id));
 // Sensitivity control: one render with the previous exclusive profile-write barrier must break the bound under the same
 // starved model, so this case cannot pass vacuously.
 vi.spyOn(profilePolicy,'freshProfileEditPolicySharedTx').mockImplementation(profilePolicy.freshProfileEditPolicyTx);
 const stopControl=accessLockSampler(b.tenantId),control=await pendingProfileTaskMetadata(viewer),controlLocks=await stopControl();
 console.log('[access-lock-shell-bell-control]',JSON.stringify({...controlLocks,bellModes:modes.slice(-2)}));
 expect(control.map(row=>row.id)).toEqual(first.map(row=>row.id));
 expect(modes.at(-1)).toBe('X');
 expect(controlLocks.maxExclusiveMs).toBeGreaterThan(MAX_EXCLUSIVE_HOLD_MS);
},120_000);
