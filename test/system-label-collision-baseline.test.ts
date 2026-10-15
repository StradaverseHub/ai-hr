/** Real app-role regressions for migration-observed inheritance. UNRUN until coordinated DB window. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type Tx} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {bulkSaveLabels} from '../core/admin';
import {labelIdsForCompany,setLabelCriteria,setLabelCriteriaBatch,refusedLabelCollisionProposalsTx} from '../core/system-labels';
import {downloadSystemLabelsWithData,previewSystemLabelImport,applySystemLabelImport} from '../core/system-label-import';
import {buildSystemLabelWorkbook} from '../lib/system-label-workbook';
import {PersonnelImportLookup} from '../lib/personnel-import-lookup';
let b:Base;
let f:{companies:string[];costs:string[];positions:string[]};
const migration=readFileSync(new URL('../db/migrations/0550_system_label_company_criteria.sql',import.meta.url),'utf8');
const capture=migration.slice(migration.indexOf('DO $$',migration.indexOf('-- BEGIN INHERITED LABEL COLLISION CAPTURE')),migration.indexOf('-- END INHERITED LABEL COLLISION CAPTURE'));
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 const companies=[b.companyId,...(await owner.db.insert(s.company).values([1,2].map(i=>({tenantId:b.tenantId,legalName:`Fictional inherited ${i}`}))).returning({id:s.company.id})).map(row=>row.id)];
 const costs=[randomUUID(),randomUUID(),randomUUID()],positions=[randomUUID(),randomUUID()];
 // Only privileged fixture setup simulates PRE-migration rows. Re-enable within the transaction;
 // rollback also restores trigger state. No application bypass/seeding API is introduced.
 await owner.db.transaction(async tx=>{
  await tx.execute(sql`alter table cost_center disable trigger user`);
  await tx.execute(sql`alter table position disable trigger user`);
  await tx.execute(sql`alter table label_company_assignment disable trigger user`);
  await tx.insert(s.costCenter).values(costs.map((id,i)=>({id,tenantId:b.tenantId,companyId:companies[i],code:i===1?' hQ ':'HQ',name:`Fictional HQ ${i}`,isGlobal:i<2})));
  await tx.insert(s.position).values(positions.map((id,i)=>({id,tenantId:b.tenantId,companyId:companies[i],title:i?' Machine Operator ':'Machine Operator',isGlobal:true})));
  await tx.insert(s.labelCompanyAssignment).values({tenantId:b.tenantId,labelKind:'cost_center',labelId:costs[2],companyId:companies[2]});
  await tx.execute(sql.raw(capture));
  await tx.execute(sql`alter table cost_center enable trigger user`);
  await tx.execute(sql`alter table position enable trigger user`);
  await tx.execute(sql`alter table label_company_assignment enable trigger user`);
 });
 f={companies,costs,positions};
});
async function caps(){return owner.db.select().from(s.systemLabelCollisionBaseline).where(eq(s.systemLabelCollisionBaseline.tenantId,b.tenantId));}
async function editCost(id:string,p:Record<string,unknown>){return bulkSaveLabels(adminCtx(b),'cost_center',{creates:[],updates:[{id,key:id,...p}]});}
async function forceChecks(tx:Tx){await tx.execute(sql`set constraints all immediate`);}
describe('bounded inherited System Label collisions',()=>{
 it('captures exactly four synthetic pairs without rewriting IDs/codes/availability; Global pairs include future companies',async()=>{
  const rows=await caps();expect(rows).toHaveLength(4);expect(rows.filter(row=>row.allCompanies)).toHaveLength(2);
  for(const row of rows){expect(row.firstLabelId<row.secondLabelId).toBe(true);expect(row.retiredAt).toBeNull();if(!row.allCompanies)expect(row.companyIds).toEqual([f.companies[2]]);}
  expect((await owner.db.select().from(s.costCenter).where(eq(s.costCenter.id,f.costs[1])))[0]).toMatchObject({code:' hQ ',isGlobal:true,companyId:f.companies[1]});
  const [future]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional future company'}).returning({id:s.company.id});
  expect(await labelIdsForCompany(adminCtx(b),'cost_center',future.id)).toEqual(expect.arrayContaining(f.costs.slice(0,2)));
  expect(await labelIdsForCompany(adminCtx(b),'cost_center',future.id)).not.toContain(f.costs[2]);
  await editCost(f.costs[0],{name:'Metadata remains editable',label:'HQ retained'});
  expect((await caps()).map(row=>({id:row.id,all:row.allCompanies,companies:row.companyIds,retired:row.retiredAt}))).toEqual(rows.map(row=>({id:row.id,all:row.allCompanies,companies:row.companyIds,retired:row.retiredAt})));
 });
 it('uses a genuinely restricted app role and rejects baseline forgery, callable reducer and fake GUC exemptions',async()=>{
  const role=await withTenant(adminCtx(b),tx=>tx.execute(sql`select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`)) as unknown as {name:string;rolsuper:boolean;rolbypassrls:boolean}[];
  expect(role[0]).toEqual({name:'ai_hr_app',rolsuper:false,rolbypassrls:false});
  const id=(await caps())[0].id;
  for(const statement of [sql`update system_label_collision_baseline set all_companies=true where id=${id}::uuid`,sql`delete from system_label_collision_baseline where id=${id}::uuid`,sql`truncate system_label_collision_baseline`,
   sql`insert into system_label_collision_baseline(tenant_id,label_kind,normalized_code,first_label_id,second_label_id,all_companies) values(${b.tenantId}::uuid,'cost_center','hq',${randomUUID()}::uuid,${randomUUID()}::uuid,true)`]){
   await expect(withTenant(adminCtx(b),tx=>tx.execute(statement))).rejects.toThrow();
  }
  const privileges=await withTenant(adminCtx(b),tx=>tx.execute(sql`select has_function_privilege(current_user,'app.reduce_system_label_collision_baseline()','EXECUTE') as allowed`)) as unknown as {allowed:boolean}[];
  expect(privileges[0].allowed).toBe(false);
  await expect(withTenant(adminCtx(b),async tx=>{await tx.execute(sql`select set_config('app.allow_label_collision','true',true)`);await tx.insert(s.costCenter).values({tenantId:b.tenantId,companyId:b.companyId,code:'HQ',name:'New forbidden identity',isGlobal:true});await forceChecks(tx);})).rejects.toThrow(/conflict/);
 });
 it('allows reductions then permanently refuses finite re-expansion or restoring Global',async()=>{
  const admin=adminCtx(b);
  await expect(setLabelCriteria(admin,{kind:'cost_center',labelId:f.costs[2],isGlobal:false,companyIds:[f.companies[2],f.companies[1]]})).rejects.toThrow(/same code|conflict/);
  // Narrow an originally Global/Global pair to the already incumbent scoped company; all three
  // pairs still exist, and their caps now each reflect only that company.
  await setLabelCriteriaBatch(admin,f.costs.slice(0,2).map(labelId=>({kind:'cost_center' as const,labelId,isGlobal:false,companyIds:[f.companies[2]]})));
  expect((await caps()).filter(row=>row.labelKind==='cost_center').every(row=>!row.allCompanies&&row.companyIds.length===1&&row.companyIds[0]===f.companies[2])).toBe(true);
  await expect(setLabelCriteriaBatch(admin,f.costs.map(labelId=>({kind:'cost_center' as const,labelId,isGlobal:false,companyIds:[f.companies[2],f.companies[0]]})))).rejects.toThrow(/same code|conflict/);
  await expect(setLabelCriteriaBatch(admin,f.costs.slice(0,2).map(labelId=>({kind:'cost_center' as const,labelId,isGlobal:true,companyIds:[]})))).rejects.toThrow(/same code|conflict/);
  expect((await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'system-label-collision.reduced'))).length).toBeGreaterThan(0);
 });
 it('shrinks finite intersections and retires a disjoint resolution permanently',async()=>{
  const admin=adminCtx(b),first=f.positions[0],second=f.positions[1];
  await setLabelCriteria(admin,{kind:'position',labelId:first,isGlobal:false,companyIds:f.companies.slice(0,2)});
  await setLabelCriteria(admin,{kind:'position',labelId:first,isGlobal:false,companyIds:[f.companies[0]]});
  const narrowed=(await caps()).find(row=>row.labelKind==='position')!;
  expect(narrowed.allCompanies).toBe(false);expect(narrowed.companyIds).toEqual([f.companies[0]]);
  await expect(setLabelCriteria(admin,{kind:'position',labelId:first,isGlobal:false,companyIds:f.companies.slice(0,2)})).rejects.toThrow(/same code|conflict/);
  expect((await caps()).find(row=>row.id===narrowed.id)).toEqual(narrowed);
  await setLabelCriteria(admin,{kind:'position',labelId:second,isGlobal:false,companyIds:[f.companies[1]]});
  expect((await caps()).find(row=>row.id===narrowed.id)?.retiredAt).toBeInstanceOf(Date);
  await expect(setLabelCriteria(admin,{kind:'position',labelId:second,isGlobal:false,companyIds:[f.companies[0]]})).rejects.toThrow(/same code|conflict/);
 });
 it('does not transfer an inherited exception to a newly shared code even for the same IDs',async()=>{
  const before=await caps();
  await expect(bulkSaveLabels(adminCtx(b),'position',{creates:[],updates:f.positions.map(id=>({id,key:id,title:'New duplicate code'}))})).rejects.toThrow(/same code|conflict/);
  expect(await caps()).toEqual(before);
 });
 it('retains scoped origin-admin metadata authority without granting Global changes or another origin',async()=>{
  const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:randomUUID()}).returning({id:s.appUser.id});
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId});
  const ctx={...adminCtx(b),userId:user.id,grants:[{role:'hr_admin' as const,companyId:b.companyId}]};
  await bulkSaveLabels(ctx,'cost_center',{creates:[],updates:[{id:f.costs[0],key:f.costs[0],label:'Scoped metadata'}]});
  await expect(bulkSaveLabels(ctx,'cost_center',{creates:[],updates:[{id:f.costs[1],key:f.costs[1],label:'Other origin'}]})).rejects.toThrow();
  await expect(setLabelCriteria(ctx,{kind:'cost_center',labelId:f.costs[0],isGlobal:false,companyIds:[b.companyId]})).rejects.toThrow(/group administrator/);
 });
 it.each(['rename','archive','delete'] as const)('retires the exact %s-resolved pair and refuses recreation',async action=>{
  const id=f.positions[0],admin=adminCtx(b);
  if(action==='rename')await bulkSaveLabels(admin,'position',{creates:[],updates:[{id,key:id,title:'Distinct recorded identifier'}]});
  else if(action==='archive')await bulkSaveLabels(admin,'position',{creates:[],updates:[{id,key:id,archived:true}]});
  else await withTenant(admin,tx=>tx.delete(s.position).where(eq(s.position.id,id)));
  const row=(await caps()).find(row=>row.labelKind==='position')!;expect(row.retiredAt).toBeInstanceOf(Date);
  if(action==='rename')await expect(bulkSaveLabels(admin,'position',{creates:[],updates:[{id,key:id,title:'Machine Operator'}]})).rejects.toThrow(/same code|conflict/);
  else if(action==='archive')await expect(bulkSaveLabels(admin,'position',{creates:[],updates:[{id,key:id,archived:false}]})).rejects.toThrow(/same code|conflict/);
  else await expect(withTenant(admin,async tx=>{await tx.insert(s.position).values({id,tenantId:b.tenantId,companyId:b.companyId,title:'Machine Operator',isGlobal:true});await forceChecks(tx);})).rejects.toThrow(/conflict/);
  expect((await caps()).find(cap=>cap.id===row.id)?.retiredAt).toEqual(row.retiredAt);
 });
 it('cannot borrow a pair for a different code, kind, identity or tenant',async()=>{
  const base={key:'exact',kind:'cost_center' as const,code:'hq',first:{id:f.costs[0],global:true,companyIds:[]},second:{id:f.costs[1],global:true,companyIds:[]}};
  await withTenant(adminCtx(b),async tx=>{
   expect(await refusedLabelCollisionProposalsTx(tx,b.tenantId,[base])).toEqual([]);
   for(const changed of [{...base,code:'elsewhere'},{...base,kind:'department' as const},{...base,first:{...base.first,id:null}},{...base,first:{...base.first,id:randomUUID()}}])expect(await refusedLabelCollisionProposalsTx(tx,b.tenantId,[changed])).toEqual(['exact']);
   expect(await refusedLabelCollisionProposalsTx(tx,randomUUID(),[base])).toEqual(['exact']);
  });
 });
 it('preview/apply preserve inherited metadata and no-op export; new overlap refuses in both paths',async()=>{
  const admin=adminCtx(b),exported=await downloadSystemLabelsWithData(admin,{companyIds:f.companies,kinds:['cost_center','position'],includeInactive:false});
  const noop=await previewSystemLabelImport(admin,exported,'merge');expect(noop.valid).toBe(true);expect(noop.rows.every(row=>row.outcome==='skip')).toBe(true);
  expect(await applySystemLabelImport(admin,{bytes:exported,mode:'merge',token:noop.token,confirmUpdates:true})).toMatchObject({imported:0,updated:0,failed:0});
  const bytes=await buildSystemLabelWorkbook({kinds:['cost_center'],references:{companies:[],grades:[],employees:[]},rows:{cost_center:[{Company:b.companyId,Code:'HQ',Label:'Editable incumbent',Description:'Fictional edited description',Criteria:'global','Criteria Companies':''}]}});
  const preview=await previewSystemLabelImport(admin,bytes,'update');expect(preview.valid).toBe(true);
  await applySystemLabelImport(admin,{bytes,mode:'update',token:preview.token,confirmUpdates:true});
  expect((await owner.db.select().from(s.costCenter).where(eq(s.costCenter.id,f.costs[0])))[0].label).toBe('Editable incumbent');
  const [newCo]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional new conflicting origin'}).returning({id:s.company.id});
  const bad=await buildSystemLabelWorkbook({kinds:['cost_center'],references:{companies:[],grades:[],employees:[]},rows:{cost_center:[{Company:newCo.id,Code:'HQ',Label:'New row',Description:'Must refuse',Criteria:'global','Criteria Companies':''}]}});
  const refusal=await previewSystemLabelImport(admin,bad,'add');expect(refusal.valid).toBe(false);expect(refusal.rows[0].outcome).toBe('error');
  await expect(applySystemLabelImport(admin,{bytes:bad,mode:'add',token:refusal.token,confirmUpdates:true})).rejects.toThrow(/conflicting row/);
 });
 it('keeps Personnel aliases ambiguous and exact ID selection stable',()=>{
  const lookup=new PersonnelImportLookup<string>();for(const id of f.costs)lookup.add(id,id,{codes:['HQ'],names:['Head Office']});
  expect(lookup.isAmbiguous('HQ')).toBe(true);expect(lookup.get('HQ')).toBeUndefined();expect(lookup.get('Head Office')).toBeUndefined();
  expect(lookup.get(f.costs[2])).toBe(f.costs[2]);
 });
 it('refuses a workbook identity with multiple inherited matches instead of updating the first row',async()=>{
  const ids=[randomUUID(),randomUUID()];
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`alter table department disable trigger user`);
   await tx.execute(sql`alter table label_company_assignment disable trigger user`);
   await tx.insert(s.department).values(ids.map(id=>({id,tenantId:b.tenantId,companyId:b.companyId,name:'Ambiguous same-origin legacy',isGlobal:true})));
   await tx.execute(sql.raw(capture));
   await tx.execute(sql`alter table department enable trigger user`);
   await tx.execute(sql`alter table label_company_assignment enable trigger user`);
  });
  const bytes=await buildSystemLabelWorkbook({kinds:['department'],references:{companies:[],grades:[],employees:[]},rows:{department:[{Company:b.companyId,Code:'Ambiguous same-origin legacy',Label:'Must not pick a first row',Criteria:'global','Criteria Companies':''}]}});
  const preview=await previewSystemLabelImport(adminCtx(b),bytes,'update');expect(preview.valid).toBe(false);expect(preview.rows[0].message).toMatch(/multiple records/);
  await expect(applySystemLabelImport(adminCtx(b),{bytes,mode:'update',token:preview.token,confirmUpdates:true})).rejects.toThrow(/invalid or conflicting/);
  expect((await owner.db.select().from(s.department).where(eq(s.department.name,'Ambiguous same-origin legacy'))).every(row=>row.label===null)).toBe(true);
 });
 it('raw app writes cannot expand finite overlap, and concurrent new IDs cannot inherit an exception',async()=>{
  await expect(withTenant(adminCtx(b),async tx=>{await tx.insert(s.labelCompanyAssignment).values({tenantId:b.tenantId,labelKind:'cost_center',labelId:f.costs[2],companyId:f.companies[0]});await forceChecks(tx);})).rejects.toThrow(/conflict/);
  const attempts=await Promise.allSettled([0,1].map(i=>withTenant(adminCtx(b),async tx=>{await tx.insert(s.costCenter).values({tenantId:b.tenantId,companyId:f.companies[i],code:'HQ',name:'Concurrent forbidden row',isGlobal:true});await forceChecks(tx);})));
  expect(attempts.map(result=>result.status)).toEqual(['rejected','rejected']);
  expect(await owner.db.select().from(s.costCenter).where(and(eq(s.costCenter.tenantId,b.tenantId),eq(s.costCenter.name,'Concurrent forbidden row')))).toEqual([]);
 });
});
