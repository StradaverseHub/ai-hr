/**
 * MEASUREMENT ONLY — branch claude/bank-import-memory-measure-20261114 (copied from claude/worker-stall-measure-20261114), never merged (see
 * test/worker-stall-measure-bank-csv.test.ts). Times the Bank & Statutory first tick for a maximum-size Excel
 * workbook: 250,000 data rows with every template column, written the way Excel saves one (shared-string table,
 * cell references), whose CSV projection is just under 128 MiB. The workbook path decodes through SheetJS, the
 * slowest decoder the worker has. Assertions are sanity only.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import type {SessionContext} from '../db/client';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob} from '../core/bank-import-job';
import {runBankImportTick} from '../core/bank-import-worker';
import {stageBankImportSource} from '../lib/bank-import-stream-source.server';
import {BANK_IMPORT_CHUNK_BYTES,BANK_IMPORT_MAX_BYTES,BANK_IMPORT_MAX_ROWS} from '../lib/bank-import-job';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {BANK_CAPTIONS,BANK_COLUMNS,TAG,bankRow,clock,hostLine,padForSizeLimit,summary} from './helpers/worker-stall-measure';

let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});afterAll(closeAll);
const ROWS=BANK_IMPORT_MAX_ROWS;
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main',REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships',PKG='http://schemas.openxmlformats.org/package/2006/relationships';
const letter=(i:number):string=>i<26?String.fromCharCode(65+i):letter(Math.floor(i/26)-1)+String.fromCharCode(65+(i%26));
const esc=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/** An Excel-shaped workbook: one sheet, shared strings, explicit cell references, blank cells omitted. */
async function worstCaseXlsx():Promise<Buffer>{
 const pad=padForSizeLimit(ROWS),letters=BANK_COLUMNS.map((_,i)=>letter(i));
 const strings=new Map<string,number>(),index=(s:string)=>{let i=strings.get(s);if(i===undefined){i=strings.size;strings.set(s,i);}return i;};
 let count=0;const sheet:Buffer[]=[Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${REL}"><dimension ref="A1:${letters.at(-1)}${ROWS+1}"/><sheetData>`)];
 let page:string[]=[];
 for(let r=0;r<=ROWS;r++){
  const values=r===0?BANK_CAPTIONS:bankRow(r,pad);
  let xml=`<row r="${r+1}">`;
  values.forEach((v,c)=>{if(v!==''){count++;xml+=`<c r="${letters[c]}${r+1}" t="s"><v>${index(v)}</v></c>`;}});
  page.push(xml+'</row>');
  if(page.length===5000){sheet.push(Buffer.from(page.join('')));page=[];}
 }
 sheet.push(Buffer.from(page.join('')+'</sheetData></worksheet>'));
 const sst:Buffer[]=[Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS}" count="${count}" uniqueCount="${strings.size}">`)];
 page=[];for(const s of strings.keys()){page.push(`<si><t>${esc(s)}</t></si>`);if(page.length===20000){sst.push(Buffer.from(page.join('')));page=[];}}
 sst.push(Buffer.from(page.join('')+'</sst>'));
 const zip=new JSZip();
 zip.file('[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`);
 zip.file('_rels/.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
 zip.file('xl/workbook.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Bank and Statutory" sheetId="1" r:id="rId1"/></sheets></workbook>`);
 zip.file('xl/_rels/workbook.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
 const sheetXml=Buffer.concat(sheet),sstXml=Buffer.concat(sst);
 zip.file('xl/worksheets/sheet1.xml',sheetXml);zip.file('xl/sharedStrings.xml',sstXml);
 const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}});
 console.info(`${TAG} XLSX: ${ROWS} rows x ${BANK_COLUMNS.length} columns, ${count} filled cells, ${strings.size} shared strings, sheet XML ${(sheetXml.length/1048576).toFixed(1)} MiB, shared strings ${(sstXml.length/1048576).toFixed(1)} MiB, file ${(bytes.length/1048576).toFixed(1)} MiB (limit ${BANK_IMPORT_MAX_BYTES/1048576} MiB)`);
 if(bytes.length>BANK_IMPORT_MAX_BYTES)throw Error('Generated workbook exceeds the limit');
 return bytes;
}

describe('MEASUREMENT: import worker Bank & Statutory first tick at the maximum workbook',()=>{
 it('times decode and the queued -> validating tick of a 250,000-row workbook',async()=>{
  hostLine();
  const xlsx=await clock('generate workbook (fixture only)',worstCaseXlsx);
  const decoded=await clock('decode only (stageBankImportSource, XLSX)',async()=>{
   try{const d=await stageBankImportSource('bank-statutory.xlsx',[xlsx]);return{rows:d.total,errors:d.errors.size,first:(JSON.parse(d.batches[0].toString()) as string[][])[0][d.headers.indexOf('employee_code')]};}
   catch(error){console.info(`${TAG} decode failed: ${error instanceof Error?`${error.name} ${error.message}`:String(error)}`);throw error;}
  });
  console.info(`${TAG} decoded ${JSON.stringify(decoded)}`);
  expect(decoded).toMatchObject({rows:ROWS,errors:0,first:'SCALE1'});
  const admission=await createBankImportJob(ctx,{name:'bank-statutory.xlsx',bytes:xlsx.length,hash:createHash('sha256').update(xlsx).digest('hex')});
  for(let offset=0,part=0;offset<xlsx.length;offset+=BANK_IMPORT_CHUNK_BYTES,part++)await uploadBankImportChunk(ctx,admission.job.id,part,xlsx.subarray(offset,offset+BANK_IMPORT_CHUNK_BYTES));
  await bankImportCommand(ctx,admission.job.id,'validate');
  // PHASE OF CONCERN: exactly the unit the runner wraps in watchdog.enter('bank').
  expect(await clock('bank tick 1: queued -> validating (fetch + SheetJS decode + insert 250,000 rows)',()=>runBankImportTick(owner.client))).toBe(true);
  const staged=(await getBankImportJob(ctx,admission.job.id)).job;
  if(staged.state!=='validating')console.info(`${TAG} queued tick ended in ${staged.state}: ${staged.error}`);
  expect(staged).toMatchObject({state:'validating',total:ROWS});
  expect(await clock('bank validation tick 1 (1,000 rows, no matching employees)',()=>runBankImportTick(owner.client))).toBe(true);
  summary('bank-xlsx');
 },1_080_000);
});
