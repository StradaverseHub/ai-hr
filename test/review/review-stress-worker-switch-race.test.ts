/** REVIEW (stress and concurrency) — first-time worker switch changes racing. Written as if at test/review/worker-switch-race.test.ts.
 *
 * core/agent-registry/controls.ts:88-96 reads the "before" state with SELECT ... FOR UPDATE, which locks
 * nothing when the tenant has no row yet. Concurrent first changes all read "off", then serialise on the
 * ON CONFLICT upsert, so the audit events claim off->on several times and their `from` no longer chains to the
 * previous version's `to`. The switch value itself ends correct; only the audit/outcome trail is wrong. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../../db/schema';
import type {SessionContext} from '../../db/client';
import {hireEmployee} from '../../core/org';
import {setWorkerSwitch} from '../../core/agent-registry/controls';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from '../harness';

let b:Base,hr:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Switch Administrator',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,'hr_admin');
 hr={...await entitledCtx(b,['hr_admin']),userId,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} as SessionContext;
});

describe('worker switch audit under concurrency',()=>{
 it('REVIEW low: 8 concurrent first-time switch-ons leave an audit trail whose "from" chains to the previous "to" (controls.ts:88-96)',async()=>{
  await Promise.all(Array.from({length:8},()=>setWorkerSwitch(hr,{workerId:'approver_recommendation',enabled:true})));
  const events=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent)
   .where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.aggregateType,'teras-worker'))).orderBy(asc(schema.domainEvent.occurredAt),asc(schema.domainEvent.id));
  const trail=events.map(row=>row.payload as {from:boolean;to:boolean;version:number});
  expect(trail).toHaveLength(8);
  // The row went off -> on exactly once (version stays 1: the 0890 bump trigger ignores a same-value write),
  // so at most one audit event may claim an off -> on change; the others are no-ops (from = to = true).
  expect(new Set(trail.map(row=>row.version))).toEqual(new Set([1]));
  expect(trail.filter(row=>row.from!==row.to)).toHaveLength(1);
 },60_000);
});
