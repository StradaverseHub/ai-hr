/**
 * The worker's bounded-memory Bank & Statutory decoder (lib/bank-import-stream-source.server.ts) against the
 * whole-file decoder it replaces in the worker (decodeBankImportSource, kept unchanged): identical records (keys,
 * key order, values, row order), identical duplicate errors (and their order), and the identical thrown error for
 * every refused file, across CSV part boundaries and Excel workbooks. Fictional data only; no database.
 */
import {describe,expect,it} from 'vitest';
import JSZip from 'jszip';
import {decodeBankImportSource} from '../lib/bank-import-source.server';
import {BANK_IMPORT_STAGE_ROWS,bankImportStagedRecords,stageBankImportSource,type BankImportStaged} from '../lib/bank-import-stream-source.server';
import {BANK_IMPORT_MAX_BYTES,BANK_IMPORT_MAX_ROWS} from '../lib/bank-import-job';
import {buildPersonnelCsv} from '../lib/personnel-csv';
import {personnelColumnLabel} from '../lib/personnel-import-contract';
import {buildXlsx} from '../lib/spreadsheet';

type Outcome={ok:true;records:string;errors:[number,string][]}|{ok:false;error:string;message:string;code?:string};
const describeError=(error:unknown):Outcome=>({ok:false,error:(error as Error)?.constructor?.name??typeof error,message:(error as Error)?.message??String(error),
 ...typeof (error as {code?:unknown})?.code==='string'?{code:(error as {code:string}).code}:{}});
function materialize(staged:BankImportStaged){
 const records=staged.batches.flatMap((_,batch)=>bankImportStagedRecords(staged,batch));
 return {records,errors:staged.errors};
}
async function legacy(name:string,bytes:Buffer):Promise<Outcome>{
 try{const d=await decodeBankImportSource(name,bytes);return{ok:true,records:JSON.stringify(d.records),errors:[...d.errors]};}catch(error){return describeError(error);}
}
const split=(bytes:Buffer,size:number)=>{const parts:Buffer[]=[];for(let o=0;o<bytes.length;o+=size)parts.push(bytes.subarray(o,o+size));return parts;};
async function streamed(name:string,parts:Uint8Array[]):Promise<Outcome>{
 try{const d=materialize(await stageBankImportSource(name,parts));return{ok:true,records:JSON.stringify(d.records),errors:[...d.errors]};}catch(error){return describeError(error);}
}
/** Same outcome for every part size, including one byte (splits every UTF-8 sequence, quote pair and CRLF). */
async function same(name:string,bytes:Buffer,sizes=[1,3,7,64,1048576]){
 const expected=await legacy(name,bytes);
 for(const size of sizes)expect(await streamed(name,split(bytes,size)),`${name} in ${size}-byte parts`).toEqual(expected);
 return expected;
}
const csv=(text:string)=>Buffer.from(text,'utf8');
const H='employee_code,bank_name,bank_account_no,tax_number,custom_holder_name,epf_citizenship,tax_residency,card_id';

describe('CSV: streamed decode equals the whole-file decode',()=>{
 it('keeps quoting, embedded line endings, blank rows, leading zeros, choices and Unicode across part boundaries',async()=>{
  const text=`\uFEFF${H}\r\n`+
   'E001,Maybank,000123,"T,1","Tan ""Wei"" Ming",PR,resident,C1\r\n'+
   '\r\n,,,,,,,\r\n'+
   'E002,"CIMB","0042","multi\r\nline","line\nfeed",citizen,Non-Resident,\n'+
   'E003 ,  RHB , 00 , tx3 ,Lim 林美玲 😀,  pr ,knowledge_worker,c3\r'+
   'E004,,0,,"éè",unknown choice,,\n'+
   '   ,  ,\n'+
   'e001,Maybank,1,,,,,C1\n'+
   'E005,Public,5,,"",,,c3';
  const outcome=await same('bank.csv',csv(text));
  expect(outcome.ok).toBe(true);
 });
 it('decodes a Personnel-framed file with display headings and protected cells',async()=>{
  const captions=['employee_code','bank_name','bank_account_no','custom_holder_name','epf_citizenship'].map(c=>personnelColumnLabel(c,'employee'));
  const bytes=Buffer.from(buildPersonnelCsv('employee',[captions,['E1','Maybank','0001','=SUM(A1)','PR'],['E2','CIMB','-12','~p1~kept','Citizen'],['E3','RHB','@x',"'quoted",'']]));
  const outcome=await same('framed.csv',bytes);
  expect(outcome).toMatchObject({ok:true});
 });
 it('treats a double byte-order mark, invalid UTF-8 and CR-only files the same way',async()=>{
  await same('bom.csv',Buffer.concat([Buffer.from([0xef,0xbb,0xbf,0xef,0xbb,0xbf]),csv('employee_code,tax_number\nE1,T1\n')]));
  await same('invalid.csv',Buffer.concat([csv('employee_code,tax_number\nE1,'),Buffer.from([0xff,0xfe,0xc3]),csv('\nE2,T2')]));
  await same('cr.csv',csv('employee_code,tax_number\rE1,T1\rE2,T2\r'));
 });
 it('refuses the same malformed files with the same error, and accepts the same edge cases',async()=>{
  for(const [name,text,decodes] of [
   ['open-quote.csv','employee_code,tax_number\nE1,"T1\n',false],
   ['after-quote.csv','employee_code,tax_number\nE1,"T1"x\n',false],
   ['inner-quote.csv','employee_code,tax_number\nE1,T"1\n',false],
   ['closing-only.csv','employee_code,tax_number\nE1,""',true],
   ['quote-at-end.csv','employee_code,tax_number\nE1,"T1"',true],
   ['unknown-heading.csv','employee_code,no_such_column\nE1,x\n',false],
   ['repeated-heading.csv','employee_code,tax_number,tax_number\nE1,x,y\n',false],
   ['beyond.csv','employee_code,tax_number\nE1,T1\nE2,T2,extra\n',false],
   ['beyond-blank.csv','employee_code,tax_number\nE1,T1,   \n',true],
   ['header-then-malformed.csv','employee_code,no_such_column\nE1,x\nE2,"open\n',false],
   ['header-only.csv','employee_code,tax_number\n',false],
   ['frame-version.csv','AI-HR Personnel CSV,2,employee\nemployee_code\nE1\n',false],
   ['frame-sheet.csv','AI-HR Personnel CSV,1,family\nemployee_code\nE1\n',false],
   ['frame-width.csv','AI-HR Personnel CSV,1,employee,note,extra\nemployee_code\nE1\n',false],
   ['frame-only.csv','AI-HR Personnel CSV,1,employee\n',false],
   ['whitespace.csv',' \t\r\n  \n',false],
   ['bom-only.csv','\uFEFF',false],
   ['wide.csv',Array.from({length:257},()=>'a').join(',')+'\n',false],
   ['bank.txt','employee_code\nE1\n',false],
  ] as const){
   const outcome=await same(name,csv(text),[1,5,1048576]);
   expect(outcome.ok,name).toBe(decodes);
  }
 });
 it('applies the field-length budget at exactly the same length, before a whitespace-only check',async()=>{
  for(const length of [1048576,1048577]){
   await same(`field-${length}.csv`,csv(`employee_code,tax_number\nE1,${'x'.repeat(length)}\n`),[65536,1048576]);
   await same(`quoted-${length}.csv`,csv(`employee_code,tax_number\nE1,"${'"'.repeat(2*length)}"\n`),[65536,1048576]);
  }
  await same('spaces.csv',csv(' '.repeat(2*1048576)),[1048576]);
  await same('spaces-then-text.csv',csv(' '.repeat(2*1048576)+'x'),[1048576]);
 },60_000);
 it('keeps whole-file duplicate Employee ID and Card ID errors, in the same order, across staged batches',async()=>{
  const rows=Array.from({length:2*BANK_IMPORT_STAGE_ROWS+5},(_,i)=>`EMP${i%1500},CARD${i%1700}`);
  const outcome=await same('dupes.csv',csv('employee_code,card_id\n'+rows.join('\n')),[4096,1048576]);
  expect(outcome.ok&&outcome.errors.length).toBeGreaterThan(0);
 });
 it('enforces the row-count boundaries identically',async()=>{
  const file=(n:number)=>csv('employee_code\n'+Array.from({length:n},(_,i)=>`E${i}`).join('\n'));
  // MAX rows decode; MAX+1 data rows pass the CSV row limit (MAX+2 including the heading) and fail the count;
  // MAX+2 data rows exceed the CSV row limit itself.
  for(const n of [BANK_IMPORT_MAX_ROWS,BANK_IMPORT_MAX_ROWS+1,BANK_IMPORT_MAX_ROWS+2]){
   const outcome=await same(`rows-${n}.csv`,file(n),[1048576]);
   expect(outcome.ok,String(n)).toBe(n===BANK_IMPORT_MAX_ROWS);
  }
 // Estimate: the existing 100,001-row decode case is budgeted 30 s; this decodes 250,000-row files six times.
 },300_000);
 it('refuses a file above the byte ceiling before reading it',async()=>{
  const bytes=Buffer.alloc(BANK_IMPORT_MAX_BYTES+1,0x20);
  expect(await streamed('huge.csv',[bytes])).toEqual(await legacy('huge.csv',bytes));
 },60_000);
});

describe('CSV: incremental memory shape',()=>{
 it('releases each stored part once decoded and stages compact batches instead of record objects',async()=>{
  const bytes=csv('employee_code,tax_number\n'+Array.from({length:2500},(_,i)=>`E${i},T${i}`).join('\n'));
  const parts=split(bytes,1024);const count=parts.length;
  const events:string[]=[];
  const guarded=new Array<Uint8Array>(count);
  for(let k=0;k<count;k++){
   let value:Uint8Array=parts[k];
   Object.defineProperty(guarded,k,{get(){events.push(`get ${k}`);return value;},set(next:Uint8Array){events.push(`release ${k}:${next.length}`);value=next;},enumerable:true});
  }
  const staged=await stageBankImportSource('shape.csv',guarded);
  // After the size check, each part is read once and released before the next one is read.
  const decodeOrder=events.slice(count);
  expect(decodeOrder).toEqual(Array.from({length:count},(_,k)=>[`get ${k}`,`release ${k}:0`]).flat());
  expect(count).toBeGreaterThan(10);
  expect(staged.total).toBe(2500);expect(Object.keys(staged)).not.toContain('records');
  expect(staged.batches.map(batch=>Buffer.isBuffer(batch))).toEqual([true,true,true]);
  expect(staged.batches.map(batch=>JSON.parse(batch.toString()).length)).toEqual([1000,1000,500]);
 });
 it('stops reading parts after the first CSV error once the file is known to be non-blank',async()=>{
  let first:Uint8Array=csv('employee_code,tax_number\nE1,"T1"x\n'),released=false;const second=csv('E2,T2\n');
  const parts:Uint8Array[]=[];
  Object.defineProperty(parts,0,{get:()=>first,set:(next:Uint8Array)=>{first=next;released=true;},enumerable:true});
  // Readable for the up-front size check; reading it during decoding would mean the decoder went past the error.
  Object.defineProperty(parts,1,{get:()=>{if(released)throw new Error('read past the error');return second;},enumerable:true});
  await expect(stageBankImportSource('stop.csv',parts)).rejects.toThrow('Malformed CSV near data row 2');
 });
});

const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main',REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships',PKG='http://schemas.openxmlformats.org/package/2006/relationships';
/** A hand-written workbook: Excel-style parts, shared strings, styles with date formats, optional 1904 dates. */
async function workbook(sheets:{name:string;rows:string;dimension?:string}[],sst:string[],options:{date1904?:boolean}={}){
 const zip=new JSZip();
 zip.file('[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
 zip.file('_rels/.rels',`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
 zip.file('xl/workbook.xml',`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" xmlns:r="${REL}">${options.date1904?'<workbookPr date1904="1"/>':''}<sheets>${sheets.map((s,i)=>`<sheet name="${s.name}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`);
 zip.file('xl/_rels/workbook.xml.rels',`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${REL}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdT" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
 zip.file('xl/styles.xml',`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="0.00"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="49" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/></cellXfs></styleSheet>`);
 zip.file('xl/sharedStrings.xml',`<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${NS}" count="${sst.length}" uniqueCount="${sst.length}">${sst.join('')}</sst>`);
 sheets.forEach((s,i)=>zip.file(`xl/worksheets/sheet${i+1}.xml`,`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}" xmlns:r="${REL}">${s.dimension?`<dimension ref="${s.dimension}"/>`:''}<sheetData>${s.rows}</sheetData></worksheet>`));
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
const t=(text:string)=>`<si><t xml:space="preserve">${text}</t></si>`;
const header='<row r="1">'+['employee_code','bank_name','bank_account_no','tax_number','custom_holder_name','epf_citizenship'].map((_,c)=>`<c r="${'ABCDEF'[c]}1" t="s"><v>${c}</v></c>`).join('')+'</row>';
const headerSst=['employee_code','bank_name','bank_account_no','tax_number','custom_holder_name','epf_citizenship'].map(t);

describe('Excel: streamed decode equals the whole-file decode',()=>{
 it('keeps every cell type, date, number rendering, leading zero, blank row and sparse cell',async()=>{
  const sst=[...headerSst,t('000123'),'<si><r><rPr><b/></rPr><t>Rich</t></r><r><t xml:space="preserve"> text</t></r><rPh sb="0" eb="1"><t>ph</t></rPh></si>',t('a_x000D_b &amp; &lt;c&gt;'),t('comma, "quote"\nline'),t('   '),t('pr'),t('E3')];
  const rows=header+
   '<row r="2"><c r="A2" t="inlineStr"><is><t>E1</t></is></c><c r="B2" t="s"><v>7</v></c><c r="C2" t="s"><v>6</v></c><c r="D2" s="1"><v>45000</v></c><c r="E2" t="s"><v>8</v></c><c r="F2" t="s"><v>11</v></c></row>'+
   '<row r="3"><c r="A3" t="str"><f>"E"&amp;"2"</f><v>E2</v></c><c r="B3" t="b"><v>1</v></c><c r="C3"><v>1.2345678901234567E+21</v></c><c r="D3" s="2"><v>45000.75</v></c><c r="E3" t="e"><v>#N/A</v></c><c r="F3" t="e"><v>#NULL!</v></c></row>'+
   '<row r="4"><c r="B4" t="s"><v>10</v></c></row>'+
   '<row r="5"></row>'+
   '<row r="7"><c r="A7" t="s"><v>12</v></c><c r="C7"><f>1+1</f><v>2</v></c><c r="D7" t="d"><v>2026-11-14T00:00:00Z</v></c><c r="E7" s="3"><v>12</v></c><c r="F7"><v>1E-7</v></c></row>'+
   '<row r="8"><c r="A8" t="inlineStr"><is><t>E4</t></is></c><c r="C8" s="4"><v>-0.5</v></c><c r="E8" t="s"><v>9</v></c></row>';
  for(const date1904 of [false,true])for(const dimension of [undefined,'A1:F8','A1:Z9']){
   const outcome=await same('types.xlsx',await workbook([{name:'Bank',rows,dimension}],sst,{date1904}),[1048576]);
   expect(outcome.ok,`${date1904} ${dimension}`).toBe(true);
  }
 });
 it('decodes generated templates, a Personnel frame, a leading byte-order mark and allowed reference sheets',async()=>{
  await same('template.xlsx',Buffer.from(await buildXlsx(['employee_code','bank_account_no'],[['E1','00012'],['E2','0099']],{textColumns:[1],extraSheets:[{name:'Reference',rows:[['x']]},{name:'Instructions',rows:[['y']]}]})));
  await same('frame.xlsx',Buffer.from(await buildXlsx(['AI-HR Personnel CSV','1','employee'],[['employee_code','bank_account_no'],['E1','~p1~=1'],['E2','~p1~~p1~x']])));
  await same('bom.xlsx',Buffer.from(await buildXlsx(['\uFEFFemployee_code','tax_number'],[['E1','T1']])));
  await same('bom-quoted.xlsx',Buffer.from(await buildXlsx(['\uFEFFemployee_code,x','tax_number'],[['E1','T1']])));
 });
 it('refuses the same workbooks with the same error',async()=>{
  const XLSX=await import('xlsx');
  const book=(sheets:[string,unknown[][]][])=>{const wb=XLSX.utils.book_new();for(const [name,rows] of sheets)XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),name);return Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}));};
  const cases:[string,Buffer][]=[
   ['unexpected.xlsx',book([['Bank',[['employee_code'],['E1']]],['Other',[['data']]]])],
   ['unexpected-blank.xlsx',book([['Bank',[['employee_code'],['E1']]],['Other',[['  '],[]]]])],
   ['empty-first.xlsx',book([['Bank',[[' '],['']]],['Reference',[['x']]]])],
   ['many.xlsx',book(Array.from({length:33},(_,i)=>[`S${i}`,[['employee_code'],['E1']]] as [string,unknown[][]]))],
   ['unknown-heading.xlsx',book([['Bank',[['employee_code','nope'],['E1','x']]]])],
   ['beyond.xlsx',book([['Bank',[['employee_code'],['E1','extra']]]])],
   ['header-only.xlsx',book([['Bank',[['employee_code','tax_number']]]])],
   ['long-cell.xlsx',book([['Bank',[['employee_code','tax_number'],['E1','x'.repeat(1048577)]]]])],
   ['long-cell-boundary.xlsx',book([['Bank',[['employee_code','tax_number'],['E1','x'.repeat(1048576)]]]])],
   ['long-cell-and-bad-heading.xlsx',book([['Bank',[['employee_code','nope'],['E1','x'.repeat(1048577)]]]])],
   ['not-a-workbook.xlsx',Buffer.from('employee_code,tax_number\nE1,T1\n')],
   ['garbage.xlsx',Buffer.from([0x50,0x4b,0x03,0x04,1,2,3,4,5,6,7,8])],
  ];
  for(const [name,bytes] of cases)await same(name,bytes,[1048576]);
  const duplicateNames=await workbook([{name:'Bank',rows:header},{name:'bank ',rows:''}],headerSst);
  expect(await same('duplicate-names.xlsx',duplicateNames,[1048576])).toMatchObject({ok:false});
  const ws=XLSX.utils.aoa_to_sheet([['employee_code'],['E1']]);ws['!ref']=`A1:A${BANK_IMPORT_MAX_ROWS+3}`;
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Bank');
  expect(await same('range.xlsx',Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'})),[1048576])).toMatchObject({ok:false,code:'FILE_TOO_LARGE'});
 },120_000);
 it('refuses a workbook whose CSV projection exceeds the byte ceiling, as the whole-file text did',async()=>{
  // 140 cells sharing one 1,000,000-character string: a small file whose projected CSV text is about 140 MB.
  const sst=[t('employee_code'),t('y'.repeat(1_000_000))];
  const rows='<row r="1"><c r="A1" t="s"><v>0</v></c></row>'+Array.from({length:140},(_,i)=>`<row r="${i+2}"><c r="A${i+2}" t="s"><v>1</v></c></row>`).join('');
  expect(await same('projection.xlsx',await workbook([{name:'Bank',rows}],sst),[1048576])).toMatchObject({ok:false,code:'FILE_TOO_LARGE'});
 },120_000);
 it('keeps duplicate checks and ordinals over more than one sheet window and staged batch',async()=>{
  const XLSX=await import('xlsx');
  const data=[['employee_code','card_id'],...Array.from({length:12_005},(_,i)=>i%997===0?[]:[`E${i%9000}`,`C${i%11000}`])];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(data),'Bank');
  const outcome=await same('windows.xlsx',Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'})),[1048576]);
  expect(outcome.ok&&outcome.errors.length).toBeGreaterThan(0);
 },60_000);
});
