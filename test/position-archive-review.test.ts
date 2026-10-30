import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {archivePosition,updatePosition} from '../core/admin';
import {preparePositionArchiveTx,confirmPositionArchiveTx} from '../core/position-archive-review';
import {POSITION_ARCHIVE_ACTION as action,PositionArchiveHuman} from '../lib/assistant-actions/position-archive-contract';
import {adminCtx,owner,resetDb,seedBase,closeAll,type Base} from './harness';
let b:Base;
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(closeAll);
const human=(base:Base,archived=true)=>({action,contractVersion:1 as const,positionId:base.positionId,expectedArchived:!archived,archived});
const prepare=(base:Base,input=human(base))=>withTenant(adminCtx(base),tx=>preparePositionArchiveTx(tx,adminCtx(base),input));
const confirm=(base:Base,digest:string,input=human(base))=>withTenant(adminCtx(base),tx=>confirmPositionArchiveTx(tx,adminCtx(base),input,{action,contractVersion:1,reviewedDigest:digest}));
describe('position catalogue archive source, pending Assistant custody',()=>{
 it('rejects unknown fields, fake employee binding and no-op intent',()=>{
  expect(PositionArchiveHuman.safeParse({...human(b),employmentId:b.positionId}).success).toBe(false);
  expect(PositionArchiveHuman.safeParse({...human(b),expectedArchived:true}).success).toBe(false);
 });
 it('archives and restores with the exact native row and event UUID',async()=>{
  const first=await prepare(b);expect(first.review).toMatchObject({positionId:b.positionId,archived:false,afterArchived:true});
  const receipt=await confirm(b,first.reviewedDigest);
  const [event]=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.id,receipt.eventId));
  expect(event).toMatchObject({tenantId:b.tenantId,aggregateType:'position',aggregateId:b.positionId,eventType:'position.archived'});
  const [row]=await owner.db.select().from(schema.position).where(eq(schema.position.id,b.positionId));expect(row.archivedAt).not.toBeNull();
  const restore=human(b,false),next=await prepare(b,restore);expect((await confirm(b,next.reviewedDigest,restore)).archived).toBe(false);
 });
 it('refuses stale title changes without creating an archive effect',async()=>{
  const first=await prepare(b);await updatePosition(adminCtx(b),{id:b.positionId,title:'Changed fictional position'});
  await expect(confirm(b,first.reviewedDigest)).rejects.toThrow();
  const [row]=await owner.db.select().from(schema.position).where(eq(schema.position.id,b.positionId));expect(row.archivedAt).toBeNull();
 });
 it('refuses archive/restore ABA using the source row revision',async()=>{
  const first=await prepare(b);await archivePosition(adminCtx(b),{id:b.positionId,archived:true});await archivePosition(adminCtx(b),{id:b.positionId,archived:false});
  await expect(confirm(b,first.reviewedDigest)).rejects.toThrow();
 });
 it('refuses foreign tenant IDs',async()=>{const other=await seedBase();await expect(prepare(b,human(other))).rejects.toThrow();});
 it('refuses a global label whose consequences exceed one company',async()=>{
  await owner.db.update(schema.position).set({isGlobal:true}).where(eq(schema.position.id,b.positionId));await expect(prepare(b)).rejects.toThrow();
 });
 it('refuses an ordinary employee without treating read visibility as write authority',async()=>{
  const ctx={...adminCtx(b),roles:['employee' as const],grants:[{role:'employee' as const,companyId:b.companyId}]};
  await expect(withTenant(ctx,tx=>preparePositionArchiveTx(tx,ctx,human(b)))).rejects.toThrow();
 });
});
