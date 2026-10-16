/** The renderer opens its fixed owned path. This reader accepts only that already-open descriptor. */
import {createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {masterArtifactFingerprint,type MasterArtifactFingerprint} from '../../lib/employee-master-artifact-model';
import {XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE,XLSX_EMAIL_ATTACHMENT_MAX_BYTES} from '../../lib/email-attachment';
type ArtifactStat=Pick<BigIntStats,'dev'|'ino'|'uid'|'mode'|'size'|'nlink'|'mtimeNs'|'ctimeNs'|'isFile'>;
export type ReportArtifactHandle={
  stat(options:{bigint:true}):Promise<ArtifactStat>;
  read(buffer:Buffer,offset:number,length:number,position:number):Promise<{bytesRead:number}>;
};
export class ReportArtifactError extends Error {
  readonly tooLarge:boolean;
  constructor(readonly reason:'generationFailed'|'attachmentTooLarge') {super('Private report artifact unavailable.');this.tooLarge=reason==='attachmentTooLarge';}
}
function refused(reason:'generationFailed'|'attachmentTooLarge'='generationFailed'):never {throw new ReportArtifactError(reason);}
export async function fingerprintOwnedReportArtifact(handle:ReportArtifactHandle,rendererUid:number):Promise<MasterArtifactFingerprint> {
  if(!Number.isSafeInteger(rendererUid)||rendererUid<0)refused();
  const before=await handle.stat({bigint:true}),max=BigInt(XLSX_EMAIL_ATTACHMENT_MAX_BYTES);
  if(before.size>max)refused('attachmentTooLarge');
  if(!before.isFile()||before.uid!==BigInt(rendererUid)||(before.mode&BigInt(0o027))!==BigInt('0')||before.nlink!==BigInt('1')||before.size<BigInt('1'))refused();
  const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let byteLength=0;
  for(;;){
    // Read at most one extra byte: growth beyond the same shared limit is always refused.
    const length=Math.min(buffer.byteLength,XLSX_EMAIL_ATTACHMENT_MAX_BYTES-byteLength+1);
    const {bytesRead}=await handle.read(buffer,0,length,byteLength);
    if(!Number.isSafeInteger(bytesRead)||bytesRead<0||bytesRead>length)refused();
    if(!bytesRead)break;
    byteLength+=bytesRead;if(byteLength>XLSX_EMAIL_ATTACHMENT_MAX_BYTES)refused('attachmentTooLarge');
    hash.update(buffer.subarray(0,bytesRead));
  }
  const after=await handle.stat({bigint:true});
  if(!after.isFile()||BigInt(byteLength)!==before.size)refused();
  for(const key of ['dev','ino','uid','mode','size','nlink','mtimeNs','ctimeNs'] as const)if(after[key]!==before[key])refused();
  return masterArtifactFingerprint.parse({sha256:hash.digest('hex'),byteLength,contentType:XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE});
}
