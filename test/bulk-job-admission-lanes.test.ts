/** ADR 0181 J1.3: never queue a job no worker can run. Admission (enqueueBulkJobTx) reads the live workers through
 * the existing app.bulk_job_worker_ready: when the kind's lane worker is live but does not advertise the kind (the web
 * is on a newer release, "web first, worker next"), it refuses with a plain message and queues nothing; when no
 * worker serves the lane (a restart, or a worker from before lanes) it queues as before and the screen shows the job
 * waiting for the background service. Real PostgreSQL and RLS; heartbeats are written as the queue owner. */
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import {BULK_JOB_BEING_INSTALLED,BulkJobError,bulkJobAdmissionReadinessTx,bulkJobWorkerStatusTx,enqueueBulkJobTx} from '../core/bulk-job';
import {WORKER_LANES,laneCoverageProblems,laneMarker} from '../core/bulk-job-lanes';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,ctx:SessionContext;
// payroll_process is in the payroll lane; its input shape is {"batchId":"string","after":"array?"} (migration 5051).
const KIND='payroll_process';
const admit=(operationKey=randomUUID())=>withTenant(ctx,tx=>enqueueBulkJobTx(tx,ctx,{kind:KIND,operationKey,input:{batchId:'fictional-batch'}}));
const readiness=(kind:string)=>withTenant(ctx,tx=>bulkJobAdmissionReadinessTx(tx,kind));
const jobs=async()=>(await owner.client<{n:number}[]>`select count(*)::int as n from bulk_job where kind=${KIND}`)[0].n;
async function beat(kinds:string[],age='0 seconds'){
 const id=randomUUID();
 await owner.client`insert into bulk_job_worker(id,kinds,host,pid,beat_at) values(${id}::uuid,${kinds},'fixture',1,now()-${age}::interval)`;
 return id;
}

beforeAll(async()=>{await migrateTestDb();});
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);await owner.client`delete from bulk_job_worker`;});
afterAll(async()=>{await owner.client`delete from bulk_job_worker`;await closeAll();});

it('queues as before when no worker is live, and the screen shows the job waiting for the background service',async()=>{
 expect(await readiness(KIND)).toBe('waiting');
 const {row}=await admit();
 expect(row).toMatchObject({kind:KIND,state:'queued'});
 expect(await withTenant(ctx,tx=>bulkJobWorkerStatusTx(tx,KIND))).toBe('unavailable');
 // A heartbeat older than 90 seconds is not live, even with the lane marker.
 await beat([laneMarker('payroll'),'payroll_history'],'5 minutes');
 expect(await readiness(KIND)).toBe('waiting');
 expect((await admit()).row.state).toBe('queued');
});

it('queues when only another lane is live (this lane is restarting), and when the live worker serves the kind',async()=>{
 await beat([laneMarker('import'),'employee_import']);
 expect(await readiness(KIND)).toBe('waiting');
 expect((await admit()).row.state).toBe('queued');
 await beat([laneMarker('payroll'),'payroll_process','payroll_history']);
 expect(await readiness(KIND)).toBe('ready');
 expect((await admit()).row.state).toBe('queued');
 expect(await withTenant(ctx,tx=>bulkJobWorkerStatusTx(tx,KIND))).toBe('running');
});

it('refuses, queuing nothing, while the live lane worker runs a release without the kind',async()=>{
 const older=await beat([laneMarker('payroll'),'payroll_history']);
 expect(await readiness(KIND)).toBe('installing');
 const before=await jobs();
 const refused=await admit().catch(error=>error);
 expect(refused).toBeInstanceOf(BulkJobError);
 expect(refused).toMatchObject({message:BULK_JOB_BEING_INSTALLED,status:503});
 expect(BULK_JOB_BEING_INSTALLED).toBe('This feature is still being installed. Nothing was started. Try again in a few minutes.');
 expect(await jobs()).toBe(before);
 // The same refusal from an all-lane worker of an older release (every lane marker, an older kind list).
 await owner.client`delete from bulk_job_worker where id=${older}::uuid`;
 await beat(['payroll_history','employee_import',...WORKER_LANES.map(laneMarker)]);
 await expect(admit()).rejects.toThrow(BULK_JOB_BEING_INSTALLED);
 expect(await jobs()).toBe(before);
});

it('refuses a new kind until the worker advertises it, and the release check reports the same lane gap',async()=>{
 const id=await beat([laneMarker('payroll'),'payroll_history']);
 const coverage=async()=>{
  const kinds=(await owner.client<{kind:string}[]>`select kind from bulk_job_kind order by kind`).map(r=>r.kind);
  const live=(await owner.client<{kinds:string[]}[]>`select kinds from bulk_job_worker where beat_at>now()-interval '90 seconds'`).map(r=>r.kinds);
  return laneCoverageProblems(kinds,live,[]);
 };
 expect(await coverage()).toEqual(['A live "payroll" lane worker does not serve "payroll_process": it runs an older release, so these jobs are refused until it is updated.']);
 await expect(admit()).rejects.toThrow(BULK_JOB_BEING_INSTALLED);
 // The worker is updated: it now advertises the kind.
 await owner.client`update bulk_job_worker set kinds=${[laneMarker('payroll'),'payroll_history','payroll_process']},beat_at=now() where id=${id}::uuid`;
 expect(await coverage()).toEqual([]);
 expect((await admit()).row.state).toBe('queued');
});

it('never refuses a kind outside the lane catalogue, and still returns an existing job for a repeated operation key',async()=>{
 await beat([...WORKER_LANES.map(laneMarker)]);
 expect(await readiness('kernel_fixture')).toBe('ready');
 await owner.client`delete from bulk_job_worker`;
 const key=randomUUID();
 const first=await admit(key);
 expect(await admit(key)).toMatchObject({existing:true,row:{id:first.row.id}});
});
