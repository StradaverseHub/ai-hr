/** The queue-owner deadline of the import worker's ticks (core/owner-step-deadline.ts): Bank & Statutory, Individual
 * Transaction and the bulk-job kernel. An idle tick only reserves the owner connection and proves, locks or claims.
 * When the owner connection stops answering (24 November: reserve() never settled, nothing ran in PostgreSQL) the tick
 * must fail within the deadline with OwnerConnectionUnresponsive, so the worker exits and systemd restarts it, instead
 * of waiting for the 1,800 s stall watchdog. A statement that missed its deadline keeps its reservation, and the
 * advisory lock is not released through it: returning that connection with a statement still outstanding would hand
 * it to the next caller, and the session's end frees the lock. The ticks run against a fake server
 * (test/helpers/fake-postgres-server.ts) that answers, proves with one `ok` row, or never answers. */
import {afterEach,expect,it,vi} from 'vitest';
import type postgres from 'postgres';
import realPostgres from 'postgres';
import {runBankImportTick} from '../core/bank-import-worker';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {runIndividualImportTick} from '../core/individual-import-worker';
import {OWNER_STEP_DEADLINE_SECONDS,OwnerConnectionUnresponsive} from '../core/owner-step-deadline';
import {IMPORT_WORKER_STALL_MIN_SECONDS} from '../lib/import-worker-watchdog';
import {startFakePostgres,type FakePostgresHooks} from './helpers/fake-postgres-server';

const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{while(cleanups.length)await cleanups.pop()!().catch(()=>undefined);});

/** A real one-connection owner pool over a fake server, whose reservations record their release. */
async function ownerOver(hooks:FakePostgresHooks){
 const server=await startFakePostgres(hooks);cleanups.push(()=>server.close());
 const sql=realPostgres({host:'127.0.0.1',port:server.port,user:'worker',database:'aihr',password:'',ssl:false,max:1,onnotice:()=>undefined});
 cleanups.push(()=>sql.end({timeout:0}));
 const released=vi.fn();
 const owner={reserve:async()=>{
  const reserved=await sql.reserve();const release=reserved.release;
  reserved.release=()=>{released();release();};
  return reserved;
 }} as unknown as postgres.Sql;
 return {server,owner,released,unlocks:()=>server.statements.filter(text=>text.includes('pg_advisory_unlock'))};
}
const DEADLINE_MS=300;
const ticks={
 bulk:(owner:postgres.Sql)=>runBulkJobTick(owner,{handlers:[],ownerDeadlineMs:DEADLINE_MS}),
 bank:(owner:postgres.Sql)=>runBankImportTick(owner,{ownerDeadlineMs:DEADLINE_MS}),
 individual:(owner:postgres.Sql)=>runIndividualImportTick(owner,async ctx=>ctx,{ownerDeadlineMs:DEADLINE_MS}),
};
const BANK_PROOF="'public.bank_import_job'::regclass",BANK_LOCK="pg_try_advisory_lock(hashtextextended('bank-import-worker'",
 BANK_CLAIM='select * from bank_import_job',INDIVIDUAL_LOCK="pg_try_advisory_lock(hashtextextended('payroll-individual-import-worker'",
 INDIVIDUAL_CLAIM='from payroll_individual_import_job';

it('ends long before the stall watchdog and stays above a fresh connection',()=>{
 // A new connection may take connect_timeout (30 s) and its type fetch; the watchdog's minimum is 1,200 s.
 expect(OWNER_STEP_DEADLINE_SECONDS).toBeGreaterThanOrEqual(60);
 expect(OWNER_STEP_DEADLINE_SECONDS*5).toBeLessThanOrEqual(IMPORT_WORKER_STALL_MIN_SECONDS);
});

it.each(Object.keys(ticks) as (keyof typeof ticks)[])('fails a %s tick whose owner reservation never settles, and releases a reservation that arrives late',async name=>{
 let deliver!:(reserved:postgres.ReservedSql)=>void;
 const late=new Promise<postgres.ReservedSql>(resolve=>{deliver=resolve;});
 const started=Date.now();
 const failure=await ticks[name]({reserve:()=>late} as unknown as postgres.Sql).catch(error=>error);
 expect(failure).toBeInstanceOf(OwnerConnectionUnresponsive);
 expect(failure).toMatchObject({step:'the connection reservation'});
 expect(Date.now()-started).toBeLessThan(3000);
 const release=vi.fn();
 deliver({release} as unknown as postgres.ReservedSql);
 await vi.waitFor(()=>expect(release).toHaveBeenCalledTimes(1));
});

it('fails a bulk-job tick whose owner proof never answers, and keeps that reservation out of the pool',async()=>{
 const {server,owner,released}=await ownerOver({statement:text=>text.includes('pg_roles')?'hold':'answer'});
 const failure=await ticks.bulk(owner).catch(error=>error);
 expect(failure).toBeInstanceOf(OwnerConnectionUnresponsive);
 expect(failure).toMatchObject({step:'the owner proof'});
 expect(server.statements.some(text=>text.includes('pg_roles'))).toBe(true);
 expect(released).not.toHaveBeenCalled();
});

it('fails a Bank tick whose claim never answers, without unlocking or releasing through that connection',async()=>{
 const {server,owner,released,unlocks}=await ownerOver({statement:text=>
  text.includes(BANK_PROOF)||text.includes(BANK_LOCK)?'ok':text.includes(BANK_CLAIM)?'hold':'answer'});
 const failure=await ticks.bank(owner).catch(error=>error);
 expect(failure).toBeInstanceOf(OwnerConnectionUnresponsive);
 expect(failure).toMatchObject({step:'the Bank import claim'});
 expect(server.statements.some(text=>text.includes(BANK_CLAIM))).toBe(true);
 expect(unlocks()).toEqual([]);
 expect(released).not.toHaveBeenCalled();
});

it('fails an Individual Transaction tick whose claim never answers, without unlocking or releasing through that connection',async()=>{
 const {server,owner,released,unlocks}=await ownerOver({statement:text=>
  text.includes(INDIVIDUAL_LOCK)?'ok':text.includes(INDIVIDUAL_CLAIM)?'hold':'answer'});
 const failure=await ticks.individual(owner).catch(error=>error);
 expect(failure).toBeInstanceOf(OwnerConnectionUnresponsive);
 expect(failure).toMatchObject({step:'the Individual import claim'});
 expect(server.statements.some(text=>text.includes(INDIVIDUAL_CLAIM))).toBe(true);
 expect(unlocks()).toEqual([]);
 expect(released).not.toHaveBeenCalled();
});

it('finds no Bank job on an answering owner, then unlocks and releases',async()=>{
 const {owner,released,unlocks}=await ownerOver({statement:text=>text.includes(BANK_PROOF)||text.includes(BANK_LOCK)?'ok':'answer'});
 await expect(ticks.bank(owner)).resolves.toBe(false);
 expect(unlocks()).toHaveLength(1);
 expect(released).toHaveBeenCalledTimes(1);
});

it('finds no Individual Transaction job on an answering owner, then unlocks and releases',async()=>{
 const {owner,released,unlocks}=await ownerOver({statement:text=>text.includes(INDIVIDUAL_LOCK)?'ok':'answer'});
 await expect(ticks.individual(owner)).resolves.toBe(false);
 expect(unlocks()).toHaveLength(1);
 expect(released).toHaveBeenCalledTimes(1);
});

it('still releases a bulk-job reservation when the owner answers and the tick fails for another reason',async()=>{
 // The fake server answers the owner proof with no rows, so the proof is refused.
 const {owner,released}=await ownerOver({});
 await expect(runBulkJobTick(owner,{handlers:[],ownerDeadlineMs:5000})).rejects.toThrow('requires the physical queue owner connection');
 expect(released).toHaveBeenCalledTimes(1);
});
