/**
 * No read path takes the tenant's exclusive Access lock (staging, 11 November 2026).
 *
 * After the deploy restart one tenant's pages timed out on the Access lock in both modes: read paths that only
 * display data took the exclusive lock, each one queued behind the last, and every ordinary caller waited behind them.
 * This suite holds the line in two ways, on real PostgreSQL through the repository harness:
 *  - the mechanism: a report read that takes the shared lock first, and a display read (withAccessDisplayRead), stay
 *    shared through every mode-joining helper, while commands keep the exclusive lock;
 *  - the guard: an independent pg_locks sampler watches the tenant's Access key while the shell bell, the Home
 *    sections, the worker gate, the Personnel movement and correction reads, an Employee Master run and the Personnel
 *    export details read a populated tenant, and no exclusive hold may appear. Any SQL owner on these paths that took
 *    the exclusive lock of its own would show here too.
 */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {withBackgroundReadWork,withSharedReadSnapshot,withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {accessLockModeHeldTx,lockAccessConfigurationTx,lockAccessConfigurationWriteTx,withAccessDisplayRead} from '../core/access-configuration-lock';
import {joinAccessConfigurationTx} from '../core/workforce-lock-mode';
import {lockAccessForAiControlCheckTx} from '../core/ai-centre-control';
import {workerRunGate} from '../core/agent-registry/controls';
import {RECOMMENDER_WORKER} from '../core/recommenders/leave-decision';
import {pendingTaskSummary} from '../core/approvals-inbox';
import {hireEmployee} from '../core/org';
import {movementAttachments,movementHistory,resignationInformation} from '../core/movement';
import {informationCorrectionHistory} from '../core/information-correction';
import {runEmployeeMasterReport} from '../core/employee-master-reports';
import {grantAssistant} from '../core/assistant-grant';
import {prepareOwnLeaveReviewTx,reopenOwnLeaveReviewTx} from '../core/assistant-actions/own-leave-store';
import {readPersonnelListExportDetails} from '../core/personnel-list-export-details';
import {withPersonnelRead} from '../core/personnel-read-bounds';
import {defaultMasterColumn,type EmployeeMasterSpec} from '../lib/employee-master-report';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {readAtAGlance,readDoneForYou,readNeedsYou} from '../components/today/reads';
import {todayAudience} from '../lib/today/audience';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
let raw:postgres.Sql;
beforeAll(async()=>{await migrateTestDb();raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:4,onnotice:()=>{}});});
beforeEach(resetDb);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(async()=>{await raw.end({timeout:5});await closeAll();});

/** Independent observer: every granted hold of the tenant's Access key, by backend transaction and mode. */
function accessLockSampler(tenantId:string){
 const holds=new Map<string,{mode:string;first:number;last:number;query:string}>();let sampling=true;
 const loop=(async()=>{
  while(sampling){
   const rows=await raw<{pid:number;xact:string;mode:string;query:string}[]>`select l.pid,a.xact_start::text as xact,l.mode,left(regexp_replace(a.query,'\\s+',' ','g'),160) as query
    from pg_catalog.pg_locks l join pg_catalog.pg_stat_activity a on a.pid=l.pid
    cross join (select hashtextextended(${'access-configuration:'+tenantId},0) as k) target
    where l.locktype='advisory' and l.granted and l.objsubid=1 and a.xact_start is not null
     and l.database=(select oid from pg_catalog.pg_database where datname=current_database())
     and l.classid::bigint=((target.k>>32)&4294967295) and l.objid::bigint=(target.k&4294967295)`;
   const now=performance.now();
   for(const r of rows){const id=`${r.pid}|${r.xact}|${r.mode}`;const h=holds.get(id)??{mode:r.mode,first:now,last:now,query:r.query};h.last=now;holds.set(id,h);}
   await pause(5);
  }
 })();
 return async()=>{
  sampling=false;await loop;
  const all=[...holds.values()];
  return {exclusive:all.filter(h=>h.mode==='ExclusiveLock').map(h=>({ms:Math.round(h.last-h.first),query:h.query})),shared:all.filter(h=>h.mode==='ShareLock').length};
 };
}

const admin=(b:Base):SessionContext=>({...adminCtx(b),personId:null,grants:[{role:'hr_admin',companyId:null}]});
const heldMode=(tx:Tx,tenantId:string)=>accessLockModeHeldTx(tx,tenantId);

it('keeps a report read that takes the shared lock first shared through every mode-joining helper, and commands exclusive',async()=>{
 const b=await seedBase(),ctx=admin(b);
 expect(await withTenant(ctx,async tx=>{
  await lockAccessConfigurationTx(tx,b.tenantId);await joinAccessConfigurationTx(tx,b.tenantId);await lockAccessForAiControlCheckTx(tx,b.tenantId);
  return heldMode(tx,b.tenantId);
 },{readOnlySnapshot:true})).toBe('S');
 // A read-write transaction keeps the exclusive lock for a command, through every helper.
 expect(await withTenant(ctx,async tx=>{await lockAccessConfigurationWriteTx(tx,b.tenantId);return heldMode(tx,b.tenantId);})).toBe('X');
 expect(await withTenant(ctx,async tx=>{await joinAccessConfigurationTx(tx,b.tenantId);return heldMode(tx,b.tenantId);})).toBe('X');
 expect(await withTenant(ctx,async tx=>{await lockAccessForAiControlCheckTx(tx,b.tenantId);return heldMode(tx,b.tenantId);})).toBe('X');
},60_000);

it('makes the mode-joining helpers shared inside a display read and leaves an explicit exclusive request exclusive',async()=>{
 const b=await seedBase(),ctx=admin(b);
 expect(await withAccessDisplayRead(()=>withTenant(ctx,async tx=>{await joinAccessConfigurationTx(tx,b.tenantId);await lockAccessForAiControlCheckTx(tx,b.tenantId);return heldMode(tx,b.tenantId);}))).toBe('S');
 expect(await withAccessDisplayRead(()=>withTenant(ctx,async tx=>{await lockAccessConfigurationWriteTx(tx,b.tenantId);return heldMode(tx,b.tenantId);}))).toBe('X');
 // An exclusive holder inside a display read simply re-enters.
 expect(await withAccessDisplayRead(()=>withTenant(ctx,async tx=>{await lockAccessConfigurationWriteTx(tx,b.tenantId);await joinAccessConfigurationTx(tx,b.tenantId);return heldMode(tx,b.tenantId);}))).toBe('X');
},60_000);

it('reads the shell bell, Home, the worker gate, Personnel movement history and an Employee Master run with no exclusive hold',async()=>{
 const b=await seedBase(),ctx=admin(b),today=todayInKualaLumpur(),subjects:Awaited<ReturnType<typeof hireEmployee>>[]=[];
 for(let n=0;n<3;n++)subjects.push(await hireEmployee(adminCtx(b),{person:{fullName:`Fictional read subject ${n+1}`,primaryEmail:randomUUID()+'@example.invalid'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:today}));
 await owner.db.insert(schema.profileChangeRequest).values(subjects.map(subject=>({tenantId:b.tenantId,employmentId:subject.employmentId,personId:subject.personId,
  proposed:{preferredName:'Fictional pending preferred name'}})));
 const subject=subjects[0]!,code=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode')!,
  kind=PERSONNEL_FIELDS.find(field=>field.owner==='movement'&&field.ownerField==='kind')!;
 const spec:EmployeeMasterSpec={v:2,asAt:today,companyIds:[b.companyId],includeDrafts:false,columns:[defaultMasterColumn(code),defaultMasterColumn(kind)],
  expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
 const stop=accessLockSampler(b.tenantId);
 // The root layout's bell: a passive background read in the request's shared snapshot.
 const bell=await withBackgroundReadWork(b.tenantId,()=>withSharedReadSnapshot(ctx,()=>pendingTaskSummary(ctx,[b.companyId],
  {attendance:false,claims:false,performance:false,rewards:false},{deferClaimPreview:true})));
 const gate=await workerRunGate(ctx,RECOMMENDER_WORKER);
 const audience=todayAudience(ctx),needsYou=await readNeedsYou(ctx,{scopeIds:[b.companyId],audience,today,locale:'en'});
 const doneForYou=await readDoneForYou(ctx,{scopeIds:[b.companyId],today}),glance=await readAtAGlance(ctx,{locale:'en',today});
 const history=await movementHistory(ctx,subject.employmentId),hired=history[0];
 if(!hired)throw Error('Missing fictional movement history');
 const documents=await movementAttachments(ctx,subject.employmentId,hired.id),corrections=await informationCorrectionHistory(ctx,subject.employmentId);
 const resignation=await resignationInformation(ctx,subject.employmentId);
 const master=await runEmployeeMasterReport(ctx,[b.companyId],{spec});
 // The Personnel export's details, in one read-only snapshot as the export route reads them.
 const exported=await withPersonnelRead(ctx,tx=>readPersonnelListExportDetails(ctx,subjects.map(row=>({employmentId:row.employmentId,companyId:b.companyId})),today,tx));
 const locks=await stop();
 console.log('[access-lock-read-paths]',JSON.stringify({exclusive:locks.exclusive,shared:locks.shared}));
 expect(locks.exclusive).toEqual([]);
 expect(locks.shared).toBeGreaterThan(0);
 // Each read still answers: the bell's three profile tasks, Home's tasks, the gate, movements and the report rows.
 expect(bell.items.filter(item=>item.kind==='profile')).toHaveLength(3);
 expect(needsYou.tasks.filter(task=>task.kind==='profile')).toHaveLength(3);
 expect(typeof gate.run).toBe('boolean');
 expect(doneForYou).toBeDefined();expect(glance).toBeDefined();
 expect(documents).toEqual([]);expect(Array.isArray(corrections)).toBe(true);expect(resignation).toBeDefined();
 expect(master.result.totalRows).toBeGreaterThanOrEqual(3);
 expect(exported.fields.length).toBeGreaterThan(0);expect(exported.cells.size).toBe(3);
},120_000);

it('reopens a Home prepared-leave card under the shared lock with the same review, while the command path stays exclusive',async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-review-storage-master-passphrase-12345');
 const b=await seedBase();await setModule(b.tenantId,'assistant','active');
 const today=todayInKualaLumpur(),subject=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Home review applicant',primaryEmail:randomUUID()+'@example.invalid'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:today});
 const userId=await createAppUser(b.tenantId,subject.personId,'employee');
 await grantAssistant(adminCtx(b),{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(b,['employee']),userId,personId:subject.personId,grants:[{role:'employee',companyId:null}]};
 await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:today});
 const next=new Date(today+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));
 const nomination={action:'leave.apply' as const,contractVersion:1 as const,employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,date:next.toISOString().slice(0,10),durationType:'full_day' as const};
 const prepared=await withTenant(ctx,tx=>prepareOwnLeaveReviewTx(tx,ctx,nomination,{employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId},
  {reason:'Fictional custody-only private reason',employeeRemark:'Fictional custody-only private remark'},'en'));
 if(prepared.kind!=='prepared')throw Error('Fictional fixture did not prepare a review: '+prepared.kind);
 const reopen=(display:boolean)=>{
  const read=()=>withTenant(ctx,async tx=>({result:await reopenOwnLeaveReviewTx(tx,ctx,prepared.review.actionId,'en'),mode:await heldMode(tx,b.tenantId)}));
  return display?withAccessDisplayRead(read):read();
 };
 // Strict mode from here: a shared holder that asks for the exclusive lock in TypeScript fails loudly instead of upgrading.
 vi.stubEnv('AIHR_ACCESS_LOCK_STRICT','on');
 const card=await reopen(true),command=await reopen(false);
 expect(card.mode).toBe('S');expect(command.mode).toBe('X');
 expect(card.result).toEqual(command.result);
 // The actual Home section, under the sampler: the card's details come back and nothing holds the lock exclusively.
 const stop=accessLockSampler(b.tenantId);
 const needsYou=await readNeedsYou(ctx,{scopeIds:[b.companyId],audience:todayAudience(ctx),today,locale:'en'});
 const locks=await stop();
 console.log('[access-lock-home-prepared]',JSON.stringify({exclusive:locks.exclusive,shared:locks.shared,prepared:needsYou.prepared.length}));
 expect(locks.exclusive).toEqual([]);
 expect(needsYou.prepared.map(item=>item.actionId)).toEqual([prepared.review.actionId]);
 expect(needsYou.prepared[0]).toMatchObject({leave:{days:1}});
},120_000);
