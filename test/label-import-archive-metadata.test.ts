import {beforeEach,describe,expect,it,vi} from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {readSystemLabelWorkbook} from '../lib/system-label-workbook';
const parser=vi.hoisted(()=>({calls:0,blocked:false}));
vi.mock('xlsx',async importOriginal=>{
 const actual=await importOriginal<typeof import('xlsx')>();
 return {...actual,read:(data:Parameters<typeof actual.read>[0],options?:Parameters<typeof actual.read>[1])=>{
  parser.calls++;if(parser.blocked)throw new Error('Unexpected SheetJS admission');return actual.read(data,options);
 }};
});
const make=()=>{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Code','Label','Description','Sort Order'],['NEW','Fictional','','0']]),'division');return XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}) as Buffer;};
const directory=(bytes:Buffer)=>{for(let at=bytes.length-22;at>=0;at--)if(bytes.readUInt32LE(at)===0x06054b50)return{end:at,start:bytes.readUInt32LE(at+16)};throw new Error('Missing fixture directory');};
function addExtra(bytes:Buffer,target:'local'|'central',tag:number){
 const {end,start}=directory(bytes),local=bytes.readUInt32LE(start+42),centralName=bytes.readUInt16LE(start+28),localName=bytes.readUInt16LE(local+26);
 const at=target==='local'?local+30+localName:start+46+centralName;
 const extra=Buffer.alloc(20);extra.writeUInt16LE(tag,0);extra.writeUInt16LE(16,2);extra.writeBigUInt64LE(BigInt(0x40000000),4);extra.writeBigUInt64LE(BigInt(1),12);
 const changed=Buffer.concat([bytes.subarray(0,at),extra,bytes.subarray(at)]),newStart=start+(target==='local'?extra.length:0),newEnd=end+extra.length;
 if(target==='local'){
  changed.writeUInt16LE(bytes.readUInt16LE(local+28)+extra.length,local+28);
  for(let cursor=newStart;cursor<newEnd;){const oldLocal=changed.readUInt32LE(cursor+42);if(oldLocal>=at)changed.writeUInt32LE(oldLocal+extra.length,cursor+42);cursor+=46+changed.readUInt16LE(cursor+28)+changed.readUInt16LE(cursor+30)+changed.readUInt16LE(cursor+32);}
  changed.writeUInt32LE(newStart,newEnd+16);
 }else{changed.writeUInt16LE(bytes.readUInt16LE(start+30)+extra.length,start+30);changed.writeUInt32LE(bytes.readUInt32LE(end+12)+extra.length,newEnd+12);}
 return changed;
}
beforeEach(()=>{parser.calls=0;parser.blocked=false;});
describe('Labels ZIP metadata is admitted before the workbook parser',()=>{
 it.each(['STORE','DEFLATE'] as const)('retains genuine %s workbooks and supported DEFLATE streaming headers',async compression=>{
  const zip=await JSZip.loadAsync(make());
  for(const streamFiles of compression==='DEFLATE'?[false,true]:[false]){const bytes=await zip.generateAsync({type:'nodebuffer',compression,streamFiles});expect(readSystemLabelWorkbook(bytes)[0].values.Code).toBe('NEW');}
  expect(parser.calls).toBe(compression==='DEFLATE'?2:1);
 });
 it.each(['localCompressed','localSize'] as const)('rejects forged %s before SheetJS can consume it',field=>{
  const bytes=Buffer.from(make()),{start}=directory(bytes),local=bytes.readUInt32LE(start+42);bytes.writeUInt32LE(0x40000000,local+(field==='localCompressed'?18:22));parser.blocked=true;
  expect(()=>readSystemLabelWorkbook(bytes)).toThrow('Invalid Excel archive.');expect(parser.calls).toBe(0);
 });
 it.each(['local','central'] as const)('rejects %s ZIP64 overrides before parser allocation',target=>{
  const bytes=addExtra(make(),target,0x0001);parser.blocked=true;expect(()=>readSystemLabelWorkbook(bytes)).toThrow('Invalid Excel archive.');expect(parser.calls).toBe(0);
 });
 it('rejects alternate Unicode path metadata rather than checking a different entry name',()=>{
  parser.blocked=true;expect(()=>readSystemLabelWorkbook(addExtra(make(),'local',0x7075))).toThrow('Invalid Excel archive.');expect(parser.calls).toBe(0);
 });
 it('keeps actual inflation bounded when both local and central declarations lie small',async()=>{
  const zip=new JSZip();zip.file('xl/workbook.xml',' '.repeat(8_000_001));const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),{start}=directory(bytes),local=bytes.readUInt32LE(start+42);bytes.writeUInt32LE(1,start+24);bytes.writeUInt32LE(1,local+22);parser.blocked=true;
  expect(()=>readSystemLabelWorkbook(bytes)).toThrow();expect(parser.calls).toBe(0);
 });
});
