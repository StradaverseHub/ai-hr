/** Bounded sender read from an already opened fixed O_NOFOLLOW artifact; no caller path. */
import type {Stats} from 'node:fs';
import {MASTER_EMAIL_ATTACHMENT_MAX_BYTES} from '../../lib/employee-master-delivery-model';
import {MasterDeliveryPreparationError} from './reports';
export type PreparedReportHandle={stat():Promise<Stats>;read(buffer:Buffer,offset:number,length:number,position:number):Promise<{bytesRead:number}>};
export async function readPreparedReportBytes(handle:PreparedReportHandle,rendererUid:number):Promise<Buffer>{
 const before=await handle.stat();
 if(!before.isFile()||before.uid!==rendererUid||(before.mode&0o027)!==0||before.nlink!==1||before.size<1||before.size>MASTER_EMAIL_ATTACHMENT_MAX_BYTES)throw new MasterDeliveryPreparationError(before.size>MASTER_EMAIL_ATTACHMENT_MAX_BYTES?'attachmentTooLarge':'generationFailed');
 // Even a compromised/misconfigured writer cannot make readFile allocate an unbounded artifact.
 const buffer=Buffer.allocUnsafe(before.size+1);let size=0;
 while(size<buffer.byteLength){const {bytesRead}=await handle.read(buffer,size,buffer.byteLength-size,size);if(bytesRead===0)break;size+=bytesRead;}
 if(size>before.size)throw new MasterDeliveryPreparationError(size>MASTER_EMAIL_ATTACHMENT_MAX_BYTES?'attachmentTooLarge':'generationFailed');
 const after=await handle.stat();
 if(size!==before.size||['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs'].some(key=>before[key as keyof typeof before]!==after[key as keyof typeof after]))throw new MasterDeliveryPreparationError('generationFailed');
 return buffer.subarray(0,size);
}
