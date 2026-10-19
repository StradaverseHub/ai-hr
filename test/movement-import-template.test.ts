import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {buildMovementWorkbook,readMovementWorkbook} from '../lib/movement-workbook.server';
import {movementWorkbookLayout} from '../lib/movement-workbook-layout';
import {parseMovementTypeCsv,movementTypeCsvTemplate} from '../lib/movement-type-csv';
import type {MovementImportCatalog} from '../core/movement-import';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',department='33333333-3333-4333-8333-333333333333';
const catalog:MovementImportCatalog={types:[{code:'increment',label:'Increment',behaviour:'increment'},{code:'custom_increment',label:'Increment',behaviour:'increment'},{code:'resignation',label:'Resignation',behaviour:'resignation'}],companies:[{value:a,label:'Fictional A'}],fields:{departmentId:[{value:department,label:'Finance'}]}};
const resolve=(_key:string,fallback:string)=>fallback;
const subjects=Array.from({length:5},(_,i)=>({employeeCode:'EX-00'+i,name:'Fictional '+i,current:{departmentId:'Finance',gradeId:'G2',basicSalary:'3000.00',currency:'MYR'}}));
const make=()=>buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog,subjects,typeCode:'increment',resolve});
const parse=(bytes:Buffer)=>readMovementWorkbook(bytes,{tenantId:a,companyId:a,catalog,resolve});
async function edit(bytes:Buffer,patch:(wb:XLSX.WorkBook)=>void){const wb=XLSX.read(bytes,{type:'buffer',cellFormula:true});patch(wb);return Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}));}
beforeEach(()=>{vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY',Buffer.alloc(32,7).toString('base64url'));vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','public-fixture-only');});afterEach(()=>vi.unstubAllEnvs());
describe('authenticated per-type Movement workbook',()=>{
 it('uses one live layout for inherited types and keeps CSV single-type with no Event Type input',()=>{
  expect(movementWorkbookLayout(catalog.types[0],resolve).map(c=>c.key)).toEqual(movementWorkbookLayout(catalog.types[1],resolve).map(c=>c.key));
  const csv=movementTypeCsvTemplate(catalog.types[0],resolve);expect(csv).not.toMatch(/EventType|event_type/);expect(parseMovementTypeCsv('Employee ID,EventType\nEX-001,increment',catalog.types[0],resolve).fileErrors).toEqual(['wrong_type_columns']);
  expect(parseMovementTypeCsv('Employee ID,Increment Amount,EffectiveDate\nEX-001,"unclosed',catalog.types[0],resolve).fileErrors).toContain('malformed_csv');
 });
 it('opens protected grey/yellow/green scaffolding, hides references, keeps no raw UUID and skips two untouched employees',async()=>{
  const bytes=await make(),wb=XLSX.read(bytes,{type:'buffer',cellFormula:true}),zip=await JSZip.loadAsync(bytes);
  expect(wb.SheetNames).toEqual(['Instructions','Increment','Lists','_meta']);expect(wb.Workbook?.Sheets?.filter(s=>['Lists','_meta'].includes(s.name!)).every(s=>s.Hidden===1)).toBe(true);
  const xml=await zip.file('xl/worksheets/sheet2.xml')!.async('string');expect(xml).toContain('sheetProtection');expect(xml).toContain('state="frozen"');expect(xml).toContain('<f>');
  for(const entry of Object.values(zip.files).filter(f=>!f.dir&&f.name.endsWith('.xml')))expect(await entry.async('string')).not.toContain(a);
  const columns=movementWorkbookLayout(catalog.types[0],resolve),amount=columns.findIndex(c=>c.key==='incrementAmount'),date=columns.findIndex(c=>c.key==='effectiveDate');
  const edited=await edit(bytes,book=>{for(let r=5;r<8;r++){book.Sheets.Increment[XLSX.utils.encode_cell({r,c:amount})]={t:'n',v:100};book.Sheets.Increment[XLSX.utils.encode_cell({r,c:date})]={t:'s',v:'01-Nov-2026'};}});
  const parsed=await parse(edited);expect(parsed.fileErrors).toEqual([]);expect(parsed.records).toHaveLength(3);expect(parsed.records.every(r=>r.incrementAmount==='100'&&r.cells.kind==='increment')).toBe(true);expect(parsed.records.map(r=>r.source?.row)).toEqual([6,7,8]);
 });
 it('binds physical headings across uploader locale and refuses swapping yellow captions or prefilled identity',async()=>{
  const bytes=await make();await expect(readMovementWorkbook(bytes,{tenantId:a,companyId:a,catalog,resolve:(_k,f)=>'Localized '+f})).resolves.toMatchObject({fileErrors:['no_data_rows']});
  const columns=movementWorkbookLayout(catalog.types[0],resolve),x=columns.findIndex(c=>c.key==='incrementAmount'),y=columns.findIndex(c=>c.key==='effectiveDate');
  await expect(parse(await edit(bytes,wb=>{const s=wb.Sheets.Increment,c=XLSX.utils.encode_cell({r:4,c:x}),d=XLSX.utils.encode_cell({r:4,c:y}),old=s[c];s[c]=s[d];s[d]=old;}))).rejects.toThrow('workbook_columns_changed');
  await expect(parse(await edit(bytes,wb=>{wb.Sheets.Increment.A6={t:'s',v:'OTHER'};}))).rejects.toThrow('workbook_identity_changed');
 });
 it('refuses modified metadata, wrong company, key rotation and formulas outside sanctioned green cells',async()=>{
  const bytes=await make();await expect(readMovementWorkbook(bytes,{tenantId:a,companyId:b,catalog,resolve})).rejects.toThrow('workbook_company_mismatch');
  const columns=movementWorkbookLayout(catalog.types[0],resolve),c=columns.findIndex(x=>x.key==='incrementAmount');
  await expect(parse(await edit(bytes,wb=>{wb.Sheets.Increment[XLSX.utils.encode_cell({r:5,c})]={t:'n',v:100,f:'1+99'};}))).rejects.toThrow('formula_input');
  await expect(parse(await edit(bytes,wb=>{wb.Sheets.Instructions.A1={t:'n',v:1,f:'1+1'};}))).rejects.toThrow('formula_input');
  await expect(parse(await edit(bytes,wb=>{wb.Sheets._meta.A1.v=String(wb.Sheets._meta.A1.v).replace('Fictional A','Tampered');}))).rejects.toThrow('workbook_metadata_invalid');
  vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','rotated-fixture');await expect(parse(bytes)).rejects.toThrow('workbook_metadata_invalid');
 });
 it('keeps all active custom tabs collision-safe and binds duplicate Excel row numbers to different normalized records',async()=>{
  const bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog,subjects:[],resolve}),wb=XLSX.read(bytes,{type:'buffer'});
  expect(wb.SheetNames).toEqual(['Instructions','Increment','Increment (2)','Resignation','Lists','_meta']);
  const changed=await edit(bytes,book=>{for(const name of ['Increment','Increment (2)']){const columns=movementWorkbookLayout(catalog.types[name==='Increment'?0:1],resolve);book.Sheets[name].A6={t:'s',v:'EX-001'};for(const [key,value]of [['incrementAmount','100'],['effectiveDate','2026-11-01']])book.Sheets[name][XLSX.utils.encode_cell({r:5,c:columns.findIndex(c=>c.key===key)})]={t:'s',v:value};}});
  const parsed=await parse(changed);expect(parsed.records).toHaveLength(2);expect(new Set(parsed.records.map(r=>r.row)).size).toBe(2);expect(parsed.records.map(r=>r.source?.row)).toEqual([6,6]);
 });
 it('does not use passwords, caches or altered grey/green values as authority',async()=>{
  const bytes=await make(),columns=movementWorkbookLayout(catalog.types[0],resolve),amount=columns.findIndex(c=>c.key==='incrementAmount'),date=columns.findIndex(c=>c.key==='effectiveDate'),grey=columns.findIndex(c=>c.key==='current.basicSalary');
  const changed=await edit(bytes,wb=>{const s=wb.Sheets.Increment;s[XLSX.utils.encode_cell({r:5,c:grey})]={t:'n',v:9999999};s[XLSX.utils.encode_cell({r:5,c:amount})]={t:'s',v:'10.13'};s[XLSX.utils.encode_cell({r:5,c:date})]={t:'s',v:'2026-11-01'};});
  const row=(await parse(changed)).records[0];expect(row.incrementAmount).toBe('10.13');expect(row.cells.basicSalary).toBeUndefined();
 });
});
