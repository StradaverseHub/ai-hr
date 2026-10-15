import {afterAll,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {eq} from 'drizzle-orm';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as s from '../db/schema';
import {downloadSystemLabelsWithData,previewSystemLabelImport,applySystemLabelImport} from '../core/system-label-import';
import {createProfileOption,updateProfileOption,setProfileOptionActive} from '../core/profile-options';
import {buildSystemLabelWorkbook,readSystemLabelWorkbook,systemLabelExportId} from '../lib/system-label-workbook';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const exportBook=()=>downloadSystemLabelsWithData(adminCtx(b),{companyIds:[b.companyId],kinds:['division'],includeInactive:true});
const edit=(bytes:Buffer,patch:(ws:XLSX.WorkSheet)=>void)=>{const wb=XLSX.read(bytes,{type:'buffer'});patch(wb.Sheets.division);return XLSX.write(wb,{type:'buffer',bookType:'xlsx'}) as Buffer;};
const make=async()=>{await createProfileOption(adminCtx(b),{category:'division',value:'00123',label:'Original',description:'Keep this',sortOrder:7});return exportBook();};
describe('System Labels populated workbook round trip',()=>{
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
