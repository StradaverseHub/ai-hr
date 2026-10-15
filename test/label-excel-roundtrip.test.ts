import {afterAll,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {and,eq} from 'drizzle-orm';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as s from '../db/schema';
import {downloadSystemLabelsWithData,previewSystemLabelImport,applySystemLabelImport} from '../core/system-label-import';
import {createCompany} from '../core/admin';
import {LABEL_IMPORT_DEFINITIONS} from '../lib/system-label-definition';
import {createProfileOption,updateProfileOption,setProfileOptionActive} from '../core/profile-options';
import {buildSystemLabelWorkbook,readSystemLabelWorkbook,systemLabelExportId} from '../lib/system-label-workbook';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const exportBook=()=>downloadSystemLabelsWithData(adminCtx(b),{companyIds:[b.companyId],kinds:['division'],includeInactive:true});
const edit=(bytes:Buffer,patch:(ws:XLSX.WorkSheet)=>void)=>{const wb=XLSX.read(bytes,{type:'buffer'});patch(wb.Sheets.division);return XLSX.write(wb,{type:'buffer',bookType:'xlsx'}) as Buffer;};
const make=async()=>{await createProfileOption(adminCtx(b),{category:'division',value:'00123',label:'Original',description:'Keep this',sortOrder:7});return exportBook();};
describe('System Labels populated workbook round trip',()=>{
 it('round-trips all organization mappings without writes even when workbook column order differs from object insertion order',async()=>{
  const bytes=await downloadSystemLabelsWithData(adminCtx(b),{companyIds:[b.companyId],kinds:LABEL_IMPORT_DEFINITIONS.map(definition=>definition.kind),includeInactive:false});
  const parsed=readSystemLabelWorkbook(bytes);expect(parsed.filter(row=>row.sheet==='department')).toHaveLength(2);expect(parsed.some(row=>row.sheet==='position')).toBe(true);expect(parsed.some(row=>row.sheet==='cost_center')).toBe(true);
  const events=await owner.db.select().from(s.domainEvent),preview=await previewSystemLabelImport(adminCtx(b),bytes,'add');
  expect(preview.rows.filter(row=>row.outcome==='error')).toEqual([]);expect(preview.rows.every(row=>row.outcome==='skip'&&!row.selected)).toBe(true);
  await applySystemLabelImport(adminCtx(b),{bytes,mode:'add',token:preview.token,confirmUpdates:false,selectedKeys:[]});
  expect(await owner.db.select().from(s.domainEvent)).toHaveLength(events.length);
 });
 it('exports only the selected-company resolver visibility, permits unchanged read-only origins, and refuses changing those origins',async()=>{
  const co=await createCompany(adminCtx(b),{legalName:'Other label origin'});
  await owner.db.update(s.company).set({sharedSystemLabels:true}).where(eq(s.company.id,b.companyId));
  const rows=await owner.db.insert(s.department).values([
   {tenantId:b.tenantId,companyId:co.id,name:'GLOBAL_ORIGIN',label:'Global visible',isGlobal:true},
   {tenantId:b.tenantId,companyId:co.id,name:'SHARED_ORIGIN',label:'Shared visible'},
   {tenantId:b.tenantId,companyId:co.id,name:'HIDDEN_ORIGIN',label:'Not shared'},
  ]).returning();
  const shared=rows.find(row=>row.name==='SHARED_ORIGIN')!;
  await owner.db.insert(s.labelCompanyAssignment).values({tenantId:b.tenantId,labelKind:'department',labelId:shared.id,companyId:b.companyId});
  const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'scoped-export-user'}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId});
  const ctx={...adminCtx(b),userId:user.id,grants:[{role:'hr_admin' as const,companyId:b.companyId}]};
  const bytes=await downloadSystemLabelsWithData(ctx,{companyIds:[b.companyId],kinds:['department'],includeInactive:false});
  const codes=readSystemLabelWorkbook(bytes).map(row=>row.values.Code);
  expect(codes).toContain('GLOBAL_ORIGIN');expect(codes).toContain('SHARED_ORIGIN');expect(codes).not.toContain('HIDDEN_ORIGIN');
  const unchanged=await previewSystemLabelImport(ctx,bytes,'merge');expect(unchanged.valid).toBe(true);expect(unchanged.rows.every(row=>row.outcome==='skip')).toBe(true);
  const wb=XLSX.read(bytes,{type:'buffer'}),ws=wb.Sheets.department,index=unchanged.rows.find(row=>row.values.Code==='GLOBAL_ORIGIN')!.row;
  ws[XLSX.utils.encode_cell({r:index-1,c:4})].v='Attempted edit';
  const changed=XLSX.write(wb,{type:'buffer',bookType:'xlsx'}) as Buffer;
  expect((await previewSystemLabelImport(ctx,changed,'merge')).rows.find(row=>row.values.Code==='GLOBAL_ORIGIN')).toMatchObject({outcome:'error'});
  await expect(downloadSystemLabelsWithData(ctx,{companyIds:[co.id],kinds:['department'],includeInactive:false})).rejects.toThrow('accessible');
  expect((await owner.db.select().from(s.department).where(and(eq(s.department.companyId,co.id),eq(s.department.name,'GLOBAL_ORIGIN'))))[0].label).toBe('Global visible');
 });
 it('binds export history to the authenticated user and tenant and refuses an employee export',async()=>{
  const bytes=await make();
  const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'other-export-user'}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId});
  await expect(previewSystemLabelImport({...adminCtx(b),userId:user.id,grants:[{role:'hr_admin',companyId:b.companyId}]},bytes,'merge')).rejects.toThrow('unavailable to this user');
  const other=await seedBase();await expect(previewSystemLabelImport(adminCtx(other),bytes,'merge')).rejects.toThrow('unavailable to this user');
  await expect(downloadSystemLabelsWithData({...adminCtx(b),roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]},{companyIds:[b.companyId],kinds:['division'],includeInactive:false})).rejects.toThrow('administrator');
 });

 it('keeps exact text, frozen headers, styled cells, dropdowns and opaque hidden export metadata',async()=>{
  const bytes=await make(),wb=XLSX.read(bytes,{type:'buffer',cellStyles:true});
  expect(wb.Sheets.division.A2.v).toBe('00123');expect(wb.Sheets.division.A2.t).toBe('s');expect(wb.Sheets.division.A2.z).toBe('@');
  expect(systemLabelExportId(bytes)).toMatch(/^[0-9a-f-]{36}$/);
  expect(wb.Workbook?.Sheets?.find(s=>s.name==='_Export')?.Hidden).toBe(2);
  const zip=await JSZip.loadAsync(bytes),xml=await zip.file('xl/worksheets/sheet2.xml')!.async('string');
  expect(xml).toContain('state="frozen"');expect(xml).toContain('autoFilter');
  const companyBook=await buildSystemLabelWorkbook({kinds:['department'],references:{companies:[['Company','id']],grades:[],employees:[]}});
  const archive=await JSZip.loadAsync(companyBook),sheet=await archive.file('xl/worksheets/sheet2.xml')!.async('string');
  expect(sheet).toContain('dataValidation');expect(sheet).toContain('sqref="A2:A1001"');
  expect(readSystemLabelWorkbook(bytes)[0].values).toMatchObject({Code:'00123',Label:'Original',Description:'Keep this','Sort Order':'7'});
 });
 it('an unchanged re-upload writes no records or import events, including inactive rows',async()=>{
  const bytes=await make();
  const [record]=await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'00123'));
  await setProfileOptionActive(adminCtx(b),{id:record.id,isActive:false});
  const archived=await exportBook(),before=await owner.db.select().from(s.domainEvent);
  const preview=await previewSystemLabelImport(adminCtx(b),archived,'add');
  expect(preview).toMatchObject({valid:true,mode:'merge'});expect(preview.rows.every(r=>r.outcome==='skip'&&!r.selected)).toBe(true);
  expect(await applySystemLabelImport(adminCtx(b),{bytes:archived,mode:'add',token:preview.token,confirmUpdates:false,selectedKeys:[]})).toMatchObject({imported:0,updated:0,skipped:preview.rows.length});
  expect(await owner.db.select().from(s.domainEvent)).toHaveLength(before.length);
  expect(bytes.length).toBeGreaterThan(0);
 });
 it('blank cells preserve prior values and optional [CLEAR] explicitly clears them',async()=>{
  const bytes=await make(),changed=edit(bytes,ws=>{ws.B2.v='Edited';ws.C2.v='';ws.D2.v='';});
  const preview=await previewSystemLabelImport(adminCtx(b),changed,'add');
  expect(preview.rows[0]).toMatchObject({outcome:'update',after:{Label:'Edited',Description:'Keep this','Sort Order':'7'}});
  await applySystemLabelImport(adminCtx(b),{bytes:changed,mode:'merge',token:preview.token,confirmUpdates:true});
  const cleared=edit(await exportBook(),ws=>{ws.C2.v='[CLEAR]';});
  const next=await previewSystemLabelImport(adminCtx(b),cleared,'merge');
  await applySystemLabelImport(adminCtx(b),{bytes:cleared,mode:'merge',token:next.token,confirmUpdates:true});
  const [row]=await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'00123'));
  expect(row).toMatchObject({label:'Edited',description:null,sortOrder:7});
  const invalid=edit(await exportBook(),ws=>{ws.B2.v='[CLEAR]';});expect((await previewSystemLabelImport(adminCtx(b),invalid,'merge')).valid).toBe(false);
 });
 it('warns from authoritative export history, permits exclusion and refuses edits after preview',async()=>{
  const bytes=await make(),[record]=await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'00123'));
  await updateProfileOption(adminCtx(b),{id:record.id,label:'Concurrent',description:'Keep this',sortOrder:7});
  const changed=edit(bytes,ws=>{ws.B2.v='Workbook';});
  const preview=await previewSystemLabelImport(adminCtx(b),changed,'merge');
  expect(preview.rows[0]).toMatchObject({stale:true,outcome:'update'});expect(preview.rows[0].message).toContain('after export');
  const excluded=await previewSystemLabelImport(adminCtx(b),changed,'merge',[]);
  expect(await applySystemLabelImport(adminCtx(b),{bytes:changed,mode:'merge',token:excluded.token,confirmUpdates:false,selectedKeys:[]})).toMatchObject({updated:0});
  await updateProfileOption(adminCtx(b),{id:record.id,label:'Changed after preview',sortOrder:7});
  await expect(applySystemLabelImport(adminCtx(b),{bytes:changed,mode:'merge',token:preview.token,confirmUpdates:true})).rejects.toThrow(/changed since preview/);
 });
 it('accepts literal formula-looking text without changing it and refuses oversized lists',async()=>{
  const literal=await buildSystemLabelWorkbook({kinds:['division'],references:{companies:[],grades:[],employees:[]},rows:{division:[{Code:'=literal',Label:'+literal',Description:'@literal','Sort Order':'0'}]}});
  expect(readSystemLabelWorkbook(literal)[0].values).toMatchObject({Code:'=literal',Label:'+literal',Description:'@literal'});
  await expect(buildSystemLabelWorkbook({kinds:['division'],references:{companies:[],grades:[],employees:[]},rows:{division:Array.from({length:501},(_,i)=>({Code:String(i),Label:'X'}))}})).rejects.toThrow(/Narrow/);
 });
});
