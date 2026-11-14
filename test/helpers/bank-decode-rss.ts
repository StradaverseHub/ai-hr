/**
 * MEASUREMENT ONLY (branch claude/bank-import-memory-measure-20261114, never merged): the Bank queued-tick decode of
 * a maximum-size CSV and workbook, each in its own fresh Node process, so the reported peak (getrusage maxRSS) is the
 * decoder's own footprint and not the test process's fixture garbage. `new` is the worker's stageBankImportSource
 * plus the insert loop's per-batch JSON; `old` is the previous worker path (Buffer.concat, decodeBankImportSource,
 * 1,000-record slices to JSON). No database. Fictional data only.
 */
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import JSZip from 'jszip';
import {BANK_IMPORT_MAX_BYTES,BANK_IMPORT_MAX_ROWS} from '../../lib/bank-import-job';
import {BANK_CAPTIONS,BANK_COLUMNS,TAG,bankRow,padForSizeLimit,worstCaseCsv} from './worker-stall-measure';
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


export async function measureDecodes(mode:'old'|'new'){
 const dir=mkdtempSync(join(tmpdir(),'bank-decode-rss-'));
 const csvPath=join(dir,'bank-statutory.csv'),xlsxPath=join(dir,'bank-statutory.xlsx');
 writeFileSync(csvPath,worstCaseCsv(ROWS));writeFileSync(xlsxPath,await worstCaseXlsx());
 const results=[];
 for(const [format,path] of [['csv',csvPath],['xlsx',xlsxPath]] as const){
  const child=spawnSync(process.execPath,['--import','tsx','test/helpers/bank-decode-rss-child.ts',mode,path],{encoding:'utf8',maxBuffer:16*1024*1024,timeout:900_000});
  const line=child.stdout.split('\n').find(l=>l.startsWith('RESULT '));
  if(!line)throw new Error(`child ${mode} ${format} failed (${child.status} ${child.signal}): ${child.stderr.slice(-2000)}`);
  const result={format,...JSON.parse(line.slice(7))};results.push(result);
  console.info(`${TAG} isolated decode ${JSON.stringify(result)}`);
 }
 return results;
}
