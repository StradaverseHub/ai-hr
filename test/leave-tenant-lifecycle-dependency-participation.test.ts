/** Actual owner lifecycle interval cases, authored UNRUN. No CLI, service control, provider or
 * destructive seed/reset is executed. Only fictional isolated test tenant data is changed. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { lockLeaveDependenciesTx } from '../packs/leave/service';
import { runDunning } from '../scripts/apply-dunning';
import { runClosure, type ClosureOptions } from '../scripts/close-tenant';
import { runReactivation } from '../scripts/reactivate-tenant';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
const url = process.env.TEST_MIGRATION_DATABASE_URL!;
beforeAll(migrateTestDb); beforeEach(async () => { await resetDb(); b = await seedBase(); }); afterAll(closeAll);
const closure = (): ClosureOptions => ({tenantId:b.tenantId,requestedBy:randomUUID(),approvedBy:randomUUID(),
  requestedAt:new Date('2026-08-01T00:00:00Z'),approvedAt:new Date('2026-08-02T00:00:00Z'),
  retentionHeldUntil:null,apply:true,today:'2026-08-03'});
async function state() { return {
  tenant: await owner.db.select().from(s.tenant).where(eq(s.tenant.id,b.tenantId)),
  windows: await owner.db.select().from(s.tenantSuspensionWindow).where(eq(s.tenantSuspensionWindow.tenantId,b.tenantId)).orderBy(s.tenantSuspensionWindow.id),
  events: await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),
}; }
async function held(subject:string, work:()=>Promise<void>) {
  let ready!:()=>void,fail!:(e:unknown)=>void,release!:()=>void;
  const start=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
  const timer=setTimeout(()=>{fail(Error('tenant lifecycle interval timed out'));release();},10000);
  const holder=withTenant(adminCtx(b),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[subject]);ready();await finish;});void holder.catch(fail);
  try {await start;await work();}finally{release();clearTimeout(timer);await holder;}
}
describe('owner tenant lifecycle sources',()=>{
  it.each(['suspend','close','reactivate'] as const)('%s refuses during an actual employee interval with no tenant/window/event effects, then applies after release',async command=>{
    const subject=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Lifecycle Subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
    if(command==='suspend')await owner.db.insert(s.subscription).values({tenantId:b.tenantId,plan:'standard',status:'past_due',periodEnd:'2026-06-01'});
    const options=closure();
    const apply=()=>command==='suspend'?runDunning(url,{apply:true,today:'2026-08-03'}):command==='close'?runClosure(url,options):runReactivation(url,{tenantId:b.tenantId,apply:true,today:'2026-08-03'});
    await held(subject.employmentId,async()=>{
      if(command==='reactivate') {
        // Setup only: emulate the already-started participant that predates suspension. A suspended
        // tenant cannot newly enter an ordinary write transaction, which is why setup follows ready.
        await owner.db.update(s.tenant).set({status:'suspended',suspendedAt:new Date('2026-07-01T00:00:00Z')}).where(eq(s.tenant.id,b.tenantId));
        await owner.db.insert(s.tenantSuspensionWindow).values({tenantId:b.tenantId,suspendedAt:'2026-07-01',reason:'Fictional suspension'});
      }
      const before=await state();await expect(apply()).rejects.toThrow('Tenant catalogs are busy or unavailable');expect(await state()).toEqual(before);
    });
    await apply();const after=await state();
    expect(after.tenant[0].status).toBe(command==='suspend'?'suspended':command==='close'?'closed':'active');
    const event=command==='suspend'?'tenant.suspended':command==='close'?'tenant.closed':'tenant.reinstated';
    expect(after.events.filter(row=>row.eventType===event)).toHaveLength(1);
    if(command==='suspend')expect(after.windows).toMatchObject([{resumedAt:null}]);
    if(command==='reactivate')expect(after.windows[0].resumedAt).toBe('2026-08-03');
  });
  it('rereads billing after the observed Access wait instead of suspending from the original nomination',async()=>{
    await owner.db.insert(s.subscription).values({tenantId:b.tenantId,plan:'standard',status:'past_due',periodEnd:'2026-06-01'});
    let ready!:(pid:number)=>void,fail!:(e:unknown)=>void,release!:()=>void;
    const start=new Promise<number>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
    const timer=setTimeout(()=>{fail(Error('tenant lifecycle Access wait timed out'));release();},10000);
    const holder=withTenant(adminCtx(b),async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`);const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);ready(row.pid);await finish;});void holder.catch(fail);
    let command:ReturnType<typeof runDunning>|undefined;
    try {
      const pid=await start,opts={apply:true,today:'2026-08-03'};command=runDunning(url,opts);void command.catch(()=>undefined);
      let waiting=false;for(let i=0;i<100;i++){const [row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity a where a.datname=current_database() and a.wait_event_type='Lock' and a.wait_event='advisory' and ${pid}=any(pg_blocking_pids(a.pid))) as waiting`);if(row.waiting){waiting=true;break;}await new Promise(yes=>setTimeout(yes,10));}expect(waiting).toBe(true);
      await owner.db.update(s.subscription).set({status:'active',periodEnd:'2027-01-01'}).where(eq(s.subscription.tenantId,b.tenantId));
      opts.today='2030-01-01';release();await holder;const out=await command;
      expect(out.find(row=>row.tenantId===b.tenantId)?.action).toBe('none');
      const after=await state();expect(after.tenant[0].status).toBe('active');expect(after.windows).toHaveLength(0);expect(after.events.some(row=>row.eventType==='tenant.suspended')).toBe(false);
    }finally{release();clearTimeout(timer);await holder;if(command)await command.catch(()=>undefined);}
  });
  it('rolls back the actual suspension status and window when its exact canonical audit insert fails',async()=>{
    await owner.db.insert(s.subscription).values({tenantId:b.tenantId,plan:'standard',status:'past_due',periodEnd:'2026-06-01'});
    await owner.db.execute(sql`create function public.aip_lifecycle_refuse_suspend() returns trigger language plpgsql as $$begin if NEW.event_type='tenant.suspended' then raise exception 'fictional lifecycle audit failure';end if;return NEW;end$$`);
    await owner.db.execute(sql`create trigger aip_lifecycle_refuse_suspend before insert on public.domain_event for each row execute function public.aip_lifecycle_refuse_suspend()`);
    try{const before=await state();await expect(runDunning(url,{apply:true,today:'2026-08-03'})).rejects.toThrow();expect(await state()).toEqual(before);}
    finally{await owner.db.execute(sql`drop trigger aip_lifecycle_refuse_suspend on public.domain_event`);await owner.db.execute(sql`drop function public.aip_lifecycle_refuse_suspend()`);}
  });
  it('retains closure retention/dual-control and closed-tenant resurrection refusals',async()=>{
    const opts=closure();expect((await runClosure(url,{...opts,retentionHeldUntil:'2031-01-01'})).applied).toBe(false);
    expect((await runClosure(url,{...opts,approvedBy:opts.requestedBy})).applied).toBe(false);
    await runClosure(url,opts);const before=await state();await expect(runReactivation(url,{tenantId:b.tenantId,apply:true,today:'2026-08-03'})).rejects.toThrow('Tenant reinstatement unavailable');expect(await state()).toEqual(before);
  });
});
