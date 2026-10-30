/**
 * d9e33556 — one per-sheet-role contract for the Movement template: what the generator writes, the bounded
 * archive inspection admits and SheetJS reads must agree. A freshly downloaded template with a large Reference
 * catalogue is readable unchanged; structural refusals keep distinct codes; data problems stay row-level.
 * Synthetic fixtures only.
 */
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {buildMovementWorkbook,readMovementSource,readMovementWorkbookRows,MOVEMENT_WORKBOOK_SHEET_ROWS,MOVEMENT_WORKBOOK_STANDARD_SHEET_ROWS,MOVEMENT_WORKBOOK_LIMITS} from '../lib/movement-workbook.server';
import {movementRowsToRecords,movementSystemFields} from '../lib/movement-import-rows';
import {movementImportIssueText} from '../lib/movement-import-issues';
import type {MovementImportCatalog} from '../core/movement-import';
import en from '../messages/en.json';

const tenant='11111111-1111-4111-8111-111111111111',foreign='22222222-2222-4222-8222-222222222222';
const types=[{code:'transfer',label:'Transfer',behaviour:'transfer'},{code:'increment',label:'Increment',behaviour:'increment'}];
const resolve=(_key:string,fallback:string)=>fallback;
const departments=(n:number)=>Array.from({length:n},(_,i)=>({value:`dept-${i}`,codes:[`D${String(i).padStart(6,'0')}`],label:`Fictional department ${i}`}));
const catalog=(n:number):MovementImportCatalog=>({types,companies:[{value:tenant,label:'Fictional Co'}],fields:{departmentId:departments(n)}});
const build=(n:number)=>buildMovementWorkbook({tenantId:tenant,types,companies:[{companyId:tenant,code:'FIC',name:'Fictional Co',catalog:catalog(n)}],resolve});
const rows=(bytes:Buffer,tenantId=tenant,list=types)=>readMovementWorkbookRows(bytes,{tenantId,types:list});
const source=(bytes:Buffer,name='movement-import.xlsx')=>readMovementSource(name,bytes,{tenantId:tenant,types,resolve});
const deptLabel=movementSystemFields(types[0],resolve).find(f=>f.key==='departmentId')!.label;
async function fill(bytes:Buffer,values:string[][]){const wb=XLSX.read(bytes,{type:'buffer',cellFormula:true});const sheet=wb.Sheets.Movements;values.forEach((row,r)=>row.forEach((v,c)=>{sheet[XLSX.utils.encode_cell({r:r+1,c})]={t:'s',v};}));const range=XLSX.utils.decode_range(sheet['!ref']!);range.e.r=Math.max(range.e.r,values.length);sheet['!ref']=XLSX.utils.encode_range(range);return Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}));}
async function patch(bytes:Buffer,part:string,edit:(text:string)=>string){const zip=await JSZip.loadAsync(bytes);zip.file(part,edit(await zip.file(part)!.async('string')));return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});}
/** Sheet XML part for a sheet name, resolved the same way a reader does. */
async function partOf(bytes:Buffer,name:string){const zip=await JSZip.loadAsync(bytes),wb=await zip.file('xl/workbook.xml')!.async('string'),rels=await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
 const id=new RegExp(`<sheet[^>]*name="${name}"[^>]*r:id="([^"]+)"`).exec(wb)![1];return 'xl/'+new RegExp(`<Relationship[^>]*Id="${id}"[^>]*Target="([^"]+)"`).exec(rels)![1].replace(/^\/?xl\//,'');}
const setDimension=(rows:number,col='D')=>(text:string)=>text.replace(/<dimension ref="[^"]*"\/>/,`<dimension ref="A1:${col}${rows}"/>`);
const addCell=(row:number,inner='<is><t>x</t></is>',col='A')=>(text:string)=>text.replace('</sheetData>',`<row r="${row}"><c r="${col}${row}" t="inlineStr">${inner}</c></row></sheetData>`);
beforeEach(()=>{vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY',Buffer.alloc(32,9).toString('base64url'));vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','public-fixture-only');});
afterEach(()=>{vi.unstubAllEnvs();});

describe('per-sheet-role workbook contract (d9e33556)',()=>{
 it('exposes one explicit contract: only Reference is larger; Movements data limits stay 200 rows / 50 employees / 11 columns (646355e5 slice C)',()=>{
  expect(MOVEMENT_WORKBOOK_SHEET_ROWS).toEqual({Instructions:10_005,Movements:10_005,Reference:50_000,Lists:10_005,_meta:10_005});
  expect(MOVEMENT_WORKBOOK_STANDARD_SHEET_ROWS).toBe(10_005);
  expect(MOVEMENT_WORKBOOK_LIMITS).toEqual({maxBytes:5_000_000,maxExpandedBytes:64_000_000,maxEntries:6000,maxCells:650_000});
 });

 describe('with a Reference catalogue above the old 10005-row guard',()=>{
  let big:Buffer;
  beforeEach(async()=>{big??=await build(10_400);},60_000);

  it('round-trips a blank unchanged download to "no movement entries", not a structure error',async()=>{
   const wb=XLSX.read(big,{type:'buffer'});expect(XLSX.utils.decode_range(wb.Sheets.Reference['!ref']!).e.r+1).toBeGreaterThan(10_005);
   expect(wb.SheetNames).toEqual(['Instructions','Movements','Reference','Lists','_meta']);
   expect(await rows(big)).toEqual([]);
   const read=await source(big);expect(read).toEqual({records:[],fileErrors:['no_movement_entries']});
   expect(movementImportIssueText(read.fileErrors,(key,fallback)=>{const v=key.split('.').reduce<unknown>((o,k)=>(o as Record<string,unknown>)?.[k],en);return typeof v==='string'?v:fallback;})).toMatch(/no movement entries to check/i);
  },60_000);

  it('reads valid entries into grouped movement records with their worksheet and original Excel rows',async()=>{
   const read=await source(await fill(big,[['FIC','E1001','Alex Example','01-Jan-2027','Transfer',deptLabel,'','D000123'],['FIC','E1002','','2027-02-01','Increment','incrementAmount','','100']]));
   expect(read.fileErrors).toEqual([]);
   expect(read.records.map(r=>({row:r.row,source:r.source,sourceRows:r.sourceRows,errors:r.errors}))).toEqual([{row:2,source:{sheet:'Movements',row:2},sourceRows:[2],errors:[]},{row:3,source:{sheet:'Movements',row:3},sourceRows:[3],errors:[]}]);
   expect(read.records[0].cells).toMatchObject({kind:'transfer',departmentId:'D000123'});
  },60_000);

  it('reports invalid required values and invalid dates on the right row and field, as data errors',async()=>{
   const read=await source(await fill(big,[
    ['FIC','E1001','','01-Jan-2027','Transfer',deptLabel,'',''],
    ['','E1002','','01-Jan-2027','Transfer',deptLabel,'','D000001'],
    ['FIC','E1003','','31-Feb-2027','Transfer',deptLabel,'','D000002'],
    ['FIC','E1004','','not a date','Increment','incrementAmount','','5'],
   ]));
   expect(read.fileErrors).toEqual([]);
   expect(read.records.map(r=>[r.source?.sheet,r.row,r.errors])).toEqual([
    ['Movements',2,['required:departmentId']],['Movements',3,['company_required']],['Movements',4,['invalid_effective_date']],['Movements',5,['invalid_effective_date']],
   ]);
  },60_000);

  it('applies the larger bound only to the part bound to the sheet named Reference',async()=>{
   const reference=await partOf(big,'Reference');
   const renamed=await patch(big,'xl/workbook.xml',text=>text.replace('name="Reference"','name="Reference Copy"'));
   await expect(rows(renamed)).rejects.toThrow('workbook_too_large');
   const aliased=await patch(big,'xl/workbook.xml',text=>text.replace(/(<sheet [^>]*name="Lists"[^>]*r:id=")[^"]+(")/,(_all,a,b)=>a+/<sheet [^>]*name="Reference"[^>]*r:id="([^"]+)"/.exec(text)![1]+b));
   await expect(rows(aliased)).rejects.toThrow('workbook_structure_invalid');
   expect(reference).toMatch(/^xl\/worksheets\/sheet\d+\.xml$/);
  },60_000);

  it('refuses a formula far below the old SheetJS row cut-off on Reference',async()=>{
   const reference=await partOf(big,'Reference');
   await expect(rows(await patch(big,reference,addCell(12_000,'<f>1+1</f><v>2</v>')))).rejects.toThrow('formula_input');
  },60_000);
 });

 it('admits a Reference sheet at the new bound and refuses one row over it as oversized',async()=>{
  const bytes=await build(5),reference=await partOf(bytes,'Reference');
  expect(await rows(await patch(bytes,reference,text=>addCell(50_000)(setDimension(50_000)(text))))).toEqual([]);
  await expect(rows(await patch(bytes,reference,setDimension(50_001)))).rejects.toThrow('workbook_too_large');
  await expect(rows(await patch(bytes,reference,addCell(50_001)))).rejects.toThrow('workbook_too_large');
 },60_000);

 it('fails the download explicitly when the catalogue exceeds the supported Reference bound',async()=>{
  await expect(build(50_000)).rejects.toThrow('movement_reference_catalog_too_large');
 },60_000);

 it('keeps the standard bound on Movements and other sheets; more than 200 entered rows is a data limit',async()=>{
  const bytes=await build(5),movements=await partOf(bytes,'Movements'),instructions=await partOf(bytes,'Instructions');
  await expect(rows(await patch(bytes,movements,setDimension(10_006,'H')))).rejects.toThrow('workbook_too_large');
  await expect(rows(await patch(bytes,movements,addCell(10_006)))).rejects.toThrow('workbook_too_large');
  await expect(rows(await patch(bytes,instructions,addCell(10_006)))).rejects.toThrow('workbook_too_large');
  const many=await fill(bytes,Array.from({length:201},(_,i)=>['FIC',`E${2000+i}`,'','01-Jan-2027','Increment','incrementAmount','','1']));
  expect((await source(many)).fileErrors).toEqual(['too_many_rows']);
  const employees=await fill(bytes,Array.from({length:51},(_,i)=>['FIC',`E${3000+i}`,'','01-Jan-2027','Increment','incrementAmount','','1']));
  expect((await source(employees)).fileErrors).toEqual(['too_many_employees']);
  // As Excel saves it: the note in column L (after the eleven version 4 columns) also widens the dimension.
  const wide=await patch(bytes,movements,text=>setDimension(202,'L')(addCell(202,'<is><t>note</t></is>','L')(text)));
  expect((await source(wide)).fileErrors).toEqual(['workbook_columns_changed']);
 },60_000);

 it('gives distinct codes for empty, damaged, oversized, altered, stale, foreign and formula files',async()=>{
  const bytes=await build(5);
  expect((await source(Buffer.alloc(0))).fileErrors).toEqual(['empty_file']);
  expect((await source(bytes.subarray(0,bytes.length-40))).fileErrors).toEqual(['workbook_damaged']);
  expect((await source(Buffer.from('not a workbook at all'))).fileErrors).toEqual(['workbook_damaged']);
  expect((await source(Buffer.alloc(MOVEMENT_WORKBOOK_LIMITS.maxBytes+1))).fileErrors).toEqual(['file_too_large']);
  const headers=await (async()=>{const wb=XLSX.read(bytes,{type:'buffer'});wb.Sheets.Movements.A1={t:'s',v:'Firm ID'};return Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}));})();
  expect((await source(headers)).fileErrors).toEqual(['workbook_columns_changed']);
  const tampered=(()=>{const wb=XLSX.read(bytes,{type:'buffer'});wb.Sheets._meta.A1.v=String(wb.Sheets._meta.A1.v).replace('"downloadedAt":"2','"downloadedAt":"1');return Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}));})();
  expect((await source(tampered)).fileErrors).toEqual(['workbook_metadata_invalid']);
  await expect(rows(bytes,foreign)).rejects.toThrow('workbook_metadata_invalid');
  await expect(rows(bytes,tenant,types.slice(1))).rejects.toThrow('workbook_catalogue_changed');
  const movements=await partOf(bytes,'Movements');
  expect((await source(await patch(bytes,movements,text=>text.replace(/<c r="H2"[^>]*\/>|<c r="H2"[^>]*>[\s\S]*?<\/c>/,'<c r="H2"><f>1+1</f><v>2</v></c>')))).fileErrors).toEqual(['formula_input']);
  const doctype=await patch(bytes,movements,text=>text.replace('<worksheet','<!DOCTYPE worksheet><worksheet'));
  expect((await source(doctype)).fileErrors).toEqual(['workbook_damaged']);
  const external=await patch(bytes,'xl/_rels/workbook.xml.rels',text=>text.replace('</Relationships>','<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/" TargetMode="External"/></Relationships>'));
  expect((await source(external)).fileErrors).toEqual(['workbook_structure_invalid']);
 },60_000);

 it('still enforces the ZIP expanded-size, entry-count and cell budgets',async()=>{
  const bytes=await build(5);
  const expanded=await JSZip.loadAsync(bytes);expanded.file('xl/padding.xml','<a>'+' '.repeat(MOVEMENT_WORKBOOK_LIMITS.maxExpandedBytes)+'</a>');
  expect((await source(await expanded.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))).fileErrors).toEqual(['workbook_too_large']);
  const entries=await JSZip.loadAsync(bytes);for(let i=0;i<MOVEMENT_WORKBOOK_LIMITS.maxEntries;i++)entries.file(`xl/pad/${i}.xml`,'<a/>');
  expect((await source(await entries.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))).fileErrors).toEqual(['workbook_damaged']);
  // 36 rows × 18278 columns stays inside the row bound but exceeds the 650000-cell budget.
  const col=(n:number)=>{let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;},columns=Array.from({length:18_278},(_,c)=>col(c));
  const cells=Array.from({length:36},(_,r)=>`<row r="${r+20}">${columns.map(c=>`<c r="${c}${r+20}"/>`).join('')}</row>`).join('');
  const instructions=await partOf(bytes,'Instructions');
  expect((await source(await patch(bytes,instructions,text=>text.replace('</sheetData>',cells+'</sheetData>').replace(/<dimension ref="[^"]*"\/>/,'<dimension ref="A1:ZZZ55"/>')))).fileErrors).toEqual(['workbook_too_large']);
 },120_000);

 it('has every new message in every locale',async()=>{
  for(const locale of ['en','ms','ta','th','vi','zh']){
   const issues=(await import(`../messages/${locale}.json`)).default.people.import.movement.issues;
   for(const code of ['no_movement_entries','workbook_damaged','workbook_too_large'])expect(typeof issues[code]).toBe('string');
  }
 });
});

describe('structural admission is separate from data validation',()=>{
 it('maps an empty row set to no_movement_entries without touching record validation',()=>{
  expect(movementRowsToRecords([],types,[resolve])).toEqual({records:[],fileErrors:['no_movement_entries']});
 });
});
