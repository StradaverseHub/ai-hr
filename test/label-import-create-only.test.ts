import {randomUUID} from 'node:crypto';
import * as XLSX from 'xlsx';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {bulkSaveLabels,createCompany,createJobGrade} from '../core/admin';
import {existingSystemLabelImportKeysTx} from '../core/system-labels';
import {previewSystemLabelImport,applySystemLabelImport} from '../core/system-label-import';
import {buildSystemLabelWorkbook} from '../lib/system-label-workbook';
import {createGradeGroup} from '../packs/leave/service';
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
 it.each(['xlsx','biff8'] as const)('applies real %s new data through the canonical owner',async type=>{
  const original=await book({division:[{Code:'FORMAT_NEW',Label:'Fictional new'}]}),bytes=XLSX.write(XLSX.read(original,{type:'buffer'}),{type:'buffer',bookType:type}) as Buffer;
  const preview=await previewSystemLabelImport(adminCtx(b),bytes,'update');expect(preview.valid).toBe(true);
  expect(await applySystemLabelImport(adminCtx(b),{bytes,mode:'merge',token:preview.token,confirmUpdates:true})).toMatchObject({imported:1,updated:0});
  expect(await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'FORMAT_NEW'))).toHaveLength(1);
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
 it('returns typed localized-reason inputs for ordinary invalid rows without changing validation',async()=>{
  const grade=await createJobGrade(adminCtx(b),{code:'TAKEN_GRADE',name:'Already used label'});await createGradeGroup(adminCtx(b),{name:'Existing group',gradeIds:[grade.id]});
  const source=await book({
   department:[{...org(b.companyId,''),Label:'Missing code'},{...org('','MISSING_COMPANY')},org('UNKNOWN_COMPANY','BAD_COMPANY'),{...org(b.companyId,'BAD_CRITERIA'),Criteria:'unsupported'},{...org(b.companyId,'BAD_CRITERIA_COMPANY'),'Criteria Companies':'UNKNOWN_COMPANY'},{...org(b.companyId,'EMPTY_CRITERIA'),'Criteria Companies':''},{...org(b.companyId,'BAD_HEAD'),'Head Employee Code':'UNKNOWN_EMPLOYEE'}],
   cost_center:[{...org(b.companyId,'MISSING_DESCRIPTION'),Description:''}],
   division:[{Code:'BAD_SORT',Label:'Bad sort','Sort Order':'1.5'},{Code:'STILL_VALID',Label:'Valid'}],
   grades:[{Code:'lowercase',Label:'Invalid code'},{Code:'MISSING_LABEL',Label:''},{Code:'DUPLICATE_LABEL',Label:'Already used label'}],
   grade_groups:[{Name:'Unknown grade group','Grade Codes':'UNKNOWN_GRADE'},{Name:'Already assigned group','Grade Codes':'TAKEN_GRADE'}],
  });
  const wb=XLSX.read(source,{type:'buffer'});XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Code'],['UNSUPPORTED']]),'unsupported');const bytes=XLSX.write(wb,{type:'buffer',bookType:'xlsx'}) as Buffer;
  const preview=await previewSystemLabelImport(adminCtx(b),bytes);
  const reasons={MISSING_COMPANY:'required',BAD_COMPANY:'invalidCompany',BAD_CRITERIA:'invalidCriteria',BAD_CRITERIA_COMPANY:'invalidCriteriaCompany',EMPTY_CRITERIA:'criteriaCompaniesRequired',BAD_HEAD:'invalidHeadEmployee',MISSING_DESCRIPTION:'required',BAD_SORT:'wholeNumber',lowercase:'invalidGradeCode',MISSING_LABEL:'required',DUPLICATE_LABEL:'gradeLabelExists','Unknown grade group':'invalidGradeReferences','Already assigned group':'gradeAlreadyGrouped',UNSUPPORTED:'unsupportedCategory'};
  for(const [code,reason]of Object.entries(reasons))expect(preview.rows.find(row=>(row.after.Code??row.after.Name)===code)).toMatchObject({reason,outcome:'error',selected:false});
  expect(preview.rows.find(row=>row.after.Label==='Missing code')).toMatchObject({reason:'required',reasonField:'Code'});
  for(const [code,field]of [['MISSING_COMPANY','Company'],['MISSING_DESCRIPTION','Description'],['MISSING_LABEL','Label']])expect(preview.rows.find(row=>row.after.Code===code)).toMatchObject({reasonField:field});
  expect(preview.valid).toBe(true);expect(preview.rows.find(row=>row.after.Code==='STILL_VALID')).toMatchObject({outcome:'add',selected:true});
 });
 it('reports an intentionally unselected valid row as skipped while importing only the selected valid subset',async()=>{
  const bytes=await book({division:[{Code:'SELECTED_NEW',Label:'Selected'},{Code:'UNSELECTED_NEW',Label:'Unselected'}]}),ctx=adminCtx(b),selectedKeys=['division:2'];
  const preview=await previewSystemLabelImport(ctx,bytes,'add',selectedKeys);
  expect(preview.valid).toBe(true);expect(preview.rows.find(row=>row.after.Code==='SELECTED_NEW')).toMatchObject({outcome:'add',selected:true});
  expect(preview.rows.find(row=>row.after.Code==='UNSELECTED_NEW')).toMatchObject({outcome:'skip',reason:'notSelected',selected:false});
  const summary=await applySystemLabelImport(ctx,{bytes,token:preview.token,selectedKeys});expect(summary).toMatchObject({imported:1,updated:0,skipped:1,failed:0});expect(summary.errorReport).toBeTruthy();
  const report=XLSX.read(Buffer.from(summary.errorReport!,'base64'),{type:'buffer'}),rows=XLSX.utils.sheet_to_json<string[]>(report.Sheets.Errors,{header:1,raw:false});
  expect(rows).toEqual([['Worksheet','Row','Code','Result','Message'],['division','3','UNSELECTED_NEW','skip','Valid new code was not selected for this import. No record was created.']]);
  expect(await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'SELECTED_NEW'))).toHaveLength(1);expect(await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'UNSELECTED_NEW'))).toHaveLength(0);
  const events=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'system-label-import.applied'));expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({summary:{imported:1,updated:0,skipped:1,failed:0},rows:[{after:{Code:'SELECTED_NEW'}}]});
 });
 it('the existence oracle rejects malformed and oversized requests rather than exposing tables',async()=>{
  for(const payload of [[{key:'r',kind:'unsupported',code:'X'}],[{key:'r',kind:'department',code:'X'},{key:'r',kind:'position',code:'X'}],Array.from({length:7001},(_,i)=>({key:String(i),kind:'department',code:'X'}))]){
   await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select key from app.existing_system_label_import_keys(${b.tenantId}::uuid,${JSON.stringify(payload)}::jsonb)`))).rejects.toThrow(/Invalid import/);
  }
 });
});
