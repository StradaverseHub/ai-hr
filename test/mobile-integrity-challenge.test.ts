import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {issueOwnIntegrityChallenge,consumeOwnIntegrityChallenge,type IntegrityChallengeIntent} from '../core/mobile-integrity-challenge';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeEach(async()=>{await resetDb();base=await seedBase();});
afterAll(closeAll);
async function employee(b=base){
  const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Integrity employee',primaryEmail:randomUUID()+'@integrity.test'},companyId:b.companyId,
    departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  const userId=await createAppUser(b.tenantId,hired.personId,'employee');
  const ctx:SessionContext={tenantId:b.tenantId,userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}],entitlements:harnessSnapshot(b.tenantId)};
  const intent:IntegrityChallengeIntent={employmentId:hired.employmentId,requestId:randomUUID(),appInstallationId:randomUUID(),purpose:'device.enrollment',bindingHash:'a'.repeat(64)};
  return {...hired,ctx,intent};
}
async function events(id:string){return owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,id));}
async function waitForOwnedChallengeLock(){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    const rows=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity
      where datname=current_database() and usename='ai_hr_app' and state='active' and wait_event_type='Lock'
      and query ilike '%mobile_integrity_challenge%') waiting`);
    if(rows[0]?.waiting)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('Second owned consumer did not reach its database lock');
}
describe('persistent own integrity challenges',()=>{
  it('keeps an installation identity across calls and returns exactly one immutable challenge on concurrent retries',async()=>{
    const e=await employee();
    const results=await Promise.all(Array.from({length:3},()=>issueOwnIntegrityChallenge(e.ctx,e.intent)));
    expect(new Set(results.map(row=>row.id)).size).toBe(1);expect(new Set(results.map(row=>row.nonce)).size).toBe(1);
    expect(results[0]).toMatchObject({state:'active',actorId:e.ctx.userId,employmentId:e.employmentId,purpose:'device.enrollment'});
    expect(results[0].nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(results[0].expiresAt).getTime()-new Date(results[0].issuedAt).getTime()).toBe(600000);
    const other=await issueOwnIntegrityChallenge(e.ctx,{...e.intent,requestId:randomUUID()});expect(other.installationId).toBe(results[0].installationId);
    const audit=await events(results[0].id);expect(audit).toHaveLength(1);expect(audit[0].payload).toEqual({purpose:'device.enrollment'});
    expect(JSON.stringify(audit)).not.toContain(results[0].nonce);
    await expect(withTenant(e.ctx,tx=>tx.execute(sql`select * from mobile_integrity_installation`))).rejects.toThrow();
  });
  it('refuses changing purpose, binding or app installation under the same issuance reference',async()=>{
    const e=await employee();await issueOwnIntegrityChallenge(e.ctx,e.intent);
    for(const change of [{purpose:'clock.online' as const},{bindingHash:'b'.repeat(64)},{appInstallationId:randomUUID()}])
      await expect(issueOwnIntegrityChallenge(e.ctx,{...e.intent,...change})).rejects.toMatchObject({reason:'binding_conflict'});
  });
  it('normalizes equivalent UUID spelling without replacing the stored challenge',async()=>{
    const e=await employee(),first=await issueOwnIntegrityChallenge(e.ctx,e.intent);
    const retry=await issueOwnIntegrityChallenge(e.ctx,{...e.intent,employmentId:e.intent.employmentId.toUpperCase(),
      requestId:e.intent.requestId.toUpperCase(),appInstallationId:e.intent.appInstallationId.toUpperCase()});
    expect(retry).toEqual(first);
  });
  it('serializes consumption, runs one transactional result and returns a stable terminal receipt',async()=>{
    const e=await employee(),challenge=await issueOwnIntegrityChallenge(e.ctx,{...e.intent,purpose:'clock.online'});
    expect(new Date(challenge.expiresAt).getTime()-new Date(challenge.issuedAt).getTime()).toBe(120000);
    const operation=vi.fn(async(tx:Tx)=>{
      await appendEvent(tx,{tenantId:base.tenantId,aggregateType:'integrity-test-result',aggregateId:challenge.id,eventType:'integrity.test.result',actor:actorOf(e.ctx),subjectEmploymentId:e.employmentId,payload:{}});return 'saved';
    });
    const command={...e.intent,purpose:'clock.online' as const,challengeId:challenge.id};
    const results=await Promise.all([consumeOwnIntegrityChallenge(e.ctx,command,operation),consumeOwnIntegrityChallenge(e.ctx,command,operation)]);
    expect(results.map(row=>row.state).sort()).toEqual(['already_consumed','consumed']);expect(operation).toHaveBeenCalledOnce();
    expect(results[0].consumedAt).toBe(results[1].consumedAt);
    expect((await issueOwnIntegrityChallenge(e.ctx,{...e.intent,purpose:'clock.online'})).state).toBe('consumed');
    const audit=await events(challenge.id);expect(audit.filter(row=>row.eventType==='mobile.integrity.challenge.consumed')).toHaveLength(1);
    expect(audit.filter(row=>row.eventType==='integrity.test.result')).toHaveLength(1);
  });
  it('rolls back consumption, result writes and audit together when the business callback fails',async()=>{
    const e=await employee(),challenge=await issueOwnIntegrityChallenge(e.ctx,e.intent),command={...e.intent,challengeId:challenge.id};
    await expect(consumeOwnIntegrityChallenge(e.ctx,command,async tx=>{
      await appendEvent(tx,{tenantId:base.tenantId,aggregateType:'integrity-test-result',aggregateId:challenge.id,eventType:'integrity.test.result',actor:actorOf(e.ctx),subjectEmploymentId:e.employmentId,payload:{}});
      throw new Error('synthetic rollback');
    })).rejects.toThrow('synthetic rollback');
    expect((await issueOwnIntegrityChallenge(e.ctx,e.intent)).state).toBe('active');expect(await events(challenge.id)).toHaveLength(1);
    expect(await consumeOwnIntegrityChallenge(e.ctx,command,async()=> 'retry saved')).toMatchObject({state:'consumed',value:'retry saved'});
  });
  it('waits for an in-flight consumer and reconciles the committed state after that lock releases',async()=>{
    const e=await employee(),challenge=await issueOwnIntegrityChallenge(e.ctx,e.intent),command={...e.intent,challengeId:challenge.id};
    let entered!:()=>void,release!:()=>void,calls=0;
    const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
    const operation=vi.fn(async()=>{calls++;if(calls===1){entered();await held;}return 'saved';});
    const first=consumeOwnIntegrityChallenge(e.ctx,command,operation);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([started,first.then(()=>{throw new Error('Consumer finished without entering the callback');}),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Consumer did not enter callback')),5000);})]);
      clearTimeout(timer);
      const second=consumeOwnIntegrityChallenge(e.ctx,command,operation),results=Promise.allSettled([first,second]);
      try{await waitForOwnedChallengeLock();}finally{release();}
      const outcomes=await results;
      expect(outcomes.map(row=>row.status)).toEqual(['fulfilled','fulfilled']);
      if(outcomes[0].status!=='fulfilled'||outcomes[1].status!=='fulfilled')throw new Error('Concurrent consumer failed');
      expect([outcomes[0].value.state,outcomes[1].value.state]).toEqual(['consumed','already_consumed']);
      expect(outcomes[0].value.consumedAt).toBe(outcomes[1].value.consumedAt);expect(operation).toHaveBeenCalledOnce();
    }finally{clearTimeout(timer);release();await first.catch(()=>{});}
  });
  it('enforces own active employment at issue and consume, with peer/admin/tenant refusals',async()=>{
    const e=await employee(),peer=await employee(),challenge=await issueOwnIntegrityChallenge(e.ctx,e.intent);
    const otherBase=await seedBase(),other=await employee(otherBase);
    for(const ctx of [peer.ctx,other.ctx,adminCtx(base)]){
      await expect(issueOwnIntegrityChallenge(ctx,e.intent)).rejects.toThrow();
      expect(await withTenant(ctx,tx=>tx.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,challenge.id)))).toHaveLength(0);
    }
    const operation=vi.fn(async()=> 'never');
    await expect(consumeOwnIntegrityChallenge(peer.ctx,{...peer.intent,challengeId:challenge.id},operation)).rejects.toMatchObject({reason:'not_found'});
    await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,e.ctx.userId!));
    await expect(consumeOwnIntegrityChallenge(e.ctx,{...e.intent,challengeId:challenge.id},operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });
  it('caps outstanding challenges while preserving retries of an already committed reference',async()=>{
    const e=await employee();const first=await issueOwnIntegrityChallenge(e.ctx,e.intent);
    for(let i=0;i<3;i++)await issueOwnIntegrityChallenge(e.ctx,{...e.intent,requestId:randomUUID()});
    await expect(issueOwnIntegrityChallenge(e.ctx,{...e.intent,requestId:randomUUID()})).rejects.toMatchObject({retryAfter:expect.any(Number)});
    expect((await issueOwnIntegrityChallenge(e.ctx,e.intent)).id).toBe(first.id);
    expect(await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.actorId,e.ctx.userId!))).toHaveLength(4);
  });
  it('applies the shared enrollment issuance rate even when earlier challenges were consumed',async()=>{
    const e=await employee();let first:Awaited<ReturnType<typeof issueOwnIntegrityChallenge>>|undefined;
    for(let i=0;i<5;i++){
      const intent={...e.intent,requestId:i===0?e.intent.requestId:randomUUID()},challenge=await issueOwnIntegrityChallenge(e.ctx,intent);
      first??=challenge;await consumeOwnIntegrityChallenge(e.ctx,{...intent,challengeId:challenge.id},async()=>null);
    }
    await expect(issueOwnIntegrityChallenge(e.ctx,{...e.intent,requestId:randomUUID()})).rejects.toMatchObject({retryAfter:expect.any(Number)});
    expect((await issueOwnIntegrityChallenge(e.ctx,e.intent)).id).toBe(first!.id);
    const peer=await employee();expect((await issueOwnIntegrityChallenge(peer.ctx,peer.intent)).state).toBe('active');
  });
  it('refuses a different binding at consumption and never invokes that callback',async()=>{
    const e=await employee(),challenge=await issueOwnIntegrityChallenge(e.ctx,e.intent),operation=vi.fn(async()=>null);
    await expect(consumeOwnIntegrityChallenge(e.ctx,{...e.intent,challengeId:challenge.id,bindingHash:'b'.repeat(64)},operation)).rejects.toMatchObject({reason:'binding_conflict'});
    expect(operation).not.toHaveBeenCalled();expect((await issueOwnIntegrityChallenge(e.ctx,e.intent)).state).toBe('active');
  });
  it('enforces the shorter online expiry in the database as well as the service',async()=>{
    const e=await employee(),identity=await owner.db.select().from(schema.mobileIntegrityInstallation),now=new Date();
    await expect(withTenant(e.ctx,tx=>tx.insert(schema.mobileIntegrityChallenge).values({...e.intent,purpose:'clock.online',tenantId:base.tenantId,actorId:e.ctx.userId!,
      installationId:identity[0].installationId,nonce:'D'+'A'.repeat(42),issuedAt:now,expiresAt:new Date(now.getTime()+180000)}))).rejects.toThrow();
  });
  it('retains expired references without minting a fresh nonce or running the consumer',async()=>{
    const e=await employee(),now=Date.now();
    const identity=await owner.db.select().from(schema.mobileIntegrityInstallation);
    const [row]=await owner.db.insert(schema.mobileIntegrityChallenge).values({...e.intent,tenantId:base.tenantId,actorId:e.ctx.userId!,installationId:identity[0].installationId,
      nonce:'B'+'A'.repeat(42),issuedAt:new Date(now-600000),expiresAt:new Date(now-1000)}).returning();
    const retry=await issueOwnIntegrityChallenge(e.ctx,e.intent);expect(retry).toMatchObject({id:row.id,nonce:row.nonce,state:'expired'});
    const operation=vi.fn(async()=> 'never');
    await expect(consumeOwnIntegrityChallenge(e.ctx,{...e.intent,challengeId:row.id},operation)).rejects.toMatchObject({reason:'expired'});
    expect(operation).not.toHaveBeenCalled();
  });
  it('prevents raw application rewrites, reopening, deletion and cross-actor insertion',async()=>{
    const e=await employee(),peer=await employee(),challenge=await issueOwnIntegrityChallenge(e.ctx,e.intent);
    await expect(withTenant(e.ctx,tx=>tx.update(schema.mobileIntegrityChallenge).set({bindingHash:'b'.repeat(64)}).where(eq(schema.mobileIntegrityChallenge.id,challenge.id)))).rejects.toThrow();
    await consumeOwnIntegrityChallenge(e.ctx,{...e.intent,challengeId:challenge.id},async()=>null);
    await expect(withTenant(e.ctx,tx=>tx.update(schema.mobileIntegrityChallenge).set({consumedAt:null}).where(eq(schema.mobileIntegrityChallenge.id,challenge.id)))).rejects.toThrow();
    await expect(withTenant(e.ctx,tx=>tx.delete(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,challenge.id)))).rejects.toThrow();
    const [row]=await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,challenge.id));
    await expect(withTenant(peer.ctx,tx=>tx.insert(schema.mobileIntegrityChallenge).values({...row,id:randomUUID(),requestId:randomUUID(),nonce:'C'+'A'.repeat(42),consumedAt:null}))).rejects.toThrow();
  });
});
