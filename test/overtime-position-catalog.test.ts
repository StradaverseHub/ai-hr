import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {asc,eq} from 'drizzle-orm';
import * as s from '../db/schema';
import {overtimePatternSetup,overtimePositionChoices,listOvertimePatterns} from '../packs/attendance/service';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');});
afterAll(closeAll);
describe('Overtime workspace with a real catalogue above 500 positions',()=>{
 it('loads the workspace and pages all 527 positions without changing saved configuration or audit',async()=>{
  await owner.db.update(s.position).set({archivedAt:new Date()}).where(eq(s.position.id,b.positionId));
  const inserted=await owner.db.insert(s.position).values(Array.from({length:527},(_,index)=>({tenantId:b.tenantId,companyId:b.companyId,isGlobal:false,title:'OT-CATALOG-'+String(index).padStart(4,'0'),label:'Fictional position '+String(index).padStart(4,'0')}))).returning();
  const ctx=await entitledCtx(b),before=await owner.db.select().from(s.position).orderBy(asc(s.position.id)),events=await owner.db.select().from(s.domainEvent).orderBy(asc(s.domainEvent.id));
  const setup=await overtimePatternSetup(ctx,{companyIds:[b.companyId],limit:100});expect(setup.choices.positionId).toHaveLength(500);expect(await listOvertimePatterns(ctx,{companyIds:[b.companyId]})).toEqual({items:[],nextCursor:null});
  const first=await overtimePositionChoices(ctx,{companyIds:[b.companyId]});expect(first.items).toHaveLength(500);expect(first.nextCursor).not.toBeNull();
  const rest=await overtimePositionChoices(ctx,{companyIds:[b.companyId],cursor:first.nextCursor!});expect(rest.items).toHaveLength(27);expect(rest.nextCursor).toBeNull();
  expect(new Set([...first.items,...rest.items].map(item=>item.id))).toEqual(new Set(inserted.map(item=>item.id)));
  expect(await owner.db.select().from(s.position).orderBy(asc(s.position.id))).toEqual(before);expect(await owner.db.select().from(s.domainEvent).orderBy(asc(s.domainEvent.id))).toEqual(events);
 });
 it('searches the complete scoped catalogue and resolves saved IDs beyond the first page',async()=>{
  const positions=await owner.db.insert(s.position).values(Array.from({length:527},(_,index)=>({tenantId:b.tenantId,companyId:b.companyId,isGlobal:false,title:'CODE-'+String(index).padStart(4,'0'),label:'Fixture '+index}))).returning();
  const ctx=await entitledCtx(b),first=await overtimePositionChoices(ctx,{companyIds:[b.companyId]}),offPage=positions.find(item=>!first.items.some(choice=>choice.id===item.id))!;
  expect(offPage).toBeDefined();const found=await overtimePositionChoices(ctx,{companyIds:[b.companyId],search:offPage.title,selectedIds:[offPage.id]});expect(found.items).toEqual([{id:offPage.id,label:offPage.label}]);
  await owner.db.update(s.position).set({archivedAt:new Date()}).where(eq(s.position.id,offPage.id));expect((await overtimePositionChoices(ctx,{companyIds:[b.companyId],search:offPage.title,selectedIds:[offPage.id]})).items).toEqual([]);
 });
 it('does not widen scope through selected IDs or a forged company',async()=>{
  const ctx=await entitledCtx(b),other=await seedBase();
  const [secret]=await owner.db.insert(s.position).values({tenantId:other.tenantId,companyId:other.companyId,title:'Foreign position',isGlobal:false}).returning();
  expect((await overtimePositionChoices(ctx,{companyIds:[b.companyId],search:'Foreign',selectedIds:[secret.id]})).items).toEqual([]);
  await expect(overtimePositionChoices(ctx,{companyIds:[other.companyId]})).rejects.toMatchObject({code:'permission'});
  expect(await overtimePositionChoices(ctx,{companyIds:[]})).toEqual({items:[],nextCursor:null});
 });
});
