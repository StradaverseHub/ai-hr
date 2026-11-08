/** Ordinary real-DB regression only. No singleton/profile/capability authority. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type Tx} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {runRewardPolicyReviewTxRefusal} from './prototypes/rewards-audit-policy-review-observer';
beforeAll(migrateTestDb);afterAll(closeAll);
async function actualApplicationRoot(tx:Tx){
 const [row]=await tx.execute<{login:string;current:string;role:string;nonowner:boolean;restricted:boolean;xid:string}>(sql`select session_user::text as login,current_user::text as current,current_setting('role')as role,
  session_user::regrole::oid<>(select relowner from pg_class where oid='public.domain_event'::regclass)as nonowner,
  (select not(rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)from pg_roles where rolname=session_user)as restricted,
  pg_current_xact_id()::text as xid`);
 expect(row.login).toBe('ai_hr_app');expect(row.current).toBe('ai_hr_app');expect(row.role).toBe('none');expect(row.nonowner).toBe(true);expect(row.restricted).toBe(true);expect(row.xid).toMatch(/^[1-9][0-9]*$/);return row.xid;
}
async function createFrameTable(tx:Tx){
 await tx.execute(sql`create temporary table owned_observer_frame_probe(ordinal integer primary key)on commit drop`);
 const [row]=await tx.execute<{ordinal:number;atRoot:boolean}>(sql`insert into pg_temp.owned_observer_frame_probe values(0)returning ordinal,xmin=pg_current_xact_id()::xid as "atRoot"`);
 expect(row).toEqual({ordinal:0,atRoot:true});
}
async function frameTableDropped(){
 const [row]=await owner.client`select not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relname='owned_observer_frame_probe'and n.nspname like 'pg_temp_%')as absent`;
 expect(row.absent).toBe(true);
}
it('reproduces the pinned raw nested-driver retained frame: a later insert has subtransaction xmin despite the unchanged root xid',async()=>{
 await resetDb();const b=await seedBase();
 await withTenant(adminCtx(b),async tx=>{
  const root=await actualApplicationRoot(tx);await createFrameTable(tx);let original:unknown;
  try{await tx.transaction(async nested=>{await nested.execute(sql`select 1/0`);});}catch(error){original=error;}
  expect(pgSqlState(original)).toBe('22012');
  const [row]=await tx.execute<{ordinal:number;atRoot:boolean;xid:string}>(sql`insert into pg_temp.owned_observer_frame_probe values(1)returning ordinal,xmin=pg_current_xact_id()::xid as "atRoot",pg_current_xact_id()::text as xid`);
  expect(row).toEqual({ordinal:1,atRoot:false,xid:root});
  expect(Array.from(await tx.execute(sql`select ordinal from pg_temp.owned_observer_frame_probe order by ordinal`))).toEqual([{ordinal:0},{ordinal:1}]);
 });
 await frameTableDropped();
});
it('the actual observer helper restores parent xmin after repeated real SQL errors and rolls back every temporary negative effect',async()=>{
 await resetDb();const b=await seedBase(),abort=new AbortController(),poisoned:Error[]=[];let verified=0;
 await withTenant(adminCtx(b),async tx=>{
  const root=await actualApplicationRoot(tx);await createFrameTable(tx);
  for(const ordinal of [1,2,3]){
   let original:unknown;
   await runRewardPolicyReviewTxRefusal(tx,abort.signal,async nested=>{
    expect(nested).not.toBe(tx);await nested.execute(sql`insert into pg_temp.owned_observer_frame_probe values(999)`);
    try{await nested.execute(sql`select 1/0`);}catch(error){original=error;throw error;}
   },error=>{expect(error).toBe(original);expect(pgSqlState(error)).toBe('22012');verified++;},error=>poisoned.push(error));
   const [row]=await tx.execute<{ordinal:number;atRoot:boolean;xid:string}>(sql`insert into pg_temp.owned_observer_frame_probe values(${ordinal})returning ordinal,xmin=pg_current_xact_id()::xid as "atRoot",pg_current_xact_id()::text as xid`);
   expect(row).toEqual({ordinal,atRoot:true,xid:root});
   expect(Array.from(await tx.execute(sql`select ordinal from pg_temp.owned_observer_frame_probe order by ordinal`))).toEqual(Array.from({length:ordinal+1},(_,ordinal)=>({ordinal})));
  }
  const [row]=await tx.execute<{allAtRoot:boolean;count:number}>(sql`select bool_and(xmin=pg_current_xact_id()::xid)as "allAtRoot",count(*)::int as count from pg_temp.owned_observer_frame_probe`);
  expect(row).toEqual({allAtRoot:true,count:4});
 });
 expect(verified).toBe(3);expect(poisoned).toEqual([]);await frameTableDropped();
});
