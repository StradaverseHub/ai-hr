/** The queue-owner deadline of a bulk-job tick (core/bulk-job-worker.ts BULK_JOB_OWNER_DEADLINE_SECONDS).
 * An idle lane's tick only reserves the owner connection, proves it, beats and claims. When the owner connection
 * stops answering (24 November: reserve() never settled, nothing ran in PostgreSQL) the tick must fail within the
 * deadline with BulkJobOwnerUnresponsive, so the worker exits and systemd restarts it, instead of waiting for the
 * 1,800 s stall watchdog. A statement that missed its deadline keeps its reservation: returning that connection to
 * the pool with a statement still outstanding would hand it to the next caller. */
import {afterEach,expect,it,vi} from 'vitest';
import type postgres from 'postgres';
import realPostgres from 'postgres';
import {BULK_JOB_OWNER_DEADLINE_SECONDS,BulkJobOwnerUnresponsive,runBulkJobTick} from '../core/bulk-job-worker';
import {IMPORT_WORKER_STALL_MIN_SECONDS} from '../lib/import-worker-watchdog';
import {startFakePostgres} from './helpers/fake-postgres-server';

const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{while(cleanups.length)await cleanups.pop()!().catch(()=>undefined);});

/** A real one-connection owner pool over a fake server, whose reservations record their release. */
async function ownerOver(hooks:Parameters<typeof startFakePostgres>[0]){
 const server=await startFakePostgres(hooks);cleanups.push(()=>server.close());
 const sql=realPostgres({host:'127.0.0.1',port:server.port,user:'worker',database:'aihr',password:'',ssl:false,max:1,onnotice:()=>undefined});
 cleanups.push(()=>sql.end({timeout:0}));
 const released=vi.fn();
 const owner={reserve:async()=>{
  const reserved=await sql.reserve();const release=reserved.release;
  reserved.release=()=>{released();release();};
  return reserved;
 }} as unknown as postgres.Sql;
 return {server,owner,released};
}

it('ends long before the stall watchdog and stays above a fresh connection',()=>{
 // A new connection may take connect_timeout (30 s) and its type fetch; the watchdog's minimum is 1,200 s.
 expect(BULK_JOB_OWNER_DEADLINE_SECONDS).toBeGreaterThanOrEqual(60);
 expect(BULK_JOB_OWNER_DEADLINE_SECONDS*5).toBeLessThanOrEqual(IMPORT_WORKER_STALL_MIN_SECONDS);
});

it('fails a tick whose owner reservation never settles, and releases a reservation that arrives late',async()=>{
 let deliver!:(reserved:postgres.ReservedSql)=>void;
 const late=new Promise<postgres.ReservedSql>(resolve=>{deliver=resolve;});
 const owner={reserve:()=>late} as unknown as postgres.Sql;
 const started=Date.now();
 const failure=await runBulkJobTick(owner,{handlers:[],ownerDeadlineMs:200}).catch(error=>error);
 expect(failure).toBeInstanceOf(BulkJobOwnerUnresponsive);
 expect(failure).toMatchObject({step:'the connection reservation'});
 expect(Date.now()-started).toBeLessThan(2000);
 const release=vi.fn();
 deliver({release} as unknown as postgres.ReservedSql);
 await vi.waitFor(()=>expect(release).toHaveBeenCalledTimes(1));
});

it('fails a tick whose owner proof never answers, and keeps that reservation out of the pool',async()=>{
 const {server,owner,released}=await ownerOver({statement:text=>text.includes('pg_roles')?'hold':'answer'});
 const failure=await runBulkJobTick(owner,{handlers:[],ownerDeadlineMs:300}).catch(error=>error);
 expect(failure).toBeInstanceOf(BulkJobOwnerUnresponsive);
 expect(failure).toMatchObject({step:'the owner proof'});
 expect(server.statements.some(text=>text.includes('pg_roles'))).toBe(true);
 expect(released).not.toHaveBeenCalled();
});

it('still releases the reservation when the owner answers and the tick fails for another reason',async()=>{
 // The fake server answers every statement with no rows, so the owner proof is refused.
 const {owner,released}=await ownerOver({});
 await expect(runBulkJobTick(owner,{handlers:[],ownerDeadlineMs:5000})).rejects.toThrow('requires the physical queue owner connection');
 expect(released).toHaveBeenCalledTimes(1);
});
