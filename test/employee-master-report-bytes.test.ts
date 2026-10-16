import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readPreparedReportBytes} from '../deploy/identity-email/report-bytes';
import {XLSX_EMAIL_ATTACHMENT_MAX_BYTES} from '../lib/email-attachment';
describe('bounded sender artifact read',()=>{
 it('reads exact owned bytes from a real descriptor and refuses drift during read',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'aihr-report-bytes-')),path=join(dir,'fixed.xlsx'),handle=await open(path,'wx+',0o640);
  try{await handle.writeFile(Buffer.from('fictional workbook'));expect(await readPreparedReportBytes(handle,process.getuid!())).toEqual(Buffer.from('fictional workbook'));
   let changed=false;const read=async(buffer:Buffer,offset:number,length:number,position:number)=>{const result=await handle.read(buffer,offset,length,position);if(!changed){changed=true;await handle.truncate(3);}return result;};
   await expect(readPreparedReportBytes({stat:()=>handle.stat(),read},process.getuid!())).rejects.toThrow('refused');
  }finally{await handle.close();await rm(dir,{recursive:true,force:true});}
 });
 it('rejects oversize before any allocation/read and refuses wrong owner/links/mode',async()=>{
  const good={isFile:()=>true,uid:123,mode:0o100640,nlink:1,size:3,dev:1,ino:2,mtimeMs:0,ctimeMs:0};
  for(const change of [{size:XLSX_EMAIL_ATTACHMENT_MAX_BYTES+1},{uid:124},{nlink:2},{mode:0o100666}]){const read=vi.fn();await expect(readPreparedReportBytes({stat:vi.fn(async()=>({...good,...change})),read} as never,123)).rejects.toThrow('refused');expect(read).not.toHaveBeenCalled();}
 });
 it('bounds growth to original size plus one even if the source keeps producing data',async()=>{
  const good={isFile:()=>true,uid:123,mode:0o100640,nlink:1,size:3,dev:1,ino:2,mtimeMs:0,ctimeMs:0};let requested=0;
  const read=vi.fn(async(buffer:Buffer,offset:number,length:number)=>{requested+=length;buffer.fill(1,offset,offset+length);return {bytesRead:length,buffer};});
  await expect(readPreparedReportBytes({stat:vi.fn(async()=>good),read} as never,123)).rejects.toThrow('refused');expect(requested).toBe(4);expect(read).toHaveBeenCalledTimes(1);
 });
});
