import {describe,expect,it} from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {LABEL_WORKBOOK_MAX_BYTES,readSystemLabelWorkbook} from '../lib/system-label-workbook';
const headers=['Code','Label','Description','Sort Order'];
const make=(type:'biff8'|'xlsx',change?:(wb:XLSX.WorkBook)=>void)=>{
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([headers,['00007','Fictional label','Description','1']]),'division');change?.(wb);
 return XLSX.write(wb,{type:'buffer',bookType:type,compression:false}) as Buffer;
};
const mutateLegacy=(bytes:Buffer,change:(stream:Buffer)=>void)=>{const cfb=XLSX.CFB.read(bytes,{type:'buffer'}),book=XLSX.CFB.find(cfb,'/Workbook');expect(book).toBeDefined();const stream=Buffer.from(book.content);change(stream);XLSX.CFB.utils.cfb_add(cfb,'/Workbook',stream);return XLSX.CFB.write(cfb,{type:'buffer'}) as Buffer;};
describe('bounded real XLS and XLSX Labels admission',()=>{
 it.each(['biff8','xlsx'] as const)('reads actual %s data with stable text identifiers and the same row contract',type=>{
  const bytes=make(type);expect(bytes.subarray(0,type==='biff8'?8:4).toString('hex')).toBe(type==='biff8'?'d0cf11e0a1b11ae1':'504b0304');
  expect(readSystemLabelWorkbook(bytes)).toEqual([{sheet:'division',row:2,values:{Code:'00007',Label:'Fictional label',Description:'Description','Sort Order':'1'}}]);
 });
 it('admits a genuine uncompressed XLSX larger than the former 750 KB cap without raising row/cell limits',()=>{
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([headers,...Array.from({length:500},(_,i)=>['C'+i,'L'.repeat(1000),'D'.repeat(1000),'0'])]),'division');
  const bytes=XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:false}) as Buffer;
  expect(bytes.length).toBeGreaterThan(750_000);expect(bytes.length).toBeLessThanOrEqual(LABEL_WORKBOOK_MAX_BYTES);expect(readSystemLabelWorkbook(bytes)).toHaveLength(500);
 });
 it.each(['biff8','xlsx'] as const)('rejects formulas and sheet protection in %s',type=>{
  expect(()=>readSystemLabelWorkbook(make(type,wb=>{wb.Sheets.division.B2={t:'n',v:1,f:'1',bf:Buffer.from([3,0,0x1e,1,0])};}))).toThrow(/Formula/);
  const protectedBytes=type==='xlsx'?make(type,wb=>{wb.Sheets.division['!protect']={password:'fictional'};}):mutateLegacy(make(type),stream=>{
   // The installed writer omits BIFF protection. Convert a two-byte CalcMode(1) record to Protect(1).
   let found=false;for(let offset=0;offset+4<=stream.length;){const record=stream.readUInt16LE(offset),size=stream.readUInt16LE(offset+2);if(record===0x000d&&size===2){stream.writeUInt16LE(0x0012,offset);found=true;break;}offset+=4+size;}expect(found).toBe(true);
  });
  expect(()=>readSystemLabelWorkbook(protectedBytes)).toThrow(/[Pp]rotect/);
 });
 it('rejects cyclic CFB FAT chains before the legacy parser follows them',()=>{
  const bytes=Buffer.from(make('biff8')),sectorSize=2**bytes.readUInt16LE(30),directory=bytes.readUInt32LE(48),fat=bytes.readUInt32LE(76+Math.floor(directory/(sectorSize/4))*4);
  bytes.writeInt32LE(directory,(fat+1)*sectorSize+(directory%(sectorSize/4))*4);
  expect(()=>readSystemLabelWorkbook(bytes)).toThrow(/legacy XLS/);
 });
 it('rejects a real legacy FilePass record even without a supplied password',()=>{
  const bytes=Buffer.from(make('biff8')),cfb=XLSX.CFB.read(bytes,{type:'buffer'}),book=XLSX.CFB.find(cfb,'/Workbook');
  // Change a harmless global record into FilePass; CFB stays structurally valid.
  const stream=Buffer.from(book.content);const firstLength=stream.readUInt16LE(2);stream.writeUInt16LE(0x002f,4+firstLength);
  XLSX.CFB.utils.cfb_add(cfb,'/Workbook',stream);const encrypted=XLSX.CFB.write(cfb,{type:'buffer'}) as Buffer;
  expect(()=>readSystemLabelWorkbook(encrypted)).toThrow(/encrypted/);
 });
 it('rejects wrong containers, oversize bytes, no recognised sheets and excessive rows',async()=>{
  expect(()=>readSystemLabelWorkbook(Buffer.from('<html>Excel</html>'))).toThrow();
  expect(()=>readSystemLabelWorkbook(Buffer.alloc(LABEL_WORKBOOK_MAX_BYTES+1))).toThrow(/5 MB/);
  const zip=new JSZip();zip.file('unrelated.txt','Not Excel');const bytes=await zip.generateAsync({type:'nodebuffer'});expect(()=>readSystemLabelWorkbook(bytes)).toThrow(/supported XLSX/);
  for(const type of ['biff8','xlsx'] as const){
   expect(()=>readSystemLabelWorkbook(make(type,wb=>{wb.SheetNames=['Reference'];wb.Sheets={Reference:wb.Sheets.division};}))).toThrow(/no recognised/);
   expect(()=>readSystemLabelWorkbook(make(type,wb=>{wb.Sheets.division=XLSX.utils.aoa_to_sheet([headers,...Array.from({length:501},(_,i)=>[String(i),'X','',''])]);}))).toThrow(/limit/);
  }
 });
 it('rejects encrypted ZIP flags and bounded archive expansion before SheetJS reads worksheets',async()=>{
  const bytes=Buffer.from(make('xlsx'));
  for(let offset=0;offset+46<bytes.length;offset++)if(bytes.readUInt32LE(offset)===0x02014b50){const local=bytes.readUInt32LE(offset+42);bytes.writeUInt16LE(bytes.readUInt16LE(offset+8)|1,offset+8);bytes.writeUInt16LE(bytes.readUInt16LE(local+6)|1,local+6);break;}
  expect(()=>readSystemLabelWorkbook(bytes)).toThrow(/Encrypted/);
  const zip=new JSZip();zip.file('xl/workbook.xml',' '.repeat(8_000_001));const expanded=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  expect(expanded.length).toBeLessThan(LABEL_WORKBOOK_MAX_BYTES);expect(()=>readSystemLabelWorkbook(expanded)).toThrow(/expands/);
 });
 it.each(['biff8','xlsx'] as const)('retains the cell-length and sheet-count caps for %s',type=>{
  // BIFF8's standard literal label writer truncates at 255 characters; XLSX can carry the 1001-character refusal case.
  if(type==='xlsx')expect(()=>readSystemLabelWorkbook(make(type,wb=>{wb.Sheets.division.B2.v='X'.repeat(1001);}))).toThrow(/too long/);
  expect(()=>readSystemLabelWorkbook(make(type,wb=>{for(let i=0;i<17;i++)XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Code'],['X']]),'extra'+i);}))).toThrow(/Too many worksheets/);
 });
 it('reports unsupported populated sheets alongside supported data instead of silently losing rows',()=>{
  const bytes=make('xlsx',wb=>XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Code'],['UNSUPPORTED']]),'unexpected'));
  const rows=readSystemLabelWorkbook(bytes);expect(rows.map(row=>[row.sheet,row.row,row.values.Code])).toEqual([['division',2,'00007'],['unexpected',2,'UNSUPPORTED']]);
 });
});
