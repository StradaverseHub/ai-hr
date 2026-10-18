import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {bulkSaveLabels,createCompany} from '../core/admin';
import {existingSystemLabelImportKeysTx} from '../core/system-labels';
import {previewSystemLabelImport,applySystemLabelImport} from '../core/system-label-import';
import {buildSystemLabelWorkbook} from '../lib/system-label-workbook';
import {ORGANISATION_LABEL_KINDS} from '../lib/system-label-definition';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const book=(rows:Record<string,Record<string,string>[]>)=>buildSystemLabelWorkbook({kinds:Object.keys(rows),rows,references:{companies:[],grades:[],employees:[]}});
const org=(Company:string,Code:string)=>({Company,Code,Label:'Fictional label',Description:'Fictional description',Criteria:'companies','Criteria Companies':Company});
describe('new-only System Label import identity boundary',()=>{
 it.each(ORGANISATION_LABEL_KINDS)('blocks hidden/disjoint and archived %s identities without revealing the origin',async kind=>{
  const hidden=await createCompany(adminCtx(b),{legalName:'SECRET_HIDDEN_ORIGIN'}),code='PRIVATE_CODE';
  const created=await bulkSaveLabels(adminCtx(b),kind,{creates:[{key:'fixture',companyId:hidden.id,name:kind==='department'?code:'Fictional description',title:code,code,label:'SECRET_LABEL',isGlobal:false,companyIds:[hidden.id]}],updates:[]});
  const labelId=created.createdIds.find(row=>row.key==='fixture')?.id;expect(labelId).toBeDefined();
  const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:randomUUID()}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId});
  const ctx={...adminCtx(b),userId:user.id,grants:[{role:'hr_admin',companyId:b.companyId}]};
  const bytes=await book({[kind]:[org(b.companyId,' private_code '),org(b.companyId,'SAFE_'+kind)]});
  const preview=await previewSystemLabelImport(ctx,bytes,'merge');
  expect(preview.rows[0]).toMatchObject({reason:'existing',outcome:'error',before:null,selected:false});
  expect(JSON.stringify(preview)).not.toMatch(/SECRET_HIDDEN_ORIGIN|SECRET_LABEL/);
  expect(await applySystemLabelImport(ctx,{bytes,mode:'update',token:preview.token,confirmUpdates:true})).toMatchObject({imported:1,updated:0,skipped:1});
  const table={department:s.department,position:s.position,cost_center:s.costCenter,business_unit:s.businessUnit}[kind];
  await owner.db.update(table).set({archivedAt:new Date()}).where(eq(table.id,labelId!));
  const archived=await previewSystemLabelImport(ctx,await book({[kind]:[org(b.companyId,code)]}),'add');
  expect(archived.valid).toBe(false);expect(archived.rows[0]).toMatchObject({reason:'existing',before:null});
 });
 it('does not confuse a code in a foreign tenant with an incumbent and refuses cross-tenant existence requests',async()=>{
  const foreign=await seedBase();
  await bulkSaveLabels(adminCtx(foreign),'department',{creates:[{key:'foreign',companyId:foreign.companyId,name:'FOREIGN_ONLY'}],updates:[]});
  const bytes=await book({department:[org(b.companyId,'FOREIGN_ONLY')]});
  expect((await previewSystemLabelImport(adminCtx(b),bytes,'add')).rows[0].outcome).toBe('add');
  await expect(withTenant(adminCtx(b),tx=>existingSystemLabelImportKeysTx(tx,foreign.tenantId,[{key:'r',kind:'department',code:'FOREIGN_ONLY'}]))).rejects.toThrow(/administrator|permission/i);
  await expect(withTenant({...adminCtx(b),roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]},tx=>existingSystemLabelImportKeysTx(tx,b.tenantId,[{key:'r',kind:'department',code:'FOREIGN_ONLY'}]))).rejects.toThrow(/administrator|permission/i);
 });
 it('serializes two confirmations so at most one imports a category-wide new code',async()=>{
  const bytes=await book({division:[{Code:'RACE_ONLY',Label:'Fictional race'}]}),ctx=adminCtx(b);
  const preview=await previewSystemLabelImport(ctx,bytes,'add');
  const attempts=await Promise.allSettled([1,2].map(()=>applySystemLabelImport(ctx,{bytes,token:preview.token,mode:'merge',confirmUpdates:true})));
  expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(attempts.filter(result=>result.status==='rejected')).toHaveLength(1);
  expect(await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'RACE_ONLY'))).toHaveLength(1);
  const events=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'system-label-import.applied'));
  expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({mode:'add',summary:{imported:1,updated:0}});
 });
 it('the existence oracle rejects malformed and oversized requests rather than exposing tables',async()=>{
  for(const payload of [[{key:'r',kind:'unsupported',code:'X'}],[{key:'r',kind:'department',code:'X'},{key:'r',kind:'position',code:'X'}],Array.from({length:7001},(_,i)=>({key:String(i),kind:'department',code:'X'}))]){
   await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select key from app.existing_system_label_import_keys(${b.tenantId}::uuid,${JSON.stringify(payload)}::jsonb)`))).rejects.toThrow(/Invalid import/);
  }
 });
});
