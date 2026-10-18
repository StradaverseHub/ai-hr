import {describe,expect,it} from 'vitest';
import JSZip from 'jszip';
import {checkPayItemArchive,payItemErrorWorkbook,readPayItemWorkbook} from '../lib/pay-component-workbook';

async function archive(payload:Buffer,compression:'STORE'|'DEFLATE'='DEFLATE',streamFiles=false){
 const zip=new JSZip();zip.file('payload.xml',payload);return zip.generateAsync({type:'nodebuffer',compression,streamFiles});
}
function directory(bytes:Buffer){
 const end=bytes.length-22;
 expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
 const central=bytes.readUInt32LE(end+16),local=bytes.readUInt32LE(central+42);
 expect(bytes.readUInt32LE(central)).toBe(0x02014b50);expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
 return {central,local,end};
}

describe('Pay Items ZIP admission before workbook parsers',()=>{
 it.each(['STORE','DEFLATE'] as const)('admits consistent actual %s bytes, including ordinary streamed descriptors',async compression=>{
  for(const stream of [false,true]){const bytes=await archive(Buffer.from('ordinary bounded data'),compression,stream);expect(()=>checkPayItemArchive(bytes)).not.toThrow();}
 });
 it('rejects a forged small central size with a conflicting large local size',async()=>{
  const bytes=await archive(Buffer.alloc(65536,65)),{central}=directory(bytes);bytes.writeUInt32LE(1,central+24);
  expect(()=>checkPayItemArchive(bytes)).toThrow('invalidWorkbook');
 });
 it('bounds actual expansion even when BOTH size headers lie identically',async()=>{
  const bytes=await archive(Buffer.alloc(40*1024*1024+1,65)),{central,local}=directory(bytes);
  expect(bytes.length).toBeLessThan(5*1024*1024);bytes.writeUInt32LE(1,central+24);bytes.writeUInt32LE(1,local+22);
  expect(()=>checkPayItemArchive(bytes)).toThrow('invalidWorkbook');
  expect(()=>readPayItemWorkbook(bytes)).toThrow('invalidWorkbook');
  await expect(payItemErrorWorkbook(bytes,[],code=>code)).rejects.toThrow('invalidWorkbook');
 });
 it('rejects claimed expansion above the cumulative limit before inflating',async()=>{
  const bytes=await archive(Buffer.from('small')),{central,local}=directory(bytes);
  bytes.writeUInt32LE(40*1024*1024+1,central+24);bytes.writeUInt32LE(40*1024*1024+1,local+22);
  expect(()=>checkPayItemArchive(bytes)).toThrow('invalidWorkbook');
 });
 it('rejects matching but incorrect stored sizes, corrupt content and central/local method disagreement',async()=>{
  const source=await archive(Buffer.from('literal payload'),'STORE'),{central,local}=directory(source);
  const size=Buffer.from(source);size.writeUInt32LE(1,central+24);size.writeUInt32LE(1,local+22);expect(()=>checkPayItemArchive(size)).toThrow('invalidWorkbook');
  const crc=Buffer.from(source);crc[local+30+crc.readUInt16LE(local+26)+crc.readUInt16LE(local+28)]^=1;expect(()=>checkPayItemArchive(crc)).toThrow('invalidWorkbook');
  const method=Buffer.from(source);method.writeUInt16LE(8,local+8);expect(()=>checkPayItemArchive(method)).toThrow('invalidWorkbook');
 });
 it('refuses local-only paths, ZIP64 overrides and malformed streamed descriptors',async()=>{
  const original=await archive(Buffer.from('safe')),{local}=directory(original);
  const path=Buffer.from(original);path[local+30]^=1;expect(()=>checkPayItemArchive(path)).toThrow('invalidWorkbook');
  const zip=new JSZip();zip.file('payload.xml',Buffer.from('safe'),{date:new Date('2026-01-01T00:00:00Z')});
  const streamed=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',streamFiles:true}),info=directory(streamed);
  // Replace the descriptor's actual size while keeping both central-directory sizes intact.
  streamed.writeUInt32LE(0,info.central-4);expect(()=>checkPayItemArchive(streamed)).toThrow('invalidWorkbook');
  const zip64=Buffer.from(original);zip64.writeUInt32LE(0xffffffff,directory(zip64).central+24);expect(()=>checkPayItemArchive(zip64)).toThrow('invalidWorkbook');
  // A local ZIP64 extra can override ordinary header sizes in SheetJS even without sentinel sizes.
  const {central,end}=directory(original),at=local+30+original.readUInt16LE(local+26),extra=Buffer.alloc(12);
  extra.writeUInt16LE(0x0001,0);extra.writeUInt16LE(8,2);extra.writeUInt32LE(41*1024*1024,4);
  const override=Buffer.concat([original.subarray(0,at),extra,original.subarray(at)]);
  override.writeUInt16LE(12,local+28);override.writeUInt32LE(central+12,end+12+16);
  expect(()=>checkPayItemArchive(override)).toThrow('invalidWorkbook');
 });
});
