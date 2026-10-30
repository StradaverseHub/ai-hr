import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {buildMovementWorkbook,movementWorkbookCatalogue,readMovementSource,readMovementWorkbookRows} from '../lib/movement-workbook.server';
import {signMovementTemplate} from '../lib/movement-workbook-metadata.server';
import {movementRowsToRecords,movementSystemFields} from '../lib/movement-import-rows';
import {movementWorkbookLayout} from '../lib/movement-workbook-layout';
import {parseMovementTypeCsv,movementTypeCsvTemplate,movementInputRecord} from '../lib/movement-type-csv';
import {toCsv} from '../lib/csv';
import type {MovementImportCatalog} from '../core/movement-import';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',department='33333333-3333-4333-8333-333333333333',grade='44444444-4444-4444-8444-444444444444';
const types=[{code:'increment',label:'Increment',behaviour:'increment'},{code:'custom_increment',label:'Increment',behaviour:'increment'},{code:'promotion',label:'Promotion',behaviour:'promotion'},{code:'transfer',label:'Transfer',behaviour:'transfer'},{code:'blacklist',label:'Blacklist',behaviour:'blacklist'}];
const catalog:MovementImportCatalog={types,companies:[{value:a,label:'Fictional A'}],fields:{departmentId:[{value:department,codes:['FIN'],label:'Finance'}],gradeId:[{value:grade,codes:['G8'],label:'G8 · Grade 8'}]}};
const resolve=(_key:string,fallback:string)=>fallback;
const HEADER=['Company ID','Employee ID','Employee Name','Effective Date','Event Type','System Fields','Before','After'];
// 646355e5 slice C — version 4 appends three columns; version 3 (HEADER) still reads as Create only.
const HEADER4=[...HEADER,'Action','Movement Event ID','Reason'];
const make=()=>buildMovementWorkbook({tenantId:a,types,companies:[{companyId:a,code:'EXT',name:'Fictional A',catalog}],resolve});
const rows=(bytes:Buffer,tenantId=a,list=types)=>readMovementWorkbookRows(bytes,{tenantId,types:list});
async function edit(bytes:Buffer,patch:(wb:XLSX.WorkBook)=>void){const wb=XLSX.read(bytes,{type:'buffer',cellFormula:true});patch(wb);return Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}));}
const fill=(values:string[][])=>(wb:XLSX.WorkBook)=>values.forEach((row,r)=>row.forEach((v,c)=>{wb.Sheets.Movements[XLSX.utils.encode_cell({r:r+1,c})]={t:'s',v};}));
beforeEach(()=>{vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY',Buffer.alloc(32,7).toString('base64url'));vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','public-fixture-only');});afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
describe('single-sheet Movement template (ac6645ec)',()=>{
 it('has Instructions, one Movements sheet with the eleven columns in order, Reference, hidden lists, drop-downs and no internal id',async()=>{
  const bytes=await make(),wb=XLSX.read(bytes,{type:'buffer'}),zip=await JSZip.loadAsync(bytes);
  expect(wb.SheetNames).toEqual(['Instructions','Movements','Reference','Lists','_meta']);
  expect(wb.Workbook?.Sheets?.filter(s=>['Lists','_meta'].includes(s.name!)).every(s=>s.Hidden===1)).toBe(true);expect(wb.Workbook?.Sheets?.find(s=>s.name==='Reference')?.Hidden??0).toBe(0);
  expect(HEADER4.map((_,c)=>wb.Sheets.Movements[XLSX.utils.encode_cell({r:0,c})].v)).toEqual(HEADER4);
  expect(JSON.parse(String(wb.Sheets._meta.A1.v)).version).toBe(4);
  for(const entry of Object.values(zip.files).filter(f=>!f.dir&&f.name.endsWith('.xml'))){const text=await entry.async('string');for(const id of [a,department,grade])expect(text).not.toContain(id);}
  const sheet=await zip.file('xl/worksheets/sheet2.xml')!.async('string');
  expect(sheet).toContain('state="frozen"');expect([...sheet.matchAll(/<dataValidation\b[^>]*sqref="([A-Z]+)2:/g)].map(m=>m[1])).toEqual(['A','E','F','I']);
  const reference=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Reference,{header:1}).map(r=>r.join('|'));
  expect(reference).toContain('EXT|Fictional A');expect(reference).toContain('EXT|'+movementSystemFields(types[3],resolve).find(f=>f.key==='departmentId')!.label+'|FIN|Finance');
  // Duplicate labels fall back to the code in the drop-down and on Reference.
  const lists=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Lists,{header:1}).slice(1).map(r=>r[1]).filter(Boolean);expect(lists).toEqual(['increment','custom_increment','Promotion','Transfer','Blacklist']);
 });
 it('groups rows with the same company, employee, date and event type into one movement and maps System Fields to inputs',async()=>{
  const fields=movementSystemFields(types[2],resolve),label=(key:string)=>fields.find(f=>f.key===key)!.label;
  const bytes=await edit(await make(),fill([
   ['EXT','E1042','Alex Example','01-Jan-2027','Promotion',label('gradeId'),'G7','G8'],
   ['ext','E1042','','2027-01-01','promotion',label('positionId'),'Executive','Senior Executive'],
   ['EXT','E1042','','01-Jan-2027','Promotion','incrementAmount','','100'],
   ['EXT','E2210','Sam Sample','01-Dec-2026','Transfer',label('departmentId'),'Quality','FIN'],
  ]));
  const parsed=movementRowsToRecords(await rows(bytes),types,[resolve]);expect(parsed.fileErrors).toEqual([]);
  expect(parsed.records).toHaveLength(2);
  expect(parsed.records[0]).toMatchObject({row:2,employeeCode:'E1042',companyCode:'EXT',sourceRows:[2,3,4],cells:{kind:'promotion',gradeId:'G8',positionId:'Senior Executive'},incrementAmount:'100',before:{gradeId:'G7',positionId:'Executive'},errors:[]});
  expect(parsed.records[1]).toMatchObject({row:5,cells:{kind:'transfer',departmentId:'FIN',effectiveDate:'01-Dec-2026'},before:{departmentId:'Quality'}});
 });
 it('reads an Excel numeric Effective Date as a calendar day',async()=>{
  const bytes=await edit(await make(),wb=>{fill([['EXT','E1','','','Transfer','departmentId','','FIN']])(wb);wb.Sheets.Movements.D2={t:'n',v:(Date.UTC(2026,10,1)-Date.UTC(1899,11,30))/86400000};});
  expect((await rows(bytes))[0].values[3]).toBe('2026-11-01');
 });
 it('reports unknown, duplicate and missing System Fields, internal ids and unknown event types on the movement',()=>{
  const sheet=(values:string[][])=>values.map((v,i)=>({row:i+2,values:v}));
  const parsed=movementRowsToRecords(sheet([
   ['EXT','E1','','2026-11-01','Transfer','Job Grade?','','X'],
   ['EXT','E2','','2026-11-01','Transfer','departmentId','','FIN'],['EXT','E2','','2026-11-01','Transfer','departmentId','','OPS'],
   ['EXT','E3','','2026-11-01','Transfer','','Finance',''],
   ['EXT','E4','','2026-11-01','Transfer','departmentId','',department],
   ['EXT','E5','','2026-11-01','Increment','incrementAmount','','5'],
   ['','E6','','2026-11-01','Nonexistent','','',''],
  ]),types,[resolve]);
  const errors=Object.fromEntries(parsed.records.map(r=>[r.employeeCode,r.errors]));
  expect(errors.E1).toEqual(['unknown_system_field:Job Grade?']);expect(errors.E2).toEqual(['duplicate_system_field:departmentId']);expect(errors.E3).toEqual(['system_field_required']);
  expect(errors.E4).toEqual(['internal_reference_not_allowed']);expect(errors.E5).toEqual([]);expect(parsed.records.find(r=>r.employeeCode==='E5')!.cells.kind).toBe('increment');expect(errors.E6).toEqual(['company_required','unknown_or_inactive_event_type']);
 });
 it('refuses an event type whose label is shared by two types and is no code',()=>{
  const shared=[{code:'raise_a',label:'Pay Rise',behaviour:'increment'},{code:'raise_b',label:'Pay Rise',behaviour:'increment'}];
  expect(movementRowsToRecords([{row:2,values:['EXT','E1','','2026-11-01','Pay Rise','incrementAmount','','5']}],shared,[resolve]).records[0].errors).toEqual(['ambiguous_reference:event_type']);
 });
 it('accepts a Blacklist movement with Remarks and keeps the canonical blacklist intent rule',()=>{
  const parsed=movementRowsToRecords([{row:2,values:['EXT','E1','','','Blacklist','','','']},{row:3,values:['EXT','E2','','','Blacklist','remarks','','Deliberate fictional instruction']}],types,[resolve]);
  expect(parsed.records.map(r=>r.errors)).toEqual([[],[]]);expect(parsed.records[1].cells.remarks).toBe('Deliberate fictional instruction');
 });
 it('refuses a retired per-type workbook, a changed catalogue, tampered or foreign metadata, key rotation, formulas and swapped captions',async()=>{
  const bytes=await make();
  const old=await edit(bytes,wb=>{delete wb.Sheets.Movements;wb.SheetNames=wb.SheetNames.filter(n=>n!=='Movements');wb.Sheets._meta.A1={t:'s',v:JSON.stringify({version:2,sheets:[]})};});
  await expect(rows(old)).rejects.toThrow('workbook_old_layout');
  await expect(rows(await edit(bytes,wb=>{wb.Sheets._meta.A1={t:'s',v:JSON.stringify({version:2,sheets:[]})};}))).rejects.toThrow('workbook_old_layout');
  await expect(rows(bytes,a,types.slice(1))).rejects.toThrow('workbook_catalogue_changed');
  await expect(rows(bytes,b)).rejects.toThrow('workbook_metadata_invalid');
  await expect(rows(await edit(bytes,wb=>{wb.Sheets._meta.A1.v=String(wb.Sheets._meta.A1.v).replace('Company ID','Firm ID');}))).rejects.toThrow('workbook_metadata_invalid');
  await expect(rows(await edit(bytes,wb=>{wb.Sheets.Movements.H2={t:'n',v:2,f:'1+1'};}))).rejects.toThrow('formula_input');
  await expect(rows(await edit(bytes,wb=>{const s=wb.Sheets.Movements,x=s.G1;s.G1=s.H1;s.H1=x;}))).rejects.toThrow('workbook_columns_changed');
  vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','rotated-fixture');await expect(rows(bytes)).rejects.toThrow('workbook_metadata_invalid');
 });
 it('refuses nonliteral named-list references',async()=>{
  const zip=await JSZip.loadAsync(await make()),entry=zip.file('xl/workbook.xml')!;
  zip.file('xl/workbook.xml',(await entry.async('string')).replace(/(<definedName\b[^>]*>)([\s\S]*?)(<\/definedName>)/,(_all,open,_old,close)=>open+'SUM(Lists!$A$2:$A$4)'+close));
  await expect(rows(await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))).rejects.toThrow('workbook_structure_invalid');
 });
 it('reads the same columns from CSV and refuses the old per-type CSV as an old layout',async()=>{
  const ok=await readMovementSource('m.csv',Buffer.from(toCsv([HEADER,['EXT','E1','','2026-11-01','Transfer','departmentId','','FIN']])),{tenantId:a,types,resolve});
  expect(ok.fileErrors).toEqual([]);expect(ok.records[0]).toMatchObject({companyCode:'EXT',cells:{kind:'transfer',departmentId:'FIN'}});
  for(const header of [['Employee ID','Increment Amount','Effective Date'],['employee_code','event_type','effective_date']]){
   const old=await readMovementSource('old.csv',Buffer.from(toCsv([header,['E1','100','2026-11-01']])),{tenantId:a,types,resolve});expect(old.fileErrors).toEqual(['workbook_old_layout']);
  }
  expect((await readMovementSource('m.txt',Buffer.from('x'),{tenantId:a,types,resolve})).fileErrors).toEqual(['invalid_file']);
 });
});
const ID='7d1c2e4a-5b6f-4a8b-9c0d-1e2f3a4b5c6d',ID2='8e2d3f5b-6c7a-4b9c-8d1e-2f3a4b5c6d7e';
const v4=(values:string[][])=>values.map((v,i)=>({row:i+2,values:v}));
describe('Update and Delete rows (646355e5 slice C)',()=>{
 it('groups an Update by its Movement Event ID, keeps blank date and type, and accepts the id only in its own column',()=>{
  const parsed=movementRowsToRecords(v4([
   ['EXT','E1','','','','gradeId','G7','G8','Update',ID,'Wrong grade keyed'],
   ['EXT','E1','','','Promotion','positionId','','Senior Executive','update',ID.toUpperCase(),''],
   ['EXT','E1','','01-Dec-2026','Transfer','','','','Delete',ID2,'Keyed twice'],
   ['EXT','E2','','2026-12-01','Transfer','departmentId','','FIN','','',''],
  ]),types,[resolve]);
  expect(parsed.fileErrors).toEqual([]);expect(parsed.records).toHaveLength(3);
  const [update,del,create]=parsed.records;
  expect(update).toMatchObject({action:'update',movementId:ID,reason:'Wrong grade keyed',sourceRows:[2,3],cells:{kind:'promotion',gradeId:'G8',positionId:'Senior Executive'},before:{gradeId:'G7'},errors:[]});
  expect(update.cells.effectiveDate).toBeUndefined();
  expect(del).toMatchObject({action:'delete',movementId:ID2,reason:'Keyed twice',cells:{kind:'transfer',effectiveDate:'01-Dec-2026'},errors:[]});
  expect(create.action).toBeUndefined();expect(create.errors).toEqual([]);
 });
 it('reports the row-level errors of Update and Delete',()=>{
  const parsed=movementRowsToRecords(v4([
   ['EXT','E1','','','','gradeId','','G8','Update','','No id'],
   ['EXT','E2','','','','','','','Delete','not-an-id','Bad id'],
   ['EXT','E3','','','','departmentId','','FIN','Delete',ID,'Delete with fields'],
   ['EXT','E4','','','','gradeId','','G8','Update',ID2,''],
   ['EXT','E5','','2026-11-01','Transfer','departmentId','','FIN','',ID,'x'],
   ['EXT','E6','','','','','','','Rename','',''],
   ['EXT','E7','','','Promotion','incrementAmount','','100','Update','9e3e4f6c-7d8b-4c0d-9e2f-3a4b5c6d7e8f','More money'],
   ['EXT','E8','','2026-11-01','','','','','Delete','1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d','x'],['EXT','E8','','2026-11-02','','','','','Delete','1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d','y'],
   ['EXT','E9','','2026-11-01','Transfer','departmentId','',ID,'','',''],
  ]),types,[resolve]);
  const errors=Object.fromEntries(parsed.records.map(r=>[r.employeeCode,r.errors]));
  expect(errors.E1).toEqual(['movement_id_required']);expect(errors.E2).toEqual(['movement_id_unknown']);
  expect(errors.E3).toEqual(['not_applicable_on_delete']);expect(errors.E4).toEqual(['reason_required']);
  expect(errors.E5).toEqual(['movement_id_not_for_create','reason_not_for_create']);expect(errors.E6).toEqual(['unknown_action']);
  expect(errors.E7).toEqual(['increment_amount_not_for_update']);
  expect(errors.E8).toEqual(expect.arrayContaining(['conflicting_values:effectiveDate','conflicting_values:reason']));
  expect(errors.E9).toEqual(['internal_reference_not_allowed']);
 });
 it('refuses the same Movement Event ID named by two rows of different actions',()=>{
  const parsed=movementRowsToRecords(v4([['EXT','E1','','','','gradeId','','G8','Update',ID,'a'],['EXT','E1','','','','','','','Delete',ID,'b']]),types,[resolve]);
  expect(parsed.records.map(r=>r.errors)).toEqual([['duplicate_movement_id'],['duplicate_movement_id']]);
 });
 it('reads a version 4 workbook and an eleven-column CSV',async()=>{
  const bytes=await edit(await make(),fill([['EXT','E1','','','','gradeId','','G8','Update',ID,'Wrong grade keyed']]));
  const read=await readMovementSource('m.xlsx',bytes,{tenantId:a,types,resolve});
  expect(read.fileErrors).toEqual([]);expect(read.records[0]).toMatchObject({action:'update',movementId:ID,reason:'Wrong grade keyed'});
  const csv=await readMovementSource('m.csv',Buffer.from(toCsv([HEADER4,['EXT','E1','','','','','','','Delete',ID,'Keyed twice']])),{tenantId:a,types,resolve});
  expect(csv.fileErrors).toEqual([]);expect(csv.records[0]).toMatchObject({action:'delete',movementId:ID});
 });
 it('still accepts a version 3 workbook as Create only, and refuses a value beyond its eight columns',async()=>{
  const v3=await edit(await make(),wb=>{
   const sheet=wb.Sheets.Movements;for(const c of ['I','J','K'])for(let r=1;r<=201;r++)delete sheet[c+r];sheet['!ref']='A1:H201';
   const meta=signMovementTemplate({tenantId:a,downloadedAt:new Date().toISOString(),catalogue:movementWorkbookCatalogue({types}),captions:HEADER,version:3});
   wb.Sheets._meta=XLSX.utils.aoa_to_sheet([[JSON.stringify(meta)]]);
   fill([['EXT','E1','','01-Dec-2026','Transfer','departmentId','','FIN']])(wb);
  });
  const read=await readMovementSource('old.xlsx',v3,{tenantId:a,types,resolve});
  expect(read.fileErrors).toEqual([]);expect(read.records[0]).toMatchObject({cells:{kind:'transfer',departmentId:'FIN'},errors:[]});expect(read.records[0].action).toBeUndefined();
  const wider=await edit(v3,wb=>{wb.Sheets.Movements.I2={t:'s',v:'Update'};wb.Sheets.Movements['!ref']='A1:I201';});
  expect((await readMovementSource('old.xlsx',wider,{tenantId:a,types,resolve})).fileErrors).toEqual(['workbook_columns_changed']);
 });
});
// The single-type CSV owner remains for the per-type CSV contract used by other import paths.
describe('single-type Movement CSV owner',()=>{
 it('keeps CSV single-type with no Event Type input',()=>{
  const csv=movementTypeCsvTemplate(types[0],resolve);expect(csv).not.toMatch(/EventType|event_type/);expect(parseMovementTypeCsv('Employee ID,EventType\nEX-001,increment',types[0],resolve).fileErrors).toEqual(['wrong_type_columns']);
 });
 it('normalizes every resolved blacklist behaviour to the fresh KL day',()=>{
  const before=new Date();before.setUTCHours(15,59,59,0);vi.useFakeTimers();vi.setSystemTime(before);
  const type={code:'custom_blacklist_fixture',label:'Fictional custom blacklist',behaviour:'blacklist'},columns=movementWorkbookLayout(type,resolve),values=columns.map(c=>c.key==='employeeCode'?'EX-001':c.key==='blacklisted'?'true':'');
  const first=movementInputRecord(type,columns,values,1,{sheet:'Fictional custom blacklist',row:6});expect(first.cells.effectiveDate).toBeDefined();
  vi.setSystemTime(new Date(before.getTime()+2000));expect(movementInputRecord(type,columns,values,1,{sheet:'Fictional custom blacklist',row:6}).cells.effectiveDate).not.toBe(first.cells.effectiveDate);
 });
});
