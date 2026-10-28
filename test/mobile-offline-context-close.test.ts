/** Own retirement of an offline context: real SQL/RLS/locks/0647 triggers, real issuance and consumption owners.
 * Vendor preparation and adjudication policy are synthetic (review only), so no attendance fact is involved. */
import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as S from '../db/schema';
import {withTenant} from '../db/client';
import {closeOwnOfflineContext,createOfflineContextIssueService} from '../core/mobile-offline-context';
import {createOfflineClaimService,type OfflineClaimPorts} from '../core/mobile-offline-claim';
import {createAppleClockAssertionService} from '../core/mobile-apple-clock-assertion';
import {assertNoOfflineClockLeaseTx} from '../core/mobile-offline-lease';
import {offlineContextIssuerIdentity} from '../lib/mobile-api/offline-context-signature';
import {closeAll,owner,resetDb,seedBase,type Base} from './harness';
import {offlineServiceFixture} from './helpers/mobile-offline-service-fixture';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
let base:Base,restore:(()=>Promise<void>)|undefined,restoreCustody:(()=>Promise<void>)|undefined;
beforeAll(async()=>{restoreCustody=await installCustodyDraftForWorker();restore=await installOfflineDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-close-fixture-secret-2026');await resetDb();base=await seedBase();});
afterAll(async()=>{try{await resetDb();await restore?.();await restoreCustody?.();}finally{vi.unstubAllEnvs();await closeAll();}});
type Fixture=Awaited<ReturnType<typeof offlineServiceFixture>>;
const apple={apiOrigin:'https://hr.example.com',target:{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production',requiredMetadata:null}};
function consumer(){
 const ports:OfflineClaimPorts={prepare:async()=>({assertFresh:async()=>{}}),adjudicate:async()=>({outcome:'needs_review',reason:'review_required'}),beforeCommit:async()=>{}};
 return createOfflineClaimService({apiOrigin:apple.apiOrigin,photoRetentionMs:3600000},ports);
}
const second=(f:Fixture,previous:string)=>({...f.claim,permit:f.context.permits[1],chain:{sequence:2,previousSha256:previous},command:{...f.claim.command,requestId:randomUUID()}});
const stream=async(f:Fixture)=>(await owner.db.select().from(S.mobileOfflineContext).where(eq(S.mobileOfflineContext.id,f.context.id)))[0];
const closeEvents=async()=>owner.db.select().from(S.domainEvent).where(eq(S.domainEvent.eventType,'mobile.offline.context.closed'));
const onlineInput=(f:Fixture)=>({employmentId:f.e.employmentId,appInstallationId:f.key.appInstallationId,keyId:f.key.id,command:{requestId:randomUUID(),action:'out' as const,lat:3,lng:101,accuracy:4,sampledAt:Date.now()},
 evidence:{platform:'ios' as const,appId:'ai.hr',appVersion:'1',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}});
describe('own offline context retirement',()=>{
 it('retires a context only at the consumed cursor, after progress or with none, and records one audit event',async()=>{
  const f=await offlineServiceFixture(base),first=await consumer().consume(f.ctx,f.signed()),closeRequestId=randomUUID();
  const closed=await closeOwnOfflineContext(f.ctx,{contextId:f.context.id,closeRequestId,consumedThrough:1});
  expect(closed).toMatchObject({outcome:'closed',contextId:f.context.id,reason:'retired',closeRequestId,consumedThrough:1});
  expect(await stream(f)).toMatchObject({nextSequence:2,previousDigest:first.digest,closeReason:'retired',closeRequestId});expect((await stream(f)).closedAt?.getTime()).toBe(closed.closedAt);
  const events=await closeEvents();expect(events).toHaveLength(1);expect(events[0]).toMatchObject({aggregateId:f.context.id,subjectEmploymentId:f.e.employmentId,payload:{reason:'retired',consumedThrough:1,keyId:f.key.id}});
  // A context with no progress closes too (0647 permits a no-progress close).
  const g=await offlineServiceFixture(base),none=await closeOwnOfflineContext(g.ctx,{contextId:g.context.id,closeRequestId:randomUUID(),consumedThrough:0});
  expect(none).toMatchObject({reason:'retired',consumedThrough:0});expect(await stream(g)).toMatchObject({nextSequence:1,previousDigest:null,closeReason:'retired'});
  // The closed stream accepts no further claim.
  await expect(consumer().consume(f.ctx,f.signed(second(f,first.digest)))).rejects.toMatchObject({reason:'context_unavailable'});
 });
 it('refuses while the phone holds unconsumed claims or is behind the server cursor, changing nothing',async()=>{
  const f=await offlineServiceFixture(base);
  await expect(closeOwnOfflineContext(f.ctx,{contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough:1})).rejects.toMatchObject({reason:'claims_pending'});
  expect(await stream(f)).toMatchObject({nextSequence:1,closedAt:null});
  await consumer().consume(f.ctx,f.signed());
  for(const [consumedThrough,reason] of [[2,'claims_pending'],[0,'cursor_mismatch']] as const)
   await expect(closeOwnOfflineContext(f.ctx,{contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough})).rejects.toMatchObject({reason});
  expect(await stream(f)).toMatchObject({nextSequence:2,closedAt:null,closeReason:null,closeRequestId:null});expect(await closeEvents()).toHaveLength(0);
  for(const consumedThrough of [-1,33,1.5])await expect(closeOwnOfflineContext(f.ctx,{contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough})).rejects.toThrow();
  await expect(closeOwnOfflineContext(f.ctx,{contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough:1,reason:'revoked'})).rejects.toThrow();
  expect((await stream(f)).closedAt).toBeNull();
 });
 it('is idempotent by closeRequestId, never reopens, and refuses another request on a closed or exhausted context',async()=>{
  const f=await offlineServiceFixture(base),input={contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough:0};
  const [a,b]=await Promise.all([closeOwnOfflineContext(f.ctx,input),closeOwnOfflineContext(f.ctx,input)]);expect(a).toEqual(b);
  expect(await closeOwnOfflineContext(f.ctx,input)).toEqual(a);expect(await closeEvents()).toHaveLength(1);
  await expect(closeOwnOfflineContext(f.ctx,{...input,closeRequestId:randomUUID()})).rejects.toMatchObject({reason:'context_closed'});
  await expect(closeOwnOfflineContext(f.ctx,{...input,consumedThrough:1})).rejects.toMatchObject({reason:'binding_conflict'});
  const g=await offlineServiceFixture(base),c=consumer(),first=await c.consume(g.ctx,g.signed());await c.consume(g.ctx,g.signed(second(g,first.digest)));
  expect(await stream(g)).toMatchObject({nextSequence:3,closeReason:'exhausted'});
  await expect(closeOwnOfflineContext(g.ctx,{contextId:g.context.id,closeRequestId:randomUUID(),consumedThrough:2})).rejects.toMatchObject({reason:'context_closed'});
  expect(await stream(g)).toMatchObject({closeReason:'exhausted'});expect(await closeEvents()).toHaveLength(1);
 });
 it('releases the key lease so online clocking and a new issuance work again',async()=>{
  const f=await offlineServiceFixture(base),online=createAppleClockAssertionService(apple);
  await expect(online.begin(f.ctx,onlineInput(f))).rejects.toMatchObject({reason:'offline_pending'});
  await expect(withTenant(f.ctx,tx=>assertNoOfflineClockLeaseTx(tx,f.ctx,f.key.appInstallationId,f.key.id))).rejects.toMatchObject({reason:'offline_pending'});
  await closeOwnOfflineContext(f.ctx,{contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough:0});
  await withTenant(f.ctx,tx=>assertNoOfflineClockLeaseTx(tx,f.ctx,f.key.appInstallationId,f.key.id));
  // A new stream can be issued on the same key, and it holds the lease again until it too is retired.
  const pair=generateKeyPairSync('ed25519'),identity=offlineContextIssuerIdentity(pair.privateKey);
  const service=createOfflineContextIssueService({apiOrigin:apple.apiOrigin,privateKey:pair.privateKey,issuer:{...identity,validFrom:Date.now()-60000,validUntil:Date.now()+86400000,revoked:false},maximumIssuesPerHour:4},
   {snapshot:async()=>({policy:f.context.policy,sites:f.context.sites,attendance:f.context.attendance,target:f.context.target,permitCount:2}),beforeCommit:async()=>{}});
  const request={requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url'),appInstallationId:f.key.appInstallationId,keyId:f.key.id};
  const next=await service.issue(f.ctx,{employmentId:f.e.employmentId,request});expect(next.outcome).toBe('issued');
  await expect(online.begin(f.ctx,onlineInput(f))).rejects.toMatchObject({reason:'offline_pending'});
  await closeOwnOfflineContext(f.ctx,{contextId:next.contextId,closeRequestId:randomUUID(),consumedThrough:0});
  expect((await online.begin(f.ctx,onlineInput(f))).challenge.id).toEqual(expect.any(String));
  expect((await owner.db.select().from(S.mobileOfflineContext)).map(row=>row.closeReason)).toEqual(['retired','retired']);
 });
 it('refuses another actor, another tenant and an unknown context without changing the stream',async()=>{
  const f=await offlineServiceFixture(base),peer=await offlineServiceFixture(base),input={contextId:f.context.id,closeRequestId:randomUUID(),consumedThrough:0};
  await expect(closeOwnOfflineContext(peer.ctx,input)).rejects.toMatchObject({reason:'context_unavailable'});
  await expect(closeOwnOfflineContext({...f.ctx,tenantId:randomUUID()},input)).rejects.toThrow();
  await expect(closeOwnOfflineContext(f.ctx,{...input,contextId:randomUUID()})).rejects.toMatchObject({reason:'context_unavailable'});
  expect(await stream(f)).toMatchObject({closedAt:null});expect(await closeEvents()).toHaveLength(0);
 });
});
